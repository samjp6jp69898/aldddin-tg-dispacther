// lib/monitor-db/local-sweep.test.ts — §5.6 lost_on_restart ／ §6.6 本機
// sweeper 結構性測試（不打真實 DB，注入假 pool + 假依賴）。
import { describe, expect, test } from 'bun:test'
import { sweepDeadLocalRuns, sweepLostOnRestart, RUNNING_ROWS_SQL, RUNNING_ROWS_BY_TICKET_SQL, QUEUED_ROWS_SQL, type LocalSweepDeps } from './local-sweep.ts'
import { MON_HOST } from './env.ts'
import type { MonitorDbExecutor } from './writes.ts'

interface FakeRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  lifecycle_rank: number
  outcome: string | null
  outcome_tier: number | null
  pid: number | null
}

class FakeSweepDb implements MonitorDbExecutor {
  rows: FakeRow[] = []
  updateCalls: Array<{ runId: string; outcome: string }> = []

  async execute<T = unknown>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    if (sql === RUNNING_ROWS_SQL || sql === RUNNING_ROWS_BY_TICKET_SQL) {
      const host = params[0] as string
      const ticket = sql === RUNNING_ROWS_BY_TICKET_SQL ? (params[1] as string) : null
      const matched = this.rows.filter(r => r.host === host && r.lifecycle_rank === 30 && r.outcome === null && (ticket === null || r.ticket === ticket))
      return [matched.map(r => ({ run_id: r.run_id, ticket: r.ticket, kind: r.kind, pid: r.pid })) as unknown as T, []]
    }
    if (sql === QUEUED_ROWS_SQL) {
      const host = params[0] as string
      const matched = this.rows.filter(r => r.host === host && r.lifecycle_rank === 10 && r.outcome === null)
      return [matched.map(r => ({ run_id: r.run_id, ticket: r.ticket, kind: r.kind })) as unknown as T, []]
    }
    // W3（writeRunOutcomeProvisional）的 UPDATE：守衛式，只有 outcome IS NULL 才成立。
    if (sql.startsWith('UPDATE runs')) {
      const [outcome, , , runId, host] = params as [string, string, string, string, string]
      const row = this.rows.find(r => r.run_id === runId && r.host === host)
      if (!row || row.outcome !== null) return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' } as unknown as T, []]
      row.outcome = outcome
      row.outcome_tier = 1
      this.updateCalls.push({ runId, outcome })
      return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' } as unknown as T, []]
    }
    throw new Error(`FakeSweepDb: 未預期的 SQL：${sql}`)
  }
}

function makeRow(overrides: Partial<FakeRow> & { run_id: string }): FakeRow {
  return { host: MON_HOST, ticket: 'FAQ-1', kind: 'bug', lifecycle_rank: 30, outcome: null, outcome_tier: null, pid: null, ...overrides }
}

