import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCloudflaredTunnelReachable, checkTokenRegistryLoadable, createHealthMonitor } from './health-monitor.ts'

// 用一個真的最小 Bun.serve 假裝 cloudflared 的 metrics /ready（不接觸真實
// cloudflared，也不 mock fetch——這裡就是要驗證真的打了一次 HTTP request 並
// 正確解析回應）。
let readyConnections = 1
const fakeCloudflaredServer = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/ready') {
      return Response.json({ status: 200, readyConnections, connectorId: 'fake-connector' })
    }
    if (url.pathname === '/ready-500') {
      return new Response('error', { status: 500 })
    }
    return new Response('not found', { status: 404 })
  },
})
const BASE = `http://127.0.0.1:${fakeCloudflaredServer.port}`

afterAll(() => {
  fakeCloudflaredServer.stop(true)
})

describe('checkCloudflaredTunnelReachable', () => {
  test('有 ready connection → true', async () => {
    readyConnections = 4
    expect(await checkCloudflaredTunnelReachable(`${BASE}/ready`)).toBe(true)
  })

  test('readyConnections 是 0 → false', async () => {
    readyConnections = 0
    expect(await checkCloudflaredTunnelReachable(`${BASE}/ready`)).toBe(false)
  })

  test('API 回 500 → false（不拋例外）', async () => {
    readyConnections = 4
    expect(await checkCloudflaredTunnelReachable(`${BASE}/ready-500`)).toBe(false)
  })

  test('連不上（port 沒人聽）→ false（不拋例外）', async () => {
    expect(await checkCloudflaredTunnelReachable('http://127.0.0.1:1')).toBe(false)
  })
})

describe('createHealthMonitor — 狀態翻轉才通知，避免洗版', () => {
  test('第一次檢查只記基準值，不通知（避免剛啟動 tunnel 還沒起來就誤報）', async () => {
    readyConnections = 0
    const notify = mock((_text: string) => {})
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/ready`, notify, registryPaths: [], monitorAlerts: false })

    const result = await monitor.runOnce()

    expect(result).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  test('健康 → 不健康：翻轉時通知一次；持續不健康：不重複通知', async () => {
    const notify = mock((_text: string) => {})
    // 先給一個會動態切換的假 server 端點，模擬「原本健康，後來變不健康」。
    readyConnections = 4
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/ready`, notify, registryPaths: [], monitorAlerts: false })

    await monitor.runOnce() // 基準：健康，不通知
    expect(notify).not.toHaveBeenCalled()

    readyConnections = 0 // 模擬 tunnel 掉了
    await monitor.runOnce() // 翻轉：健康→不健康，該通知
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('偵測不到')

    await monitor.runOnce() // 持續不健康，不該重複通知
    expect(notify).toHaveBeenCalledTimes(1)

    readyConnections = 4 // 恢復
    await monitor.runOnce() // 翻轉：不健康→健康，該通知恢復
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('已恢復')
  })
})

