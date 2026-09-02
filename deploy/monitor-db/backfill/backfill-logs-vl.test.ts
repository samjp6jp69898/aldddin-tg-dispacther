// backfill/backfill-logs-vl.test.ts — 主腳本單元測試（禁 sleep；不需要真實 VL，全用假 fetch）。
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runBackfill,
  parseLogFilename,
  isoRawToIsoString,
  buildEntry,
  batchLines,
  loadManifest,
  MAX_LINE_BYTES,
  MAX_BATCH_BYTES,
  RETENTION_MS,
  LOG_BACKFILL_HOST,
  type FetchFn,
} from './backfill-logs-vl.ts'

const FIXTURES_PIPELINE_DIR = join(import.meta.dir, '__fixtures__/logs/pipeline')
const FIXTURES_MCPS_DIR = join(import.meta.dir, '__fixtures__/logs/mcps')
const NONEXISTENT_ENV_FILE = '/nonexistent/backfill-test.env'

const FIXTURE_SECRETS = [
  'FakeSecret123',
  'AnotherFakeSecret456',
  'ghp_FakeGithubToken123456',
  'ntn_FakeNotionToken123',
  'FakePassword789',
]

interface FakeCall {
  url: string
  init: RequestInit
}

function makeFakeFetch(status = 200): { fn: FetchFn; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    return {
      ok: status >= 200 && status < 300,
      status,
    } as unknown as Response
  }) as FetchFn
  return { fn, calls }
}

// process.env.MON_VL_* 存/還原（避免測試互相污染、避免誤讀真實 .env）。
const ENV_KEYS = ['MON_VL_URL', 'MON_VL_USER', 'MON_VL_PASSWORD'] as const
const savedEnv: Record<string, string | undefined> = {}
function setTestEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.MON_VL_URL = 'http://vl.test.local:9428'
  process.env.MON_VL_USER = 'testuser'
  process.env.MON_VL_PASSWORD = 'testpass'
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

afterEach(() => {
  restoreEnv()
})

// 2026-01-15：晚於全部 fixture ISO/ts 時戳（2026-01-01 ~ 01-03）不到 90 天 → 全部在 retention 內。
const NOW_WITHIN_RETENTION = Date.parse('2026-01-15T00:00:00Z')
// 2026-06-01：晚於 fixture ISO/ts 時戳超過 90 天 → 那些行應被 retention 跳過（bootstrap.log／broken-ts 行走 mtime 不受影響）。
const NOW_BEYOND_RETENTION = Date.parse('2026-06-01T00:00:00Z')

describe('parseLogFilename', () => {
  test('bug pipeline stdout/stderr', () => {
    expect(parseLogFilename('FAQ-3096.2026-09-01T07-05-02-406Z.stdout.log')).toEqual({
      ticket: 'FAQ-3096',
      kind: 'bug',
      isoRaw: '2026-09-01T07-05-02-406Z',
    })
    expect(parseLogFilename('FAQ-3096.2026-09-01T07-05-02-406Z.stderr.log')).toEqual({
      ticket: 'FAQ-3096',
      kind: 'bug',
      isoRaw: '2026-09-01T07-05-02-406Z',
    })
  })

  test('demand pipeline stdout/stderr', () => {
    expect(parseLogFilename('ALDREQ-765.2026-08-21T01-23-16-901Z.demand-pipeline.stdout.log')).toEqual({
      ticket: 'ALDREQ-765',
      kind: 'demand',
      isoRaw: '2026-08-21T01-23-16-901Z',
    })
  })

  test('雜項 .log（無 ISO）解不出 ticket/kind/isoRaw', () => {
    expect(parseLogFilename('FAQ-3096.bootstrap.log')).toEqual({})
    expect(parseLogFilename('demand-pipeline.log')).toEqual({})
    expect(parseLogFilename('cleanup-worktree.log')).toEqual({})
  })
})

describe('isoRawToIsoString', () => {
  test('轉換為標準 ISO 8601', () => {
    expect(isoRawToIsoString('2026-09-01T07-05-02-406Z')).toBe('2026-09-01T07:05:02.406Z')
  })

  test('格式不符時丟例外', () => {
    expect(() => isoRawToIsoString('garbage')).toThrow()
  })
})

