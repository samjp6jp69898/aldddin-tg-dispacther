import { afterAll, describe, expect, test } from 'bun:test'
import {
  evaluateMonitorDbAlerts,
  normalizeReadSource,
  probeReadSource,
  HEARTBEAT_STALE_MS,
  NEW_WORKER_GRACE_MS,
  SPOOL_DEPTH_THRESHOLD,
  SPOOL_OLDEST_THRESHOLD_MS,
  WORKER_REPORT_STALE_MS,
  type MonitorAlert,
  type MonitorAlertDeps,
  type ReadSourceStatus,
} from './alerts.ts'

// §6.8(3) a–f ＋ 追加的 (g) 讀取面降級，共七條件的判定。全部用注入的假讀取器，
// 不碰真 DB／真 ssh／真名冊檔；只有 probeReadSource 那一組打一個本機假 server。

const NOW = Date.parse('2026-09-02T12:00:00.000Z')

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString()
}

/** 六條件全部「正常」的基準 deps——每個案例只覆寫它關心的那一支。 */
function healthyDeps(over: MonitorAlertDeps = {}): MonitorAlertDeps {
  return {
    now: () => NOW,
    readHeartbeats: async () => [
      { host: 'head', writer: 'server', ts: iso(1000) },
      { host: 'head', writer: 'tg-monitor', ts: iso(1000) },
      { host: 'head', writer: 'log-intake', ts: iso(1000) },
      { host: 'w1', writer: 'worker-agent', ts: iso(1000) },
    ],
    readSpool: () => ({ depth: 0, oldestTs: null }),
    listWorkers: () => [{ name: 'w1', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false }],
    probeTunnel: async () => true,
    readWorkerStatuses: () => [{ worker: 'w1', spoolDepth: 3, oldestAgeS: 5, dbWritable: true, receivedAt: NOW - 1000 }],
    readR1Violations: () => 0,
    readReadSource: async () => ({ requested: 'mysql', effective: 'mysql', degraded: false, requestedValid: true }),
    ...over,
  }
}

function byKey(alerts: MonitorAlert[], key: string): MonitorAlert | undefined {
  return alerts.find(a => a.key === key)
}

describe('全部正常', () => {
  test('六條件都評估到、且全部 tripped=false', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps())
    expect(alerts.every(a => !a.tripped)).toBe(true)
    for (const key of [
      'monitor-db:head-heartbeat:server',
      'monitor-db:head-heartbeat:tg-monitor',
      'monitor-db:head-heartbeat:log-intake',
      'monitor-db:head-spool',
      'monitor-db:tunnel:w1',
      'monitor-db:worker-heartbeat:w1',
      'monitor-db:worker-spool:w1',
      'monitor-db:r1-violation',
      'monitor-db:read-source-degraded',
    ]) {
      expect(byKey(alerts, key)).toBeDefined()
    }
  })
})

describe('(a) head 三個行程的心跳', () => {
  test('(head,server) 落後超過 5 分鐘 → tripped；另兩個新鮮的不受影響', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        readHeartbeats: async () => [
          { host: 'head', writer: 'server', ts: iso(HEARTBEAT_STALE_MS + 1000) },
          { host: 'head', writer: 'tg-monitor', ts: iso(1000) },
          { host: 'head', writer: 'log-intake', ts: iso(1000) },
        ],
      }),
    )
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')!.tripped).toBe(true)
    expect(byKey(alerts, 'monitor-db:head-heartbeat:tg-monitor')!.tripped).toBe(false)
    expect(byKey(alerts, 'monitor-db:head-heartbeat:log-intake')!.tripped).toBe(false)
  })

  test('剛好在門檻上（= 5 分鐘）不算故障，超過才算', async () => {
    const at = await evaluateMonitorDbAlerts(healthyDeps({ readHeartbeats: async () => [{ host: 'head', writer: 'server', ts: iso(HEARTBEAT_STALE_MS) }] }))
    expect(byKey(at, 'monitor-db:head-heartbeat:server')!.tripped).toBe(false)
  })

  test('該列完全不存在 → tripped（分得出「行程死了」與「從來沒寫過」都要告警）', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readHeartbeats: async () => [] }))
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')!.tripped).toBe(true)
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')!.detail).toContain('沒有可用的列')
  })

  test('DB 查詢失敗（＝不可寫）→ (a) 三條一起 tripped，(d) 整組省略而不是誤判成正常', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        readHeartbeats: async () => {
          throw new Error('tunnel 半開')
        },
      }),
    )
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')!.tripped).toBe(true)
    expect(byKey(alerts, 'monitor-db:head-heartbeat:tg-monitor')!.tripped).toBe(true)
    expect(byKey(alerts, 'monitor-db:head-heartbeat:log-intake')!.tripped).toBe(true)
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')).toBeUndefined()
    // 其他條件不受影響，仍然被評估
    expect(byKey(alerts, 'monitor-db:head-spool')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:tunnel:w1')).toBeDefined()
  })

  test('ts 是 Date 物件（mysql2 未開 dateStrings）一樣判得出來', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readHeartbeats: async () => [{ host: 'head', writer: 'server', ts: new Date(NOW - HEARTBEAT_STALE_MS - 1000) }] }),
    )
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')!.tripped).toBe(true)
  })
})

