import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findStaleLocks, reapStaleLocks } from './stale-lock-reaper.ts'
import { markPipelineActive } from './active-pipeline-marker.ts'
import { __setMonitorTestOverrides, __resetMonitorTestOverrides } from './spawn-create-mr.ts'
import { FakeRunsDb } from '../monitor-db/test-support/fake-runs-db.ts'
import type { SpoolEntry } from '../monitor-db/spool/types.ts'

const NOW = Date.parse('2026-08-23T12:00:00Z')
const FRESH_TIME = '2026-08-23T11:55:00Z' // 5 分鐘前，遠低於 195 分鐘門檻
const STALE_TIME = '2026-08-23T08:00:00Z' // 4 小時前，超過 195 分鐘門檻

/** 建一個假的 bug-lock.sh LOCK_DIR：每個 ticket 一個目錄，內含 info 檔（內容
 * 不影響判斷，2026-08-23 起 staleness 改看 active-pipeline 標記，不看這裡的
 * info）。lockedTickets 不含 info 檔的那些用來測「非真正鎖目錄」的邊界情況。 */
function makeLockDir(lockedTickets: string[], withoutInfo: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-lock-test-'))
  for (const ticket of lockedTickets) {
    const ticketDir = join(dir, ticket)
    mkdirSync(ticketDir, { recursive: true })
    if (!withoutInfo.includes(ticket)) {
      writeFileSync(join(ticketDir, 'info'), 'pid=12345\ntime=2026-08-23T00:00:00Z\n')
    }
  }
  return dir
}

/** 建一個假的 active-pipeline-marker 目錄：ticket → 標記時間（或 null 表示
 * 完全不建標記檔，模擬「不是 dispatcher 觸發」）。 */
function makeMarkerDir(entries: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-marker-test-'))
  for (const [ticket, time] of Object.entries(entries)) {
    if (time !== null) writeFileSync(join(dir, ticket), time)
  }
  return dir
}

describe('findStaleLocks', () => {
  test('沒有鎖目錄 → 空陣列', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-lock-empty-'))
    rmSync(dir, { recursive: true, force: true }) // 目錄本身不存在
    expect(findStaleLocks({ lockDir: dir, now: NOW })).toEqual([])
  })

  test('鎖持有時間在門檻內（依 marker 時間）→ 不算逾時', () => {
    const lockDir = makeLockDir(['FAQ-1'])
    const markerDir = makeMarkerDir({ 'FAQ-1': FRESH_TIME })
    expect(findStaleLocks({ lockDir, markerDir, now: NOW })).toEqual([])
  })

  test('鎖持有時間超過 195 分鐘門檻（依 marker 時間）→ 判定逾時，含正確 ageMs', () => {
    const lockDir = makeLockDir(['FAQ-2'])
    const markerDir = makeMarkerDir({ 'FAQ-2': STALE_TIME })
    const result = findStaleLocks({ lockDir, markerDir, now: NOW })
    expect(result).toHaveLength(1)
    expect(result[0]!.ticket).toBe('FAQ-2')
    expect(result[0]!.ageMs).toBe(NOW - Date.parse(STALE_TIME))
  })

  test('恰好卡在門檻邊界（195 分鐘整）→ 算逾時（>= 不是 >）', () => {
    const boundaryTime = new Date(NOW - 195 * 60 * 1000).toISOString()
    const lockDir = makeLockDir(['FAQ-3'])
    const markerDir = makeMarkerDir({ 'FAQ-3': boundaryTime })
    expect(findStaleLocks({ lockDir, markerDir, now: NOW })).toHaveLength(1)
  })

  test('鎖存在但沒有 active-pipeline 標記（不是 dispatcher 觸發，例如人工跑 /create-mr）→ 完全不碰，即使持有很久也不算逾時', () => {
    const lockDir = makeLockDir(['FAQ-4'])
    const markerDir = makeMarkerDir({}) // 沒有任何標記
    expect(findStaleLocks({ lockDir, markerDir, now: NOW })).toEqual([])
  })

  test('鎖目錄沒有 info 檔（不是真正的 bug-lock.sh 鎖，雜訊目錄）→ 略過，即使剛好有同名標記', () => {
    const lockDir = makeLockDir(['FAQ-5'], ['FAQ-5'])
    const markerDir = makeMarkerDir({ 'FAQ-5': STALE_TIME })
    expect(findStaleLocks({ lockDir, markerDir, now: NOW })).toEqual([])
  })

  test('標記檔內容壞掉（非法時間字串）→ 視同沒有標記，不碰', () => {
    const lockDir = makeLockDir(['FAQ-6'])
    const markerDir = mkdtempSync(join(tmpdir(), 'stale-marker-test-'))
    writeFileSync(join(markerDir, 'FAQ-6'), 'not-a-date')
    expect(findStaleLocks({ lockDir, markerDir, now: NOW })).toEqual([])
  })

  test('多個 ticket 混合：有標記+逾時／有標記+未逾時／無標記 → 只回傳有標記且逾時的那些', () => {
    const lockDir = makeLockDir(['FAQ-7', 'FAQ-8', 'ALDREQ-1'])
    const markerDir = makeMarkerDir({ 'FAQ-7': FRESH_TIME, 'FAQ-8': STALE_TIME, 'ALDREQ-1': STALE_TIME })
    const result = findStaleLocks({ lockDir, markerDir, now: NOW })
    const tickets = result.map(r => r.ticket).sort()
    expect(tickets).toEqual(['ALDREQ-1', 'FAQ-8'])
  })
})