describe('batchLines', () => {
  test('小於上限時全部併一批', () => {
    const lines = ['a', 'b', 'c']
    expect(batchLines(lines, 1024)).toEqual([['a', 'b', 'c']])
  })

  test('超過上限時切成多批', () => {
    const line = 'x'.repeat(100) // 101 bytes（含換行）
    const lines = Array.from({ length: 10 }, () => line)
    const batches = batchLines(lines, 250) // 每批最多 2 行（202 bytes < 250, 3 行=303>250）
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches) {
      const bytes = b.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0)
      expect(bytes).toBeLessThanOrEqual(250)
    }
    expect(batches.flat()).toEqual(lines)
  })

  test('單行本身超過上限時自成一批', () => {
    const huge = 'y'.repeat(2000)
    const lines = ['short1', huge, 'short2']
    const batches = batchLines(lines, 500)
    expect(batches).toEqual([['short1'], [huge], ['short2']])
  })
})

describe('buildEntry', () => {
  test('一般行：遮罩後整行照送', () => {
    const entry = buildEntry({
      timeMs: Date.parse('2026-01-01T00:00:00.000Z'),
      rawLine: 'MYSQL_PWD=secret123',
      source: '/x/y.log',
      ticket: 'FAQ-1',
      kind: 'bug',
      runId: 'run-id-1',
      offset: 0,
    })
    expect(entry._time).toBe('2026-01-01T00:00:00.000Z')
    expect(entry._msg).toBe('MYSQL_PWD=[REDACTED]')
    expect(entry.host).toBe('head')
    expect(entry.host).toBe(LOG_BACKFILL_HOST)
    expect(entry.source).toBe('/x/y.log')
    expect(entry.ticket).toBe('FAQ-1')
    expect(entry.kind).toBe('bug')
    expect(entry.run_id).toBe('run-id-1')
  })

  test('空欄位（無 ticket/kind/run_id）不出現在物件上', () => {
    const entry = buildEntry({ timeMs: 0, rawLine: 'hello', source: '/x.log', offset: 0 })
    expect('ticket' in entry).toBe(false)
    expect('kind' in entry).toBe(false)
    expect('run_id' in entry).toBe(false)
  })

  test('超過 2MB 的行改送 truncated 物件，head/tail 已遮罩', () => {
    const secretHead = 'MYSQL_PWD=headSecret999 '
    const secretTail = ' MYSQL_PWD=tailSecret888'
    const filler = 'z'.repeat(MAX_LINE_BYTES + 100)
    const rawLine = secretHead + filler + secretTail
    expect(Buffer.byteLength(rawLine, 'utf8')).toBeGreaterThan(MAX_LINE_BYTES)

    const entry = buildEntry({ timeMs: 123, rawLine, source: '/big.log', offset: 42 })
    const payload = JSON.parse(entry._msg) as Record<string, unknown>
    expect(payload.truncated).toBe(true)
    expect(payload.orig_bytes).toBe(Buffer.byteLength(rawLine, 'utf8'))
    expect(payload.file).toBe('/big.log')
    expect(payload.offset).toBe(42)
    expect(payload.host).toBe('head')
    expect(typeof payload.head_4k).toBe('string')
    expect(typeof payload.tail_4k).toBe('string')
    expect(payload.head_4k as string).toContain('[REDACTED]')
    expect(payload.head_4k as string).not.toContain('headSecret999')
    expect(payload.tail_4k as string).toContain('[REDACTED]')
    expect(payload.tail_4k as string).not.toContain('tailSecret888')
  })
})

