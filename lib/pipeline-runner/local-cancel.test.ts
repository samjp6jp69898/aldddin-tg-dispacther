// lib/pipeline-runner/local-cancel.test.ts — Task 3：worker 端本機取消。
//
// cancelLocalPipeline() 內部呼叫真的 `ps`（scanRunningPipelineProcsNow，見
// local-proc-scan.ts），但用一個不存在的 ticket 保證「ps 上沒有這張票」這條
// 拒絕路徑可以確定性地測到（不需要真的跑一個 pipeline）——比照
// tg-monitor/lib/ingest.cancel.test.ts 同款手法（K9：這是既有行為，不是新增
// 的拒絕路徑）。deriveCancelFlagFields / resolveRunIdLocalOnly 兩個純函式各自
// 獨立單測，不依賴 ps。
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelLocalPipeline, deriveCancelFlagFields, resolveRunIdLocalOnly } from './local-cancel.ts'
import type { MarkerSnapshot } from '../monitor-db/cancel-resolve.ts'

describe('cancelLocalPipeline — 找不到 ps 上的行程時的拒絕路徑', () => {
  test('回傳的是一個 Promise', () => {
    const p = cancelLocalPipeline('bug', 'FAQ-999999')
    expect(p).toBeInstanceOf(Promise)
  })

  test('ps 上沒有這張票 → not running，且沒有 runId/runIdResolvedBy/flagWritten 三個欄位', async () => {
    const r = await cancelLocalPipeline('bug', 'FAQ-999999')
    expect(r).toEqual({ ok: false, killed: [], reason: 'not running（可能剛結束，或 ps 快照尚未更新，3 秒後再試）' })
    expect(r).not.toHaveProperty('runId')
    expect(r).not.toHaveProperty('runIdResolvedBy')
    expect(r).not.toHaveProperty('flagWritten')
  })

  test('demand kind 同樣套用 not running 拒絕路徑', async () => {
    const r = await cancelLocalPipeline('demand', 'ALDREQ-999999')
    expect(r.ok).toBe(false)
    expect(r.killed).toEqual([])
  })
})

describe('deriveCancelFlagFields（W4b 六欄推導，純函式，比照 tg-monitor 的同名函式）', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('bug kind + 合法 legacyKey + 無 triggered-by sidecar → 六欄有值，triggerSource=cli', () => {
    dir = mkdtempSync(join(tmpdir(), 'local-cancel-'))
    const extra = '/Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-04T10-00-00-000Z.stdout.log'
    const legacyKey = 'FAQ-1234.2026-09-04T10-00-00-000Z'
    const r = deriveCancelFlagFields('bug', extra, legacyKey, dir)
    expect(r.stdoutPath).toBe(extra)
    expect(r.stderrPath).toBe('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-04T10-00-00-000Z.stderr.log')
    expect(r.startedAt).toBe('2026-09-04T10:00:00.000Z')
    expect(r.triggerSource).toBe('cli')
    expect(r.triggeredByEmail).toBeNull()
    expect(r.triggeredByName).toBeNull()
  })

  test('bug kind + 有 triggered-by sidecar → triggerSource=telegram，email/name 真的填進來', () => {
    dir = mkdtempSync(join(tmpdir(), 'local-cancel-'))
    const legacyKey = 'FAQ-5678.2026-09-04T11-30-00-000Z'
    writeFileSync(join(dir, `${legacyKey}.triggered-by.json`), JSON.stringify({ name: '測試人員', email: 'tester@example.com' }))
    const extra = `/Users/user/aladdin/telegram-dispatcher/logs/${legacyKey}.stdout.log`
    const r = deriveCancelFlagFields('bug', extra, legacyKey, dir)
    expect(r.triggerSource).toBe('telegram')
    expect(r.triggeredByEmail).toBe('tester@example.com')
    expect(r.triggeredByName).toBe('測試人員')
  })

  test('demand kind：extra 是 assigneeEmail 不是路徑，六欄全 null/cli，不誤把 email 塞進 stdout_path', () => {
    dir = mkdtempSync(join(tmpdir(), 'local-cancel-'))
    const r = deriveCancelFlagFields('demand', 'someone@example.com', null, dir)
    expect(r.stdoutPath).toBeNull()
    expect(r.stderrPath).toBeNull()
    expect(r.startedAt).toBeNull()
    expect(r.triggerSource).toBe('cli')
  })

  test('bug kind 但 legacyKey 為 null → 不信任 extra，六欄全 null/cli', () => {
    dir = mkdtempSync(join(tmpdir(), 'local-cancel-'))
    const r = deriveCancelFlagFields('bug', '/some/unexpected/path.log', null, dir)
    expect(r.stdoutPath).toBeNull()
    expect(r.stderrPath).toBeNull()
    expect(r.triggerSource).toBe('cli')
  })
})

describe('resolveRunIdLocalOnly（DB 逾時/不可達退路，純函式）', () => {
  test('marker 有值且 kind 一致 → 採用 marker，resolvedBy=marker', () => {
    const marker: MarkerSnapshot = { runId: 'a1b2c3d4-0000-4000-8000-000000000000', kind: 'bug' }
    const r = resolveRunIdLocalOnly('bug', marker)
    expect(r).toEqual({ runId: marker.runId, resolvedBy: 'marker' })
  })

  test('marker kind 與請求不一致 → 不採用，改鑄合法 UUID placeholder', () => {
    const marker: MarkerSnapshot = { runId: 'a1b2c3d4-0000-4000-8000-000000000000', kind: 'demand' }
    const r = resolveRunIdLocalOnly('bug', marker)
    expect(r.resolvedBy).toBe('placeholder')
    expect(r.runId).not.toBe(marker.runId)
    expect(r.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('marker 完全不可用（runId=null）→ 鑄 placeholder', () => {
    const r = resolveRunIdLocalOnly('demand', { runId: null, kind: null })
    expect(r.resolvedBy).toBe('placeholder')
    expect(r.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