describe('reapStaleLocks', () => {
  const baseDeps = () => ({
    release: mock((_t: string) => {}),
    cleanup: mock((_t: string) => {}),
    clearMarker: mock((_t: string) => {}),
    retry: mock((_t: string, _retryOfRunId: string | null) => ({ ok: true })),
    notify: mock((_t: string) => true),
    readRetryState: () => ({}) as Record<string, number>,
    writeRetryState: (_s: Record<string, number>) => {},
  })

  test('沒有逾時鎖 → 不呼叫任何 release/cleanup/clearMarker/retry/notify', () => {
    const lockDir = makeLockDir(['FAQ-1'])
    const markerDir = makeMarkerDir({ 'FAQ-1': FRESH_TIME })
    const deps = baseDeps()
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(result).toEqual([])
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.cleanup).not.toHaveBeenCalled()
    expect(deps.clearMarker).not.toHaveBeenCalled()
    expect(deps.retry).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  test('沒有 active-pipeline 標記的鎖（人工/批次觸發）→ 完全不處理，就算持有很久', () => {
    const lockDir = makeLockDir(['FAQ-1'])
    const markerDir = makeMarkerDir({})
    const deps = baseDeps()
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(result).toEqual([])
    expect(deps.release).not.toHaveBeenCalled()
  })

  test('FAQ 逾時鎖、尚未重試過 → release + cleanup + clearMarker + 自動重試一次 + 通知（文字含「自動重新觸發」），retryState 記為 1', () => {
    const lockDir = makeLockDir(['FAQ-100'])
    const markerDir = makeMarkerDir({ 'FAQ-100': STALE_TIME })
    const retryState: Record<string, number> = {}
    const deps = { ...baseDeps(), readRetryState: () => retryState, writeRetryState: (s: Record<string, number>) => Object.assign(retryState, s) }
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(deps.release).toHaveBeenCalledWith('FAQ-100')
    expect(deps.cleanup).toHaveBeenCalledWith('FAQ-100')
    expect(deps.clearMarker).toHaveBeenCalledWith('FAQ-100')
    expect(deps.retry).toHaveBeenCalledWith('FAQ-100', null)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.notify.mock.calls[0]![0]).toContain('自動重新觸發')
    expect(result).toEqual([{ ticket: 'FAQ-100', ageMs: NOW - Date.parse(STALE_TIME), retried: true }])
    expect(retryState['FAQ-100']).toBe(1)
  })

  test('FAQ 逾時鎖、已重試過 1 次（達上限）→ 不再重試，只回收＋通知，文字含「已達自動重試上限」', () => {
    const lockDir = makeLockDir(['FAQ-101'])
    const markerDir = makeMarkerDir({ 'FAQ-101': STALE_TIME })
    const retryState: Record<string, number> = { 'FAQ-101': 1 }
    const deps = { ...baseDeps(), readRetryState: () => retryState, writeRetryState: (s: Record<string, number>) => Object.assign(retryState, s) }
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(deps.retry).not.toHaveBeenCalled()
    expect(deps.notify.mock.calls[0]![0]).toContain('已達自動重試上限')
    expect(result).toEqual([{ ticket: 'FAQ-101', ageMs: NOW - Date.parse(STALE_TIME), retried: false }])
  })

  test('自動重試 spawn 本身失敗 → 通知內容標示失敗原因，retried=false，且 retryState 不被扣掉（review 修正：失敗不消耗額度）', () => {
    const lockDir = makeLockDir(['FAQ-102'])
    const markerDir = makeMarkerDir({ 'FAQ-102': STALE_TIME })
    const retryState: Record<string, number> = {}
    const deps = {
      ...baseDeps(),
      retry: mock((_t: string, _retryOfRunId: string | null) => ({ ok: false, reason: 'concurrency_limit' })),
      readRetryState: () => retryState,
      writeRetryState: (s: Record<string, number>) => Object.assign(retryState, s),
    }
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(deps.notify.mock.calls[0]![0]).toContain('concurrency_limit')
    expect(result[0]!.retried).toBe(false)
    expect(retryState['FAQ-102']).toBeUndefined() // 失敗不計入額度，下次還能再試
  })

  test('ALDREQ（需求單）逾時鎖 → 一律不自動重試（沿用 T36 保守政策），只回收＋通知', () => {
    const lockDir = makeLockDir(['ALDREQ-200'])
    const markerDir = makeMarkerDir({ 'ALDREQ-200': STALE_TIME })
    const deps = baseDeps()
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(deps.retry).not.toHaveBeenCalled()
    expect(deps.notify.mock.calls[0]![0]).toContain('需求單不自動重試')
    expect(result[0]!.retried).toBe(false)
  })

  test('cleanup / clearMarker 丟例外 → 吞掉並記錄，不阻斷後續通知（best-effort）', () => {
    const lockDir = makeLockDir(['FAQ-103'])
    const markerDir = makeMarkerDir({ 'FAQ-103': STALE_TIME })
    const deps = {
      ...baseDeps(),
      cleanup: mock((_t: string) => {
        throw new Error('git worktree remove 失敗')
      }),
      clearMarker: mock((_t: string) => {
        throw new Error('rmSync 失敗')
      }),
    }
    expect(() => reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)).not.toThrow()
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  test('多張逾時單各自獨立處理，互不影響', () => {
    const lockDir = makeLockDir(['FAQ-104', 'ALDREQ-201'])
    const markerDir = makeMarkerDir({ 'FAQ-104': STALE_TIME, 'ALDREQ-201': STALE_TIME })
    const deps = baseDeps()
    const result = reapStaleLocks({ lockDir, markerDir, now: NOW }, deps)
    expect(result).toHaveLength(2)
    expect(deps.release).toHaveBeenCalledTimes(2)
    expect(deps.retry).toHaveBeenCalledTimes(1) // 只有 FAQ 那張會重試
  })
})

/** dispatchMonitorWrite 是 fire-and-forget（production 呼叫端不 await），
 * 但它回傳 Promise<void>——測試用「讓出一個 macrotask」把已排入的微工作
 * （getMonitorPool → pool.execute → 落 spool）全部跑完，確定性等待，不是猜
 * 一段時間（v3.2 §6.5(a2) 的 fsync 批次寫、Phase 1.4 的 drainAll() 都是同一種
 * 「跑到不再有進展為止」精神——這裡只是它在單一非同步鏈上的最小形式：目前
 * 只有一個會贏過 1000ms 逾時 race 的 microtask 鏈，沒有其他 macrotask 介入）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('reapStaleLocks — v3.2 §5.7：retry 血緣（顯式參數，不靠 env 繼承）與監控 DB 回收終態（tier1 unknown_reaped）', () => {
  afterEach(() => {
    __resetMonitorTestOverrides()
  })

  test('marker 是 v3.2 JSON 格式（帶 runId）→ retry 收到該 runId（不是 null）', async () => {
    const fakeDb = new FakeRunsDb()
    __setMonitorTestOverrides({ pool: fakeDb })

    const lockDir = makeLockDir(['FAQ-200'])
    const markerDir = mkdtempSync(join(tmpdir(), 'stale-marker-json-'))
    // markPipelineActive 本身用「現在」當 startedAt，這裡只需要它產生合法的
    // JSON 格式檔案；staleness 判斷讀的是 getPipelineActiveSince 解出的
    // startedAt，所以額外用 findStaleLocks 的 now 覆寫成很久以後即可，不需要
    // 直接操縱檔案內容裡的時間戳。
    markPipelineActive('FAQ-200', { dir: markerDir, runId: '99999999-8888-7777-6666-555555555555', kind: 'bug' })
    const farFuture = Date.now() + 400 * 60 * 1000 // 400 分鐘後，遠超過 195 分鐘門檻

    const retryMock = mock((_t: string, _retryOfRunId: string | null) => ({ ok: true, runId: 'new-run-id' }))
    const result = reapStaleLocks({ lockDir, markerDir, now: farFuture }, { ...baseDepsForJsonTest(), retry: retryMock })
    expect(result).toHaveLength(1)
    expect(retryMock).toHaveBeenCalledWith('FAQ-200', '99999999-8888-7777-6666-555555555555')

    await flushMicrotasks()
    const row = fakeDb.rows.get('99999999-8888-7777-6666-555555555555')
    expect(row).not.toBeUndefined()
    expect(row!.outcome).toBe('unknown_reaped')
    expect(row!.outcome_tier).toBe(1)
  })

  test('marker 是舊格式（純 ISO 字串，無 runId）→ retry 收到 null，且不寫任何監控 DB 終態（沒有 runId 可寫）', async () => {
    const fakeDb = new FakeRunsDb()
    __setMonitorTestOverrides({ pool: fakeDb })

    const lockDir = makeLockDir(['FAQ-201'])
    const markerDir = makeMarkerDir({ 'FAQ-201': STALE_TIME })
    const retryMock = mock((_t: string, retryOfRunId: string | null) => ({ ok: true }))
    reapStaleLocks({ lockDir, markerDir, now: NOW }, { ...baseDepsForJsonTest(), retry: retryMock })
    expect(retryMock).toHaveBeenCalledWith('FAQ-201', null)

    await flushMicrotasks()
    expect(fakeDb.calls.length).toBe(0)
  })

  test('MON_DB_ENABLED 關閉、無覆寫時 → 完全不觸碰監控 DB（reapStaleLocks 既有行為不受影響）', async () => {
    __resetMonitorTestOverrides()
    const prevFlag = process.env.MON_DB_ENABLED
    delete process.env.MON_DB_ENABLED
    try {
      const lockDir = makeLockDir(['FAQ-202'])
      const markerDir = mkdtempSync(join(tmpdir(), 'stale-marker-json-'))
      markPipelineActive('FAQ-202', { dir: markerDir, runId: '11111111-2222-3333-4444-666666666666', kind: 'bug' })
      const farFuture = Date.now() + 400 * 60 * 1000
      const result = reapStaleLocks({ lockDir, markerDir, now: farFuture }, baseDepsForJsonTest())
      expect(result).toHaveLength(1) // 既有的回收流程（release/cleanup/clearMarker/retry）完全不受監控 DB 影響
      await flushMicrotasks()
    } finally {
      if (prevFlag === undefined) delete process.env.MON_DB_ENABLED
      else process.env.MON_DB_ENABLED = prevFlag
    }
  })
})

function baseDepsForJsonTest() {
  return {
    release: mock((_t: string) => {}),
    cleanup: mock((_t: string) => {}),
    clearMarker: mock((_t: string) => {}),
    retry: mock((_t: string, _retryOfRunId: string | null) => ({ ok: true })),
    notify: mock((_t: string) => true),
    readRetryState: () => ({}) as Record<string, number>,
    writeRetryState: (_s: Record<string, number>) => {},
  }
}