describe('sweepDeadLocalRuns（§6.6）', () => {
  test('pid IS NULL 立刻寫 unknown_no_writer（MN-C8(b)），不需要 ps/local-activity 判定', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-1', pid: null }))
    const deps: LocalSweepDeps = { isPidAlive: () => true, isTicketActive: () => true } // 就算兩者都回 true 也不影響 pid IS NULL 分支
    const result = await sweepDeadLocalRuns(db, deps)
    expect(result.swept).toEqual([{ runId: 'run-1', ticket: 'FAQ-1', outcome: 'unknown_no_writer' }])
    expect(db.rows[0]!.outcome).toBe('unknown_no_writer')
  })

  test('pid 還活著 → 跳過，不寫任何東西', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-1', pid: 100 }))
    const deps: LocalSweepDeps = { isPidAlive: () => true, isTicketActive: () => false }
    const result = await sweepDeadLocalRuns(db, deps)
    expect(result.swept).toEqual([])
    expect(db.rows[0]!.outcome).toBeNull()
  })

  test('pid 死了、但 local-activity 認定整票仍有活動 → 保守跳過', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-1', pid: 100 }))
    const deps: LocalSweepDeps = { isPidAlive: () => false, isTicketActive: () => true }
    const result = await sweepDeadLocalRuns(db, deps)
    expect(result.swept).toEqual([])
    expect(db.rows[0]!.outcome).toBeNull()
  })

  test('pid 死了、local-activity 也確認無活動 → 寫 tier1（預設 unknown_no_writer）', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-1', pid: 100 }))
    const deps: LocalSweepDeps = { isPidAlive: () => false, isTicketActive: () => false }
    const result = await sweepDeadLocalRuns(db, deps)
    expect(result.swept).toEqual([{ runId: 'run-1', ticket: 'FAQ-1', outcome: 'unknown_no_writer' }])
    expect(db.rows[0]!.outcome_tier).toBe(1)
  })

  test('reaper 用法：限定 ticket + reason=unknown_reaped', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-1', ticket: 'FAQ-1', pid: 100 }))
    db.rows.push(makeRow({ run_id: 'run-2', ticket: 'FAQ-2', pid: 200 })) // 別的票，不該被碰
    const deps: LocalSweepDeps = { isPidAlive: () => false, isTicketActive: () => false }
    const result = await sweepDeadLocalRuns(db, deps, { ticket: 'FAQ-1', reason: 'unknown_reaped' })
    expect(result.swept).toEqual([{ runId: 'run-1', ticket: 'FAQ-1', outcome: 'unknown_reaped' }])
    expect(db.rows.find(r => r.run_id === 'run-2')!.outcome).toBeNull() // 別的票完全不動
  })

  test('降噪：hasPendingSpoolEntry 回 true 的 run_id 本輪跳過', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-1', pid: 100 }))
    const deps: LocalSweepDeps = { isPidAlive: () => false, isTicketActive: () => false, hasPendingSpoolEntry: () => true }
    const result = await sweepDeadLocalRuns(db, deps)
    expect(result.swept).toEqual([])
  })

  test('R1：只掃本機（host=MON_HOST）的列，不跨 host', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-other-host', host: 'some-other-host', pid: 100 }))
    const deps: LocalSweepDeps = { isPidAlive: () => false, isTicketActive: () => false }
    const result = await sweepDeadLocalRuns(db, deps)
    expect(result.swept).toEqual([])
  })
})

describe('sweepLostOnRestart（§5.6，BL-C5）', () => {
  test('run_id 不在 seen 集合裡 → 寫 lost_on_restart（tier1）', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-orphan', lifecycle_rank: 10 }))
    const result = await sweepLostOnRestart(db, new Set())
    expect(result.swept).toEqual([{ runId: 'run-orphan', ticket: 'FAQ-1', outcome: 'lost_on_restart' }])
    expect(db.rows[0]!.outcome).toBe('lost_on_restart')
  })

  test('BL-C5 核心：剛 spawn 成功、在 started 集合裡的 run 不會被誤殺', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-just-started', lifecycle_rank: 10 })) // 就算 rank 還沒升到 30 也一樣
    const result = await sweepLostOnRestart(db, new Set(['run-just-started']))
    expect(result.swept).toEqual([])
    expect(db.rows[0]!.outcome).toBeNull()
  })

  test('seen 為空集合（快照不存在）時照跑，不是跳過整個 sweep', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-a', lifecycle_rank: 10 }))
    db.rows.push(makeRow({ run_id: 'run-b', lifecycle_rank: 10 }))
    const result = await sweepLostOnRestart(db, new Set())
    expect(result.swept.map(s => s.runId).sort()).toEqual(['run-a', 'run-b'])
  })

  test('順序無關、可重跑：同一批列重跑是欄位級 no-op（outcome IS NULL 守衛）', async () => {
    const db = new FakeSweepDb()
    db.rows.push(makeRow({ run_id: 'run-a', lifecycle_rank: 10 }))
    await sweepLostOnRestart(db, new Set())
    const first = db.rows[0]!.outcome
    const result2 = await sweepLostOnRestart(db, new Set())
    expect(result2.swept).toEqual([]) // 已有終態的列不會被 QUEUED_ROWS_SQL 選中（outcome IS NULL 已不成立）
    expect(db.rows[0]!.outcome).toBe(first)
  })
})