describe('(b) head spool 積壓', () => {
  test('深度超過 200 → tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readSpool: () => ({ depth: SPOOL_DEPTH_THRESHOLD + 1, oldestTs: iso(1000) }) }))
    expect(byKey(alerts, 'monitor-db:head-spool')!.tripped).toBe(true)
  })

  test('深度沒超過但最舊條目超過 15 分鐘 → 一樣 tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readSpool: () => ({ depth: 1, oldestTs: iso(SPOOL_OLDEST_THRESHOLD_MS + 1000) }) }))
    expect(byKey(alerts, 'monitor-db:head-spool')!.tripped).toBe(true)
  })

  test('兩者都在門檻內 → 不告警', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readSpool: () => ({ depth: SPOOL_DEPTH_THRESHOLD, oldestTs: iso(SPOOL_OLDEST_THRESHOLD_MS) }) }))
    expect(byKey(alerts, 'monitor-db:head-spool')!.tripped).toBe(false)
  })

  test('讀取器拋錯 → 只省略這一條，其他條件照跑', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        readSpool: () => {
          throw new Error('磁碟壞了')
        },
      }),
    )
    expect(byKey(alerts, 'monitor-db:head-spool')).toBeUndefined()
    expect(byKey(alerts, 'monitor-db:r1-violation')).toBeDefined()
  })
})

describe('(c) tunnel 探測', () => {
  test('nc 不通 → tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ probeTunnel: async () => false }))
    expect(byKey(alerts, 'monitor-db:tunnel:w1')!.tripped).toBe(true)
  })

  test('探測拋錯 → 省略該台（不是誤判成通）', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        probeTunnel: async () => {
          throw new Error('spawn 失敗')
        },
      }),
    )
    expect(byKey(alerts, 'monitor-db:tunnel:w1')).toBeUndefined()
  })

  test('disabled 的 worker 不列入（名冊讀取器本身就已過濾）；多台各自一條', async () => {
    const probed: string[] = []
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => [
          { name: 'w1', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false },
          { name: 'w2', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false },
        ],
        probeTunnel: async w => {
          probed.push(w)
          return w === 'w1'
        },
      }),
    )
    expect(probed.sort()).toEqual(['w1', 'w2'])
    expect(byKey(alerts, 'monitor-db:tunnel:w1')!.tripped).toBe(false)
    expect(byKey(alerts, 'monitor-db:tunnel:w2')!.tripped).toBe(true)
  })

  test('名冊讀不到 → (c)(d)(e) 整組省略，(a)(b)(f) 照常', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => {
          throw new Error('名冊檔壞了')
        },
      }),
    )
    expect(alerts.map(a => a.key).sort()).toEqual([
      'monitor-db:head-heartbeat:log-intake',
      'monitor-db:head-heartbeat:server',
      'monitor-db:head-heartbeat:tg-monitor',
      'monitor-db:head-spool',
      'monitor-db:r1-violation',
      'monitor-db:read-source-degraded',
    ])
  })
})

