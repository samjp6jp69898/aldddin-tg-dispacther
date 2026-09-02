import { afterAll, describe, expect, test } from 'bun:test'
import {
  evaluateMonitorDbAlerts,
  probeReadSource,
  HEARTBEAT_STALE_MS,
  NEW_WORKER_GRACE_MS,
  SPOOL_DEPTH_THRESHOLD,
  SPOOL_OLDEST_THRESHOLD_MS,
  WORKER_REPORT_STALE_MS,
  type MonitorAlert,
  type MonitorAlertDeps,
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
    readReadSource: async () => ({ requested: 'mysql', effective: 'mysql', degraded: false }),
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

describe('(g) 讀取面靜默降級', () => {
  test('degraded=true → tripped（面板數字看起來正常，來源已經不是要求的那個）', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readReadSource: async () => ({ requested: 'mysql', effective: 'sqlite', degraded: true }) }),
    )
    const a = byKey(alerts, 'monitor-db:read-source-degraded')!
    expect(a.tripped).toBe(true)
    expect(a.level).toBe('error')
    expect(a.detail).toContain('sqlite')
  })

  test('degraded 旗標忘了設，但 effective ≠ requested → 一樣 tripped（不依賴那個旗標的正確性）', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readReadSource: async () => ({ requested: 'mysql', effective: 'sqlite', degraded: false }) }),
    )
    expect(byKey(alerts, 'monitor-db:read-source-degraded')!.tripped).toBe(true)
  })

  test('requested === effective 且 degraded=false → 不告警', async () => {
    const alerts = await evaluateMonitorDbAlerts(
      healthyDeps({ readReadSource: async () => ({ requested: 'sqlite', effective: 'sqlite', degraded: false }) }),
    )
    expect(byKey(alerts, 'monitor-db:read-source-degraded')!.tripped).toBe(false)
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
      if (mode === 'ok') return Response.json({ requested: 'mysql', effective: 'sqlite', degraded: true })
      if (mode === 'shape') return Response.json({ requested: 'mysql' })
      if (mode === 'notjson') return new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } })
      return new Response('boom', { status: 500 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  afterAll(() => server.stop(true))

  test('200 + 合法形狀 → 回實際內容', async () => {
    mode = 'ok'
    expect(await probeReadSource(`${base}/api/read-source`)).toEqual({ requested: 'mysql', effective: 'sqlite', degraded: true })
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