describe('runBackfill --dry-run（不發 HTTP）', () => {
  test('對 fixtures 目錄跑通，統計正確，且不呼叫 fetch', async () => {
    setTestEnv()
    const { fn, calls } = makeFakeFetch()
    const reports = await runBackfill({
      dryRun: true,
      envFile: NONEXISTENT_ENV_FILE,
      logsDir: FIXTURES_PIPELINE_DIR,
      mcpsDir: FIXTURES_MCPS_DIR,
      fetchImpl: fn,
      now: NOW_WITHIN_RETENTION,
    })
    expect(calls.length).toBe(0)
    expect(reports.length).toBe(2)
    const [pipeline, audit] = reports

    // pipeline: FAQ-1234 stdout(3) + ALDREQ-1 demand stdout(2) + FAQ-1234.bootstrap.log(2) = 7；
    // active-pipelines/ 子目錄與 note.json 不應被收集。
    expect(pipeline!.sourceRows).toBe(7)
    expect(pipeline!.attempted).toBe(7)
    expect(pipeline!.inserted).toBe(0)
    expect(pipeline!.ignored).toBe(0)
    expect(pipeline!.skipped).toBe(0)
    expect(pipeline!.dryRun).toBe(true)

    // audit: admin(2) + platform(1) + toolsmith(1) = 4
    expect(audit!.sourceRows).toBe(4)
    expect(audit!.attempted).toBe(4)
    expect(audit!.inserted).toBe(0)
    expect(audit!.dryRun).toBe(true)
  })

  test('retention 早於 90 天的行被主動跳過並列入報告', async () => {
    setTestEnv()
    const { fn } = makeFakeFetch()
    const [pipeline, audit] = await runBackfill({
      dryRun: true,
      envFile: NONEXISTENT_ENV_FILE,
      logsDir: FIXTURES_PIPELINE_DIR,
      mcpsDir: FIXTURES_MCPS_DIR,
      fetchImpl: fn,
      now: NOW_BEYOND_RETENTION,
    })
    // ISO 檔名行（2026-01-01）超出 retention：FAQ-1234 stdout(3) + ALDREQ-1 demand(2) = 5
    // bootstrap.log 用真實 mtime（測試執行當下，遠晚於 NOW_BEYOND_RETENTION）不受影響。
    expect(pipeline!.skipped).toBe(5)
    expect(pipeline!.attempted).toBe(2) // 只剩 bootstrap.log 的 2 行
    expect(pipeline!.notes.some((n) => n.includes('retention'))).toBe(true)

    // audit：admin 的 dated 行(1) + platform(1) + toolsmith(1) 超出 retention = 3；
    // admin 的 broken-ts 行走 mtime，不受影響。
    expect(audit!.skipped).toBe(3)
    expect(audit!.attempted).toBe(1)
  })
})

