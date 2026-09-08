import { describe, expect, test } from 'bun:test'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'
import { HISTORY_MAX_LIMIT, mysqlDatetimeToIso, readActiveRuns, readFinishedRuns } from './runs-read.ts'

function fakePool(rowsBySql: (sql: string, params: unknown[]) => unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = []
  const pool: MonitorDbExecutor = {
    async execute<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      return [rowsBySql(sql, params) as T, undefined] as [T, unknown]
    },
  }
  return { pool, calls }
}

const RAW = {
  run_id: 'r1',
  host: 'head',
  ticket: 'FAQ-4905',
  kind: 'bug',
  lifecycle: 'finished',
  outcome: 'failed',
  outcome_tier: 2,
  started_at: '2026-09-08 03:26:28.030',
  finished_at: '2026-09-08 03:53:59.668',
  created_at: '2026-09-08 03:26:28.000',
  trigger_source: 'telegram',
  triggered_by_email: 'a@b.c',
  triggered_by_name: 'Ting-xuan TPE',
  retry_of_run_id: null,
  exit_code: 1,
}

describe('mysqlDatetimeToIso', () => {
  test('dateStrings 格式 → ISO UTC；毫秒缺省補 .000；壞值回 null', () => {
    expect(mysqlDatetimeToIso('2026-09-08 03:26:28.030')).toBe('2026-09-08T03:26:28.030Z')
    expect(mysqlDatetimeToIso('2026-09-08 03:26:28')).toBe('2026-09-08T03:26:28.000Z')
    expect(mysqlDatetimeToIso(null)).toBeNull()
    expect(mysqlDatetimeToIso('garbage')).toBeNull()
  })
})

describe('readActiveRuns', () => {
  test('只查未終態，回傳型別正規化', async () => {
    const { pool, calls } = fakePool(() => [{ ...RAW, lifecycle: 'running', outcome: null, finished_at: null }])
    const rows = await readActiveRuns(pool)
    expect(calls[0]!.sql).toContain('lifecycle_rank < 100')
    expect(rows[0]).toMatchObject({ runId: 'r1', lifecycle: 'running', outcome: null, finishedAt: null, startedAt: '2026-09-08T03:26:28.030Z' })
  })
})

describe('readFinishedRuns', () => {
  test('預設 limit 50 / offset 0，只查終態，COUNT 走同一組 where', async () => {
    const { pool, calls } = fakePool(sql => (sql.startsWith('SELECT COUNT') ? [{ n: 89 }] : [RAW]))
    const r = await readFinishedRuns(pool, {})
    expect(r.total).toBe(89)
    expect(r.limit).toBe(50)
    expect(r.offset).toBe(0)
    expect(calls[0]!.sql).toContain('lifecycle_rank = 100')
    expect(calls[0]!.sql).toContain('LIMIT 50 OFFSET 0')
    expect(calls[1]!.sql).toContain('COUNT(*)')
    expect(r.rows[0]).toMatchObject({ ticket: 'FAQ-4905', outcome: 'failed', outcomeTier: 2, exitCode: 1, triggeredByName: 'Ting-xuan TPE' })
  })
  test('limit 夾在 1..HISTORY_MAX_LIMIT，非整數退回預設；offset 不可負', async () => {
    const { pool, calls } = fakePool(sql => (sql.startsWith('SELECT COUNT') ? [{ n: 0 }] : []))
    await readFinishedRuns(pool, { limit: 99999, offset: -5 })
    expect(calls[0]!.sql).toContain(`LIMIT ${HISTORY_MAX_LIMIT} OFFSET 0`)
    await readFinishedRuns(pool, { limit: Number.NaN })
    expect(calls[2]!.sql).toContain('LIMIT 50 OFFSET 0')
  })
  test('ticket 走 LIKE 參數（跳脫 % _）、kind 只認 bug/demand、outcome 精確比對', async () => {
    const { pool, calls } = fakePool(sql => (sql.startsWith('SELECT COUNT') ? [{ n: 0 }] : []))
    await readFinishedRuns(pool, { ticket: 'FAQ-49%', kind: 'bug', outcome: 'success' })
    expect(calls[0]!.sql).toContain('ticket LIKE ?')
    expect(calls[0]!.sql).toContain('kind = ?')
    expect(calls[0]!.sql).toContain('outcome = ?')
    expect(calls[0]!.params).toEqual(['%FAQ-49\\%%', 'bug', 'success'])
    await readFinishedRuns(pool, { kind: 'evil' })
    expect(calls[2]!.sql).not.toContain('kind = ?')
  })
  test('triggeredByEmail 過濾：隱私邊界（2026-09-08），有帶就限定 triggered_by_email = ?，不帶就不限定', async () => {
    const { pool, calls } = fakePool(sql => (sql.startsWith('SELECT COUNT') ? [{ n: 0 }] : []))
    await readFinishedRuns(pool, { triggeredByEmail: 'ming@example.com' })
    expect(calls[0]!.sql).toContain('triggered_by_email = ?')
    expect(calls[0]!.params).toEqual(['ming@example.com'])
    expect(calls[1]!.sql).toContain('triggered_by_email = ?') // COUNT 也要套同一組 where，不能只濾主查詢
    await readFinishedRuns(pool, {})
    expect(calls[2]!.sql).not.toContain('triggered_by_email = ?') // SELECT 欄位清單本身含這個名字，只斷言沒有 WHERE 條件
  })
})