describe('(d) worker 心跳', () => {
  test('該台的 (worker,worker-agent) 列不存在 → tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readHeartbeats: async () => [{ host: 'head', writer: 'server', ts: iso(1000) }] }))
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')!.tripped).toBe(true)
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')!.detail).toContain('沒有列')
  })

  test('落後超過 5 分鐘 → tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        readHeartbeats: async () => [
          { host: 'head', writer: 'server', ts: iso(1000) },
          { host: 'w1', writer: 'worker-agent', ts: iso(HEARTBEAT_STALE_MS + 1000) },
        ],
      }),
    )
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')!.tripped).toBe(true)
  })

  test('新 worker 30 分鐘寬限期內完全不評估 (d)(e)', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => [{ name: 'fresh', registeredAt: iso(60_000), disabled: false }],
        readHeartbeats: async () => [{ host: 'head', writer: 'server', ts: iso(1000) }],
        readWorkerStatuses: () => [],
      }),
    )
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:fresh')).toBeUndefined()
    expect(byKey(alerts, 'monitor-db:worker-spool:fresh')).toBeUndefined()
    // tunnel（c）沒有寬限期——它探的是「現在通不通」，與新舊無關。
    expect(byKey(alerts, 'monitor-db:tunnel:fresh')).toBeDefined()
  })

  test('registeredAt 解析不出來 → 不給寬限（寧可誤報一次也不要永久豁免）', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => [{ name: 'w1', registeredAt: 'not-a-date', disabled: false }],
        readHeartbeats: async () => [{ host: 'head', writer: 'server', ts: iso(1000) }],
      }),
    )
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')!.tripped).toBe(true)
  })
})

describe('(e) worker 主動回報的 spool', () => {
  test('回報深度超過 200 → ERROR 級 tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readWorkerStatuses: () => [{ worker: 'w1', spoolDepth: SPOOL_DEPTH_THRESHOLD + 1, oldestAgeS: 60, dbWritable: true, receivedAt: NOW - 1000 }] }),
    )
    const a = byKey(alerts, 'monitor-db:worker-spool:w1')!
    expect(a.tripped).toBe(true)
    expect(a.level).toBe('error')
  })

  test('從來沒收到回報 → WARN 級「未知」', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readWorkerStatuses: () => [] }))
    const a = byKey(alerts, 'monitor-db:worker-spool:w1')!
    expect(a.tripped).toBe(true)
    expect(a.level).toBe('warn')
    expect(a.detail).toContain('從未收到')
  })

  test('回報本身落後超過 5 分鐘 → WARN 級「未知」', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readWorkerStatuses: () => [{ worker: 'w1', spoolDepth: 0, oldestAgeS: 0, dbWritable: true, receivedAt: NOW - WORKER_REPORT_STALE_MS - 1000 }] }),
    )
    const a = byKey(alerts, 'monitor-db:worker-spool:w1')!
    expect(a.tripped).toBe(true)
    expect(a.level).toBe('warn')
    expect(a.detail).toContain('落後')
  })

  test('回報新鮮但 spoolDepth 不明（null）→ 不告警（不知道 ≠ 超標）', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readWorkerStatuses: () => [{ worker: 'w1', spoolDepth: null, oldestAgeS: null, dbWritable: null, receivedAt: NOW - 1000 }] }),
    )
    expect(byKey(alerts, 'monitor-db:worker-spool:w1')!.tripped).toBe(false)
  })
})

describe('(f) r1_violation', () => {
  test('> 0 → tripped', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readR1Violations: () => 1 }))
    expect(byKey(alerts, 'monitor-db:r1-violation')!.tripped).toBe(true)
  })

  test('= 0 → 不告警', async () => {
    expect(byKey(await evaluateMonitorDbAlerts(healthyDeps()), 'monitor-db:r1-violation')!.tripped).toBe(false)
  })
})