describe('runBackfill 真送（假 fetch 驗 payload）', () => {
  test('Basic Auth header、_time 格式、遮罩皆已套用，manifest 使重跑略過', async () => {
    setTestEnv()
    const workdir = mkdtempSync(join(tmpdir(), 'backfill-logs-vl-test-'))
    const { fn, calls } = makeFakeFetch(200)

    const reports1 = await runBackfill({
      dryRun: false,
      envFile: NONEXISTENT_ENV_FILE,
      logsDir: FIXTURES_PIPELINE_DIR,
      mcpsDir: FIXTURES_MCPS_DIR,
      workdir,
      fetchImpl: fn,
      now: NOW_WITHIN_RETENTION,
    })
    const [pipeline1, audit1] = reports1
    expect(pipeline1!.inserted).toBe(7)
    expect(pipeline1!.ignored).toBe(0)
    expect(audit1!.inserted).toBe(4)
    expect(audit1!.ignored).toBe(0)
    expect(calls.length).toBeGreaterThan(0)

    const allEntries: Record<string, unknown>[] = []
    for (const call of calls) {
      expect(call.url).toBe('http://vl.test.local:9428/insert/jsonline')
      const headers = call.init.headers as Record<string, string>
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('testuser:testpass').toString('base64')}`)
      const body = call.init.body as string
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_BATCH_BYTES + 1024) // 允許極小誤差
      for (const line of body.trim().split('\n')) {
        allEntries.push(JSON.parse(line))
      }
    }

    expect(allEntries.length).toBe(11) // 7 pipeline + 4 audit

    for (const entry of allEntries) {
      expect(entry.host).toBe('head')
      expect(typeof entry._time).toBe('string')
      expect(() => new Date(entry._time as string).toISOString()).not.toThrow()
      const msg = JSON.stringify(entry)
      for (const secret of FIXTURE_SECRETS) {
        expect(msg).not.toContain(secret)
      }
    }

    // ticket/kind/run_id 只出現在 ISO 檔名的 pipeline 行上
    const withTicket = allEntries.filter((e) => 'ticket' in e)
    expect(withTicket.length).toBe(5) // FAQ-1234 stdout(3) + ALDREQ-1 demand(2)
    expect(withTicket.every((e) => typeof e.run_id === 'string')).toBe(true)
    const demandEntries = withTicket.filter((e) => e.kind === 'demand')
    expect(demandEntries.length).toBe(2)

    // manifest 已寫入
    const manifest = loadManifest(workdir)
    expect(Object.keys(manifest).length).toBeGreaterThan(0)

    // 重跑：同一 workdir + 同一檔案（inode/size 未變）應整檔略過，不再呼叫 fetch。
    const { fn: fn2, calls: calls2 } = makeFakeFetch(200)
    const reports2 = await runBackfill({
      dryRun: false,
      envFile: NONEXISTENT_ENV_FILE,
      logsDir: FIXTURES_PIPELINE_DIR,
      mcpsDir: FIXTURES_MCPS_DIR,
      workdir,
      fetchImpl: fn2,
      now: NOW_WITHIN_RETENTION,
    })
    const [pipeline2, audit2] = reports2
    expect(calls2.length).toBe(0)
    expect(pipeline2!.inserted).toBe(0)
    expect(pipeline2!.ignored).toBe(7)
    expect(audit2!.inserted).toBe(0)
    expect(audit2!.ignored).toBe(4)
  })

  test('HTTP 非 2xx：該檔中止、記入報告，且不寫 manifest（下次整檔重試）', async () => {
    setTestEnv()
    const workdir = mkdtempSync(join(tmpdir(), 'backfill-logs-vl-test-fail-'))
    const { fn } = makeFakeFetch(500)

    const [pipeline] = await runBackfill({
      dryRun: false,
      envFile: NONEXISTENT_ENV_FILE,
      logsDir: FIXTURES_PIPELINE_DIR,
      mcpsDir: FIXTURES_MCPS_DIR,
      workdir,
      fetchImpl: fn,
      now: NOW_WITHIN_RETENTION,
    })
    expect(pipeline!.inserted).toBe(0)
    expect(pipeline!.skipped).toBe(7) // 全部因中止而未送
    expect(pipeline!.notes.some((n) => n.includes('HTTP 500'))).toBe(true)

    const manifest = loadManifest(workdir)
    expect(Object.keys(manifest).length).toBe(0) // 失敗的檔案不寫 manifest
  })
})

describe('README 檔名範例（真實命名慣例的迴歸測試）', () => {
  test('run_id 與 lib/run-id.ts 既有測試向量一致', async () => {
    setTestEnv()
    const workdir = mkdtempSync(join(tmpdir(), 'backfill-logs-vl-test-runid-'))
    const dir = mkdtempSync(join(tmpdir(), 'backfill-logs-vl-fixture-'))
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'FAQ-3096.2026-09-01T07-05-02-406Z.stdout.log'), 'hello\n')
    const { fn, calls } = makeFakeFetch(200)
    await runBackfill({
      dryRun: false,
      envFile: NONEXISTENT_ENV_FILE,
      logsDir: dir,
      mcpsDir: join(dir, 'nonexistent-mcps'),
      workdir,
      fetchImpl: fn,
      now: Date.parse('2026-09-02T00:00:00Z'),
    })
    expect(calls.length).toBe(1)
    const body = calls[0]!.init.body as string
    const entry = JSON.parse(body.trim())
    // 與 lib/lib.test.ts 的 deriveRunId('FAQ-3096.2026-09-01T07-05-02-406Z') 為同一輸入。
    const { deriveRunId } = await import('./lib/run-id.ts')
    expect(entry.run_id).toBe(deriveRunId('FAQ-3096.2026-09-01T07-05-02-406Z'))
  })
})