// F-3：名冊 fail-closed 之後，「名冊壞掉」變成一個更容易觸發、但外部幾乎看不
// 見的故障（企劃端只看到「認證失敗，請重新登入」，重登還是 401）。這組測試
// 用真的暫存檔案，不 mock fs——要驗證的就是「對磁碟上這一刻的內容做判斷」。
describe('checkTokenRegistryLoadable — 判定與 auth.ts loadRegistry 對齊', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokens-check-'))
  })
  afterAll(() => {
    // 每個 case 各自的暫存目錄留在 tmpdir 由 OS 回收即可；這裡只清最後一個。
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (content: string): string => {
    const p = join(dir, 'tokens.json')
    writeFileSync(p, content)
    return p
  }

  test('合法名冊 → null（可載入）', () => {
    const p = write(JSON.stringify({ tokens: [{ id: 'a', token: 't1' }, { id: 'b', token: 't2' }] }))
    expect(checkTokenRegistryLoadable(p)).toBeNull()
  })

  test('空 tokens 陣列 → null（合法，只是誰都授權不了，不算載入失敗）', () => {
    expect(checkTokenRegistryLoadable(write(JSON.stringify({ tokens: [] })))).toBeNull()
  })

  test('檔案不存在 → 回報不存在（外洩止血最直覺的動作就是刪檔）', () => {
    expect(checkTokenRegistryLoadable(join(dir, 'nope.json'))).toBe('名冊檔不存在')
  })

  test('JSON 壞掉 → 回報解析失敗', () => {
    expect(checkTokenRegistryLoadable(write('{"tokens": ['))).toBe('JSON 解析失敗')
  })

  test('tokens 不是陣列 → 回報欄位不對', () => {
    expect(checkTokenRegistryLoadable(write(JSON.stringify({ tokens: 'nope' })))).toBe('tokens 欄位不存在或不是陣列')
  })

  test('條目缺 id / 缺 token → 各自回報，且只帶 index', () => {
    expect(checkTokenRegistryLoadable(write(JSON.stringify({ tokens: [{ token: 't1' }] })))).toBe('第 0 筆條目缺少合法的 id')
    expect(checkTokenRegistryLoadable(write(JSON.stringify({ tokens: [{ id: 'a' }] })))).toBe('第 0 筆條目缺少合法的 token')
  })

  test('id / token 重複 → 各自回報', () => {
    expect(checkTokenRegistryLoadable(write(JSON.stringify({ tokens: [{ id: 'a', token: 't1' }, { id: 'a', token: 't2' }] })))).toBe('第 1 筆條目的 id 與前面重複')
    expect(checkTokenRegistryLoadable(write(JSON.stringify({ tokens: [{ id: 'a', token: 't1' }, { id: 'b', token: 't1' }] })))).toBe('第 1 筆條目的 token 與前面重複')
  })

  test('回報原因絕不夾帶 token 值或 id（訊息會原樣發到 Telegram）', () => {
    const secret = 'SUPER-SECRET-TOKEN-VALUE'
    // 故意漏一組引號，讓 JSON.parse 的原始訊息會夾到 token 原文。
    const reason = checkTokenRegistryLoadable(write(`{"tokens": [{"id": "landon", "token": ${secret}}]}`))
    expect(reason).toBe('JSON 解析失敗')
    expect(reason).not.toContain(secret)
    expect(reason).not.toContain('landon')
  })
})