// 判準（總指揮終版裁定）＝三支 OR：
//   degraded === true || requestedValid === false || normalize(requested) !== effective
// 第三支是 head 側獨立正規化後的交叉驗證，補回「真降級但忘設 degraded」的盲區。
describe('(g) 讀取面靜默降級', () => {
  const rs = (o: Partial<ReadSourceStatus>): MonitorAlertDeps =>
    healthyDeps({
      readReadSource: async () => ({ requested: 'mysql', effective: 'mysql', degraded: false, requestedValid: true, ...o }),
    })
  const trippedG = async (o: Partial<ReadSourceStatus>) => byKey(await evaluateMonitorDbAlerts(rs(o)), 'monitor-db:read-source-degraded')!.tripped

  test('degraded=true → tripped（面板數字看起來正常，來源已經不是要求的那個）', async () => {
    const a = byKey(await evaluateMonitorDbAlerts(rs({ effective: 'sqlite', degraded: true })), 'monitor-db:read-source-degraded')!
    expect(a.tripped).toBe(true)
    expect(a.level).toBe('error')
    expect(a.detail).toContain('sqlite')
  })

  test('requestedValid=false → tripped（設定值本身非法，被 fail-safe 吃掉）', async () => {
    expect(await trippedG({ requested: 'mysq', effective: 'sqlite', degraded: false, requestedValid: false })).toBe(true)
  })

  test('兩者皆正常 → 不告警', async () => {
    expect(await trippedG({})).toBe(false)
  })

  // 這三種是**健康**設定，tg-monitor 端都正常解析（requestedValid=true）。
  // 舊判準（effective !== requested 裸字串比對）會對它們全部誤報。
  describe('健康變體不得誤報（裸字串比對的四個誤報來源）', () => {
    test('未設 MON_READ_SOURCE（run-monitor.sh 匯出空字串）：requested = ""', async () => {
      expect(await trippedG({ requested: '', effective: 'sqlite', degraded: false, requestedValid: true })).toBe(false)
    })

    test('未設 MON_READ_SOURCE（行程根本沒這個變數）：requested = null', async () => {
      // tg-monitor server.ts:1107 是 `requested: raw ?? null`，這種情況送出 JSON null。
      expect(await trippedG({ requested: null, effective: 'sqlite', degraded: false, requestedValid: true })).toBe(false)
    })

    test('大小寫不同：requested = "MySQL"', async () => {
      expect(await trippedG({ requested: 'MySQL', effective: 'mysql', degraded: false, requestedValid: true })).toBe(false)
    })

    test('尾隨空白：requested = "mysql "', async () => {
      expect(await trippedG({ requested: 'mysql ', effective: 'mysql', degraded: false, requestedValid: true })).toBe(false)
    })

    test('明確設 sqlite：requested = "sqlite"', async () => {
      expect(await trippedG({ requested: 'sqlite', effective: 'sqlite', degraded: false, requestedValid: true })).toBe(false)
    })
  })

  // 第三支存在的理由：前兩支都建立在「相信被監控者的自述」上。degraded 由
  // tg-monitor server.ts:1113 單一處算出，那一處漏設／算錯，告警就跟著瞎掉。
  describe('第三支交叉驗證：對方真降級卻漏設 degraded', () => {
    test('{requested:"mysql", effective:"sqlite", degraded:false, requestedValid:true} → 必須翻轉', async () => {
      const a = byKey(
        await evaluateMonitorDbAlerts(rs({ requested: 'mysql', effective: 'sqlite', degraded: false, requestedValid: true })),
        'monitor-db:read-source-degraded',
      )!
      expect(a.tripped).toBe(true)
      expect(a.detail).toContain('交叉驗證')
      expect(a.detail).toContain("應得 'mysql'")
    })

    test('反向：要 sqlite 卻在跑 mysql（同樣是自報旗標抓不到的不一致）', async () => {
      expect(await trippedG({ requested: 'sqlite', effective: 'mysql', degraded: false, requestedValid: true })).toBe(true)
    })

    test('第三支不依賴 requestedValid：舊版回應（無該欄）一樣抓得到', async () => {
      expect(await trippedG({ requested: 'mysql', effective: 'sqlite', degraded: false, requestedValid: null })).toBe(true)
    })
  })

  describe('對面還是舊版（回應沒有 requestedValid 欄位 ⇒ null）', () => {
    test('健康設定 → 不翻轉（不得因為「這個問題答不出來」就告警）', async () => {
      expect(await trippedG({ requested: 'mysql', effective: 'mysql', degraded: false, requestedValid: null })).toBe(false)
    })

    test('degraded=true → 仍然翻轉（第 1 支在舊版一樣有效）', async () => {
      expect(await trippedG({ requested: 'mysql', effective: 'mysql', degraded: true, requestedValid: null })).toBe(true)
    })

    test('打錯字在舊版**抓不到**（已知界線）：normalize("mysq")="sqlite" 與 effective 一致，且無 requestedValid 可判', async () => {
      // 這不是缺陷而是舊版回應的資訊上限——第 2 支就是為了補這個洞才加的欄位。
      expect(await trippedG({ requested: 'mysq', effective: 'sqlite', degraded: false, requestedValid: null })).toBe(false)
    })
  })

  test('unknown（讀取器回 null）→ 這條完全不出現，呼叫端因此保留前一狀態、不誤翻轉', async () => {
    const alerts = await evaluateMonitorDbAlerts(healthyDeps({ readReadSource: async () => null }))
    expect(byKey(alerts, 'monitor-db:read-source-degraded')).toBeUndefined()
    // 其他條件照跑
    expect(byKey(alerts, 'monitor-db:r1-violation')).toBeDefined()
  })

  test('讀取器拋錯 → 同樣只省略這一條', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        readReadSource: async () => {
          throw new Error('fetch 爆了')
        },
      }),
    )
    expect(byKey(alerts, 'monitor-db:read-source-degraded')).toBeUndefined()
    expect(byKey(alerts, 'monitor-db:r1-violation')).toBeDefined()
  })
})

// probeReadSource 的 HTTP 層：用真的最小 Bun.serve 當 tg-monitor 的替身，
// 驗「什麼情況回 null（unknown）」——這是 (g) 不誤翻轉的唯一結構保證。
describe('probeReadSource — 只有拿到合法回應才不是 unknown', () => {
  let mode = 'ok'
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path !== '/api/read-source') return new Response('not found', { status: 404 })
      if (mode === 'ok') return Response.json({ requested: 'mysql', effective: 'sqlite', degraded: true, requestedValid: true })
      if (mode === 'legacy') return Response.json({ requested: 'mysql', effective: 'sqlite', degraded: true })
      if (mode === 'badvalid') return Response.json({ requested: 'mysql', effective: 'sqlite', degraded: true, requestedValid: 'yes' })
      if (mode === 'unset') return Response.json({ requested: null, effective: 'sqlite', degraded: false, requestedValid: true })
      if (mode === 'shape') return Response.json({ requested: 'mysql' })
      if (mode === 'notjson') return new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } })
      return new Response('boom', { status: 500 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  afterAll(() => server.stop(true))

  test('200 + 合法形狀 → 回實際內容（含 requestedValid）', async () => {
    mode = 'ok'
    expect(await probeReadSource(`${base}/api/read-source`)).toEqual({ requested: 'mysql', effective: 'sqlite', degraded: true, requestedValid: true })
  })

  test('舊版回應（沒有 requestedValid 欄位）→ 收斂成 null，其餘三欄照收', async () => {
    mode = 'legacy'
    expect(await probeReadSource(`${base}/api/read-source`)).toEqual({ requested: 'mysql', effective: 'sqlite', degraded: true, requestedValid: null })
  })

  test('requestedValid 型別不對 → 同樣收斂成 null（不猜、不當成 false）', async () => {
    mode = 'badvalid'
    expect(await probeReadSource(`${base}/api/read-source`)).toEqual({ requested: 'mysql', effective: 'sqlite', degraded: true, requestedValid: null })
  })

  test('requested 為 null（MON_READ_SOURCE 未設）→ **不是** unknown，照常回內容', async () => {
    // 這一條擋的是「把未設變數的那台整條判成 unknown ⇒ 條件 g 從此不評估」。
    mode = 'unset'
    expect(await probeReadSource(`${base}/api/read-source`)).toEqual({ requested: null, effective: 'sqlite', degraded: false, requestedValid: true })
  })

  test('404（tg-monitor 還沒載入 Phase 8 的碼）→ null，不告警', async () => {
    expect(await probeReadSource(`${base}/api/not-there`)).toBeNull()
  })

  test('500 → null', async () => {
    mode = '500'
    expect(await probeReadSource(`${base}/api/read-source`)).toBeNull()
  })

  test('200 但欄位缺／型別不對 → null', async () => {
    mode = 'shape'
    expect(await probeReadSource(`${base}/api/read-source`)).toBeNull()
  })

  test('200 但 body 不是 JSON → null', async () => {
    mode = 'notjson'
    expect(await probeReadSource(`${base}/api/read-source`)).toBeNull()
  })

  test('連線拒絕（沒人聽的 port）→ null', async () => {
    expect(await probeReadSource('http://127.0.0.1:1/api/read-source')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2026-09-02 對抗性覆核的修補（NONBLOCKING 4/5/6/11）
// ─────────────────────────────────────────────────────────────────────────

describe('(e) db_writable 的三態（a7-D15：null＝不知道，不得壓成 false）', () => {
  const tripping = (dbWritable: boolean | null) =>
    healthyDeps({
      readWorkerStatuses: () => [{ worker: 'w1', spoolDepth: SPOOL_DEPTH_THRESHOLD + 1, oldestAgeS: 60, dbWritable, receivedAt: NOW - 1000 }],
    })

  test('false → 明說「不可寫」', async () => {
    const a = byKey(await evaluateMonitorDbAlerts(tripping(false)), 'monitor-db:worker-spool:w1')!
    expect(a.detail).toContain('回報監控 DB 不可寫')
    expect(a.detail).not.toContain('未知')
  })

  test('null（該台還沒有成功心跳）→ 明說「未知」，絕不說成不可寫', async () => {
    const a = byKey(await evaluateMonitorDbAlerts(tripping(null)), 'monitor-db:worker-spool:w1')!
    expect(a.detail).toContain('可寫性未知')
    expect(a.detail).not.toContain('不可寫')
  })

  test('true → 兩句都不加（沒有壞消息就不製造壞消息）', async () => {
    const a = byKey(await evaluateMonitorDbAlerts(tripping(true)), 'monitor-db:worker-spool:w1')!
    expect(a.detail).not.toContain('不可寫')
    expect(a.detail).not.toContain('未知')
  })
})

describe('永不拋例外的契約：單條件炸掉不得中斷其餘', () => {
  test('readHeartbeats 回非陣列 → (a) 三條各自被吞，(b)(c)(f)(g) 照常評估', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      // 假 dep 回了型別擋不住的東西（真實情境：writes 層改了回傳形狀）
      healthyDeps({ readHeartbeats: async () => 'not an array' as unknown as never }),
    )
    // (a)(d) 全部被吞掉、不出現
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')).toBeUndefined()
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')).toBeUndefined()
    // 其餘條件全部照常
    expect(byKey(alerts, 'monitor-db:head-spool')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:tunnel:w1')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:worker-spool:w1')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:r1-violation')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:read-source-degraded')).toBeDefined()
  })

  test('心跳列的 ts 取值時拋錯 → 只吞該台，其他台與其他條件不受影響', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => [
          { name: 'w1', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false },
          { name: 'w2', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false },
        ],
        readHeartbeats: async () => [
          { host: 'head', writer: 'server', ts: iso(1000) },
          { host: 'head', writer: 'tg-monitor', ts: iso(1000) },
          { host: 'head', writer: 'log-intake', ts: iso(1000) },
          // 讀 host 就炸（模擬 driver 回了帶 getter 的怪 row）
          Object.defineProperty({ writer: 'worker-agent', ts: iso(1000) }, 'host', {
            get() {
              throw new Error('row 壞了')
            },
          }) as never,
        ],
      }),
    )
    // w1 的心跳條件被吞（因為 find 掃到壞 row 就拋），但 w2 也共用同一次 find……
    // 兩台都被吞才是正確的隔離語意：壞在 rows 上，不是壞在某一台上。
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w1')).toBeUndefined()
    expect(byKey(alerts, 'monitor-db:worker-heartbeat:w2')).toBeUndefined()
    // 但 (a) 是先掃到就回、沒碰到壞 row 的那三條仍然評估得出來
    expect(byKey(alerts, 'monitor-db:head-heartbeat:server')!.tripped).toBe(false)
    // 其他條件完全不受影響
    expect(byKey(alerts, 'monitor-db:tunnel:w1')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:r1-violation')).toBeDefined()
  })
})