describe('createHealthMonitor — 名冊故障告警', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokens-mon-'))
  })

  const paths = () => [join(dir, 'tokens.json')]
  const writeRegistry = (content: string) => writeFileSync(join(dir, 'tokens.json'), content)
  // tunnel 那半在這組測試裡固定健康且不翻轉，notify 只會來自名冊檢查。
  const monitorWith = (notify: (t: string) => void) =>
    createHealthMonitor({ apiUrl: `${BASE}/ready`, notify, registryPaths: paths(), monitorAlerts: false })

  test('名冊壞掉 → 告警一次；持續壞掉 → 不重複洗版；修好 → 報恢復', async () => {
    readyConnections = 1
    const notify = mock((_t: string) => {})
    writeRegistry(JSON.stringify({ tokens: [{ id: 'a', token: 't1' }] }))
    const monitor = monitorWith(notify)

    await monitor.runOnce() // 名冊正常，不通知
    expect(notify).not.toHaveBeenCalled()

    writeRegistry('{"tokens": [') // 手改存壞
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('tokens.json')
    expect(notify.mock.calls[0]![0]).toContain('JSON 解析失敗')
    expect(notify.mock.calls[0]![0]).toContain('401')

    await monitor.runOnce() // 還是壞的，同一個原因不重複發
    expect(notify).toHaveBeenCalledTimes(1)

    writeRegistry(JSON.stringify({ tokens: [{ id: 'a', token: 't1' }] }))
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('已恢復可載入')
  })

  test('開機時名冊就已經壞掉 → 第一次檢查就告警（沒有「只記基準值」的寬限）', async () => {
    readyConnections = 1
    const notify = mock((_t: string) => {})
    writeRegistry('not json at all')

    await monitorWith(notify).runOnce()

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('JSON 解析失敗')
  })

  test('壞掉的原因變了 → 再發一次（維運者才知道自己改動的結果）', async () => {
    readyConnections = 1
    const notify = mock((_t: string) => {})
    writeRegistry('{"tokens": [')
    const monitor = monitorWith(notify)

    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)

    writeRegistry(JSON.stringify({ tokens: [{ token: 't1' }] })) // 換一種壞法
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('缺少合法的 id')
  })

  test('多份名冊各自記狀態：第一份壞掉不會遮蔽第二份接著壞掉', async () => {
    readyConnections = 1
    const notify = mock((_t: string) => {})
    const a = join(dir, 'tokens.json')
    const b = join(dir, 'tokens.pre.json')
    const good = JSON.stringify({ tokens: [{ id: 'a', token: 't1' }] })
    writeFileSync(a, good)
    writeFileSync(b, good)
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/ready`, notify, registryPaths: [a, b], monitorAlerts: false })

    await monitor.runOnce()
    expect(notify).not.toHaveBeenCalled()

    writeFileSync(a, 'broken')
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)

    writeFileSync(b, 'broken') // 第二份接著壞
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('tokens.pre.json')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §6.8(3) a–f 的六條營運告警（plan-db-as-truth-v3.2.md）。判定本體在
// lib/monitor-db/alerts.ts（那裡有逐條件的判準測試）；這裡驗的是 health-monitor
// 這一層：flag 閘門、翻轉語意、恢復通知。
// ─────────────────────────────────────────────────────────────────────────
describe('createHealthMonitor — 監控 DB 告警（§6.8(3) a–f）', () => {
  const prevFlag = process.env.MON_DB_ENABLED
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.MON_DB_ENABLED
    else process.env.MON_DB_ENABLED = prevFlag
  })

  /** 六條件全部正常的假讀取器；`over` 只覆寫案例關心的那一支。 */
  const deps = (over: Record<string, unknown> = {}) => ({
    now: () => Date.parse('2026-09-02T12:00:00.000Z'),
    readHeartbeats: async () => [
      { host: 'head', writer: 'server', ts: '2026-09-02T11:59:30.000Z' },
      { host: 'head', writer: 'tg-monitor', ts: '2026-09-02T11:59:30.000Z' },
      { host: 'head', writer: 'log-intake', ts: '2026-09-02T11:59:30.000Z' },
    ],
    readSpool: () => ({ depth: 0, oldestTs: null }),
    listWorkers: () => [],
    probeTunnel: async () => true,
    readWorkerStatuses: () => [],
    readR1Violations: () => 0,
    readReadSource: async () => ({ requested: 'mysql', effective: 'mysql', degraded: false }),
    ...over,
  })

  test('flag=0（未設）→ 一次讀取器都不會被呼叫，行為與改動前相同', async () => {
    delete process.env.MON_DB_ENABLED
    readyConnections = 1
    const notify = mock((_t: string) => {})
    let touched = 0
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({
        readHeartbeats: async () => {
          touched++
          return []
        },
        readSpool: () => {
          touched++
          return { depth: 0, oldestTs: null }
        },
        probeTunnel: async () => {
          touched++
          return true
        },
        readR1Violations: () => {
          touched++
          return 99
        },
        listWorkers: () => {
          touched++
          return []
        },
        readReadSource: async () => {
          touched++
          return null
        },
      }),
    })

    await monitor.runOnce()
    await monitor.runOnce()

    expect(touched).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })

  test('flag=1 且一切正常 → 完全不通知', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/ready`, notify, registryPaths: [], monitorAlerts: deps() })

    await monitor.runOnce()
    expect(notify).not.toHaveBeenCalled()
  })

  test('r1_violation > 0：第一輪就告警，連續兩輪同狀態只告警一次，歸零後報恢復', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    let violations = 1
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({ readR1Violations: () => violations }),
    })

    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('r1_violation')
    expect(notify.mock.calls[0]![0]).toContain('🚨')

    await monitor.runOnce() // 同狀態，不重複洗版
    expect(notify).toHaveBeenCalledTimes(1)

    violations = 0
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('已恢復正常')
  })

  test('每個條件各自記狀態：第一條還在故障時，第二條接著故障仍會發第二則', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    let depth = 0
    let violations = 1
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({ readR1Violations: () => violations, readSpool: () => ({ depth, oldestTs: null }) }),
    })

    await monitor.runOnce() // r1 故障
    expect(notify).toHaveBeenCalledTimes(1)

    depth = 500 // spool 接著積壓，r1 仍故障
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('未 ack')

    void violations
  })

  test('WARN 級（worker 回報缺席）與 ERROR 級用不同前綴', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({
        listWorkers: () => [{ name: 'w1', registeredAt: '2026-09-01T00:00:00.000Z', disabled: false }],
        readWorkerStatuses: () => [],
      }),
    })

    await monitor.runOnce()
    const texts = notify.mock.calls.map(c => c[0] as string)
    expect(texts.some(t => t.startsWith('⚠️ [監控 DB 告警]') && t.includes('從未收到'))).toBe(true)
    // worker 心跳缺列是 ERROR 級
    expect(texts.some(t => t.startsWith('🚨 [監控 DB 告警]') && t.includes('沒有列'))).toBe(true)
  })

  test('某條件評估拋錯 → 只是那一條不評估，不中斷其他條件，也不會誤報「恢復」', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    let broken = false
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({
        readR1Violations: () => 1,
        readSpool: () => {
          if (broken) throw new Error('磁碟壞了')
          return { depth: 0, oldestTs: null }
        },
      }),
    })

    await monitor.runOnce() // r1 告警一次
    expect(notify).toHaveBeenCalledTimes(1)

    broken = true
    await monitor.runOnce() // spool 讀取器炸了，但 r1 仍是同狀態 → 不該有任何新通知
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('監控告警與既有 tunnel／名冊告警互不干擾（tunnel 仍照原本的基準值語意）', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 0
    const notify = mock((_t: string) => {})
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/ready`, notify, registryPaths: [], monitorAlerts: deps() })

    await monitor.runOnce() // tunnel 第一次只記基準值；監控條件全正常
    expect(notify).not.toHaveBeenCalled()

    readyConnections = 1
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('Cloudflare tunnel 已恢復')
  })
})

describe('createHealthMonitor — (g) 讀取面靜默降級（2026-09-02 追加）', () => {
  const prevFlag = process.env.MON_DB_ENABLED
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.MON_DB_ENABLED
    else process.env.MON_DB_ENABLED = prevFlag
  })

  const deps = (over: Record<string, unknown> = {}) => ({
    now: () => Date.parse('2026-09-02T12:00:00.000Z'),
    readHeartbeats: async () => [
      { host: 'head', writer: 'server', ts: '2026-09-02T11:59:30.000Z' },
      { host: 'head', writer: 'tg-monitor', ts: '2026-09-02T11:59:30.000Z' },
      { host: 'head', writer: 'log-intake', ts: '2026-09-02T11:59:30.000Z' },
    ],
    readSpool: () => ({ depth: 0, oldestTs: null }),
    listWorkers: () => [],
    probeTunnel: async () => true,
    readWorkerStatuses: () => [],
    readR1Violations: () => 0,
    readReadSource: async () => ({ requested: 'mysql', effective: 'mysql', degraded: false }),
    ...over,
  })

  test('degraded → 翻轉告警一次；持續 degraded 不重複；恢復報恢復', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    let degraded = false
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({
        readReadSource: async () => (degraded ? { requested: 'mysql', effective: 'sqlite', degraded: true } : { requested: 'mysql', effective: 'mysql', degraded: false }),
      }),
    })

    await monitor.runOnce()
    expect(notify).not.toHaveBeenCalled()

    degraded = true
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('靜默降級')

    await monitor.runOnce() // 同狀態
    expect(notify).toHaveBeenCalledTimes(1)

    degraded = false
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('已恢復正常')
  })

  test('端點 404／打不到（讀取器回 null＝unknown）→ 完全不告警，也不會把先前的告警誤翻成恢復', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    let result: unknown = { requested: 'mysql', effective: 'sqlite', degraded: true }
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({ readReadSource: async () => result }),
    })

    // 先讓它處在 degraded 告警狀態
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1)

    // tg-monitor 重啟成還沒有這條端點的版本 → 404 → unknown
    result = null
    await monitor.runOnce()
    await monitor.runOnce()
    expect(notify).toHaveBeenCalledTimes(1) // 沒有「已恢復」的誤報
  })

  test('tg-monitor 全程沒有這條端點（一直 unknown）→ 一則告警都不發', async () => {
    process.env.MON_DB_ENABLED = '1'
    readyConnections = 1
    const notify = mock((_t: string) => {})
    const monitor = createHealthMonitor({
      apiUrl: `${BASE}/ready`,
      notify,
      registryPaths: [],
      monitorAlerts: deps({ readReadSource: async () => null }),
    })

    await monitor.runOnce()
    await monitor.runOnce()
    expect(notify).not.toHaveBeenCalled()
  })
})