describe('onRosterResolved 回呼（呼叫端清理退場 worker 的 key 用）', () => {
  test('名冊解析成功 → 帶 enabled 名單回呼一次', async () => {
    const seen: string[][] = []
    await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => [
          { name: 'w1', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false },
          { name: 'w2', registeredAt: iso(NEW_WORKER_GRACE_MS * 2), disabled: false },
        ],
        onRosterResolved: names => seen.push(names),
      }),
    )
    expect(seen).toEqual([['w1', 'w2']])
  })

  test('名冊讀取失敗 → **完全不回呼**（讀不到 ≠ 全部退場）', async () => {
    let called = 0
    await evaluateMonitorDbAlerts(
      healthyDeps({
        listWorkers: () => {
          throw new Error('名冊檔壞了')
        },
        onRosterResolved: () => {
          called++
        },
      }),
    )
    expect(called).toBe(0)
  })

  test('回呼自己拋錯 → 不影響任何告警評估', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({
        onRosterResolved: () => {
          throw new Error('呼叫端的清理爆炸')
        },
      }),
    )
    expect(byKey(alerts, 'monitor-db:tunnel:w1')).toBeDefined()
    expect(byKey(alerts, 'monitor-db:r1-violation')).toBeDefined()
  })
})

describe('(g) MON_READ_SOURCE 打錯字的 fail-safe 情境（指揮層追加驗收）', () => {
  // tg-monitor 的 resolveReadSource() 對打錯的值 fail-safe 回 sqlite，端點回
  // {requested:"mysq", effective:"sqlite", degraded:false, requestedValid:false}
  // ——degraded 是 **false**，所以第 1 支放過；第 3 支也放過（head 的 normalize
  // 鏡射同一套 fail-safe，normalize("mysq")="sqlite" 正好等於 effective）。
  // **只有第 2 支 requestedValid===false 抓得到它**——這就是那個欄位存在的理由。
  test('{degraded:false, requestedValid:false} → 必須翻轉告警', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readReadSource: async () => ({ requested: 'mysq', effective: 'sqlite', degraded: false, requestedValid: false }) }),
    )
    const a = byKey(alerts, 'monitor-db:read-source-degraded')!
    expect(a.tripped).toBe(true)
    // 原始 typo 字串要原樣進 TG 訊息，維運才看得出是設定打錯而不是探針失敗
    expect(a.detail).toContain("requested='mysq'")
    expect(a.detail).toContain('不合法')
  })

  test('probeReadSource 對設定值零正規化（日後有人加 lowercase/trim/enum 解析會讓這條紅）', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ requested: 'MySQ ', effective: 'sqlite', degraded: false, requestedValid: false }),
    })
    try {
      const got = await probeReadSource(`http://127.0.0.1:${server.port}/api/read-source`)
      expect(got).toEqual({ requested: 'MySQ ', effective: 'sqlite', degraded: false, requestedValid: false })
    } finally {
      server.stop(true)
    }
  })
})

// head 側的正規化——語意必須鏡射 tg-monitor/lib/read/source.ts 的 resolveReadSource。
// 這組測試就是那份鏡射契約的落地：對方改值域而這裡沒跟上時，應該由這裡先紅。
describe('normalizeReadSource（鏡射 tg-monitor resolveReadSource 的語意）', () => {
  const cases: Array<[string | null, 'mysql' | 'sqlite']> = [
    [null, 'sqlite'], // 未設
    ['', 'sqlite'], // 空字串（run-monitor.sh 匯出的形式）
    ['   ', 'sqlite'], // 只有空白
    ['sqlite', 'sqlite'],
    ['mysql', 'mysql'],
    ['MySQL', 'mysql'], // 大小寫不敏感
    ['  mysql  ', 'mysql'], // 前後空白
    ['MYSQL', 'mysql'],
    ['mysq', 'sqlite'], // 打錯字 → fail-safe
    ['postgres', 'sqlite'], // 不認得的值 → fail-safe
    ['mysql;', 'sqlite'], // 夾帶字元 → fail-safe
  ]
  for (const [raw, expected] of cases) {
    test(`${JSON.stringify(raw)} → '${expected}'`, () => {
      expect(normalizeReadSource(raw)).toBe(expected)
    })
  }
})
