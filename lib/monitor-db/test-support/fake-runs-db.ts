// lib/monitor-db/test-support/fake-runs-db.ts — Phase 1.4 結構性測試用的假 DB client。
//
// 不是通用 SQL 引擎：直接以「這條 SQL 字串是 writes.ts 匯出的哪一個常數」來分派
// 行為（`sql === W.W2_UPDATE_SQL` 這種參照相等比較），照 plan 描述的守衛語意在
// 記憶體裡模擬 MySQL 會怎麼做。這樣寫的理由：
//   - writes.ts 的 SQL 常數是我們自己控制、固定不變的字串，參照比較完全可靠；
//   - 目的是驗證 writes.ts 的呼叫邏輯（guard→insert→retry 序列、host 一律用
//     MON_HOST、matched/changed 的判讀、冷路徑分類），而不是重新驗證 MySQL
//     本身的 UPDATE/ODKU 語意——那部分交給 semantic-verify.test.ts 對真實
//     mon-mysql 實測（S1-S11）。
//   - 這正是 §9 Phase 1.4 要求的「注入假 client，斷言呼叫序列」精神
//     （不用 sleep/計時，用可控的假依賴讓並行/競態情境變成確定性測試）。
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import * as W from '../writes.ts'
import type { MonitorDbExecutor } from '../writes.ts'

export interface FakeRunRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  lifecycle_rank: number
  started_at: string | null
  pid: number | null
  stdout_path: string | null
  trigger_source: string | null
  retry_of_run_id: string | null
  dispatch_id: string | null
  legacy_key: string | null
  outcome: string | null
  outcome_tier: number | null
  outcome_source: string | null
  finished_at: string | null
  exit_code: number | null
  cancel_requested_at: string | null
  cancel_resolved_by: string | null
}

class DupEntryError extends Error {
  code = 'ER_DUP_ENTRY'
}

function okHeader(affectedRows: number, extra: Partial<ResultSetHeader> = {}): ResultSetHeader {
  return { affectedRows, fieldCount: 0, insertId: 0, info: '', serverStatus: 0, warningStatus: 0, ...extra } as ResultSetHeader
}

function updateHeader(matched: number, changed: number, warnings = 0): ResultSetHeader {
  // mysql2 的 ResultSetHeader 型別把 constructor 宣告成字面量,純物件字面量對不上,需顯式轉型。
  return okHeader(matched, { info: `Rows matched: ${matched}  Changed: ${changed}  Warnings: ${warnings}` } as Partial<ResultSetHeader>)
}

/**
 * 記憶體版 `runs` 表，照 writes.ts 的守衛語意模擬。
 * `calls` 記錄每一次 execute 呼叫（sql 參照 + params），供測試斷言呼叫序列
 * （例如「query() 從未被 await」一類的測試可以檢查呼叫是否真的發生過）。
 */
export class FakeRunsDb implements MonitorDbExecutor {
  rows = new Map<string, FakeRunRow>()
  calls: Array<{ sql: string; params: unknown[] }> = []

  async execute<T = ResultSetHeader>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    this.calls.push({ sql, params })

    if (sql === W.W1_SQL) return [this.handleW1(params) as unknown as T, []]
    if (sql === W.RUNS_COLD_PATH_W1_SQL) return [this.selectRows(params[0] as string, ['host', 'lifecycle_rank']) as unknown as T, []]

    if (sql === W.W2_UPDATE_SQL) return [this.handleW2Update(params) as unknown as T, []]
    if (sql === W.W2_INSERT_SQL) return [this.handleInsertFull(params, 'w2') as unknown as T, []]
    if (sql === W.RUNS_PRE_READ_TIER_SQL) return [this.selectRows(params[0] as string, ['outcome_tier'], params[1] as string) as unknown as T, []]
    if (sql === W.RUNS_COLD_PATH_TERMINAL_SQL) return [this.selectRows(params[0] as string, ['host', 'outcome', 'outcome_tier']) as unknown as T, []]

    if (sql === W.W3_UPDATE_SQL) return [this.handleW3Update(params) as unknown as T, []]
    if (sql === W.W3_INSERT_SQL) return [this.handleInsertFull(params, 'w3') as unknown as T, []]

    if (sql === W.W4A_SQL) return [this.handleW4a(params) as unknown as T, []]
    if (sql === W.W4B_INSERT_SQL) return [this.handleInsertFull(params, 'w4b') as unknown as T, []]

    if (sql === W.W5_SQL) return [this.handleW5(params) as unknown as T, []]

    throw new Error(`FakeRunsDb: 未預期的 SQL（沒有對應的 handler）：${sql}`)
  }

  private blank(runId: string, host: string, ticket: string, kind: string, rank: number): FakeRunRow {
    return {
      run_id: runId,
      host,
      ticket,
      kind,
      lifecycle_rank: rank,
      started_at: null,
      pid: null,
      stdout_path: null,
      trigger_source: null,
      retry_of_run_id: null,
      dispatch_id: null,
      legacy_key: null,
      outcome: null,
      outcome_tier: null,
      outcome_source: null,
      finished_at: null,
      exit_code: null,
      cancel_requested_at: null,
      cancel_resolved_by: null,
    }
  }

  private selectRows(runId: string, cols: string[], hostFilter?: string): RowDataPacket[] {
    const row = this.rows.get(runId)
    if (!row) return [] as unknown as RowDataPacket[]
    if (hostFilter !== undefined && row.host !== hostFilter) return [] as unknown as RowDataPacket[]
    const projected: Record<string, unknown> = {}
    for (const c of cols) projected[c] = (row as unknown as Record<string, unknown>)[c]
    return [projected] as unknown as RowDataPacket[]
  }

  // W1：INSERT … ON DUPLICATE KEY UPDATE（形狀 A）
  private handleW1(params: unknown[]): ResultSetHeader {
    const [runId, host, ticket, kind, rank, startedAt, pid, stdoutPath, triggerSource, retryOfRunId, dispatchId, legacyKey] = params as [
      string,
      string,
      string,
      string,
      number,
      string | null,
      number | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
    const existing = this.rows.get(runId)
    if (!existing) {
      this.rows.set(runId, {
        ...this.blank(runId, host, ticket, kind, rank),
        started_at: startedAt,
        pid,
        stdout_path: stdoutPath,
        trigger_source: triggerSource,
        retry_of_run_id: retryOfRunId,
        dispatch_id: dispatchId,
        legacy_key: legacyKey,
      })
      return okHeader(1)
    }
    if (existing.host !== host) {
      // host 不符：全部欄位維持原值 → 無變更。
      return okHeader(0)
    }
    const before = JSON.stringify(existing)
    existing.lifecycle_rank = Math.max(existing.lifecycle_rank, rank)
    existing.started_at = existing.started_at ?? startedAt
    existing.pid = existing.pid ?? pid
    existing.stdout_path = existing.stdout_path ?? stdoutPath
    existing.trigger_source = existing.trigger_source ?? triggerSource
    existing.retry_of_run_id = existing.retry_of_run_id ?? retryOfRunId
    existing.dispatch_id = existing.dispatch_id ?? dispatchId
    existing.legacy_key = existing.legacy_key ?? legacyKey
    const changed = JSON.stringify(existing) !== before
    return okHeader(changed ? 2 : 0)
  }

  // W2：守衛式 UPDATE（tier 2，cancel 合成）
  private handleW2Update(params: unknown[]): ResultSetHeader {
    const [rawOutcome, , outcomeSource, finishedAt, exitCode, runId, host] = params as [
      string,
      string,
      string,
      string,
      number | null,
      string,
      string,
    ]
    const row = this.rows.get(runId)
    if (!row || row.host !== host) return updateHeader(0, 0)
    if (!(row.outcome === null || (row.outcome_tier ?? 2) < 2)) return updateHeader(0, 0)
    const before = JSON.stringify(row)
    const synthesized = row.cancel_requested_at !== null && rawOutcome === 'infra_failure' ? 'cancelled' : rawOutcome
    row.outcome = synthesized
    row.outcome_tier = 2
    row.outcome_source = outcomeSource
    row.finished_at = finishedAt
    row.exit_code = exitCode
    row.lifecycle_rank = 100
    const changed = JSON.stringify(row) !== before
    return updateHeader(1, changed ? 1 : 0)
  }

  // W3：守衛式 UPDATE（tier 1）
  private handleW3Update(params: unknown[]): ResultSetHeader {
    const [outcome, outcomeSource, finishedAt, runId, host] = params as [string, string, string, string, string]
    const row = this.rows.get(runId)
    if (!row || row.host !== host) return updateHeader(0, 0)
    if (row.outcome !== null) return updateHeader(0, 0)
    row.outcome = outcome
    row.outcome_tier = 1
    row.outcome_source = outcomeSource
    row.finished_at = finishedAt
    row.lifecycle_rank = 100
    return updateHeader(1, 1)
  }

  // W4a：cancel 旗標守衛式 UPDATE（無 outcome guard，只有 run_id+host）
  private handleW4a(params: unknown[]): ResultSetHeader {
    const [cancelRequestedAt, resolvedBy, runId, host] = params as [string, string, string, string]
    const row = this.rows.get(runId)
    if (!row || row.host !== host) return updateHeader(0, 0)
    const before = JSON.stringify(row)
    row.cancel_requested_at = row.cancel_requested_at ?? cancelRequestedAt
    row.cancel_resolved_by = row.cancel_resolved_by ?? resolvedBy
    const changed = JSON.stringify(row) !== before
    return updateHeader(1, changed ? 1 : 0)
  }

  // W5：cancel 遲到修正
  private handleW5(params: unknown[]): ResultSetHeader {
    const [runId, host] = params as [string, string]
    const row = this.rows.get(runId)
    if (!row || row.host !== host) return updateHeader(0, 0)
    if (!(row.cancel_requested_at !== null && row.outcome === 'infra_failure')) return updateHeader(0, 0)
    row.outcome = 'cancelled'
    row.outcome_source = 'cancel_late_fix'
    return updateHeader(1, 1)
  }

  // W2/W3/W4b 共用的完整 INSERT（依 sql 常數識別是哪一種佔位/終態 INSERT）
  private handleInsertFull(params: unknown[], variant: 'w2' | 'w3' | 'w4b'): ResultSetHeader {
    let runId: string
    let host: string
    if (variant === 'w2') {
      const [rId, h, ticket, kind, outcome, outcomeSource, finishedAt, exitCode] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number | null,
      ]
      runId = rId
      host = h
      if (this.rows.has(runId)) throw new DupEntryError('duplicate run_id')
      this.rows.set(runId, {
        ...this.blank(runId, host, ticket, kind, 100),
        outcome,
        outcome_tier: 2,
        outcome_source: outcomeSource,
        finished_at: finishedAt,
        exit_code: exitCode,
      })
    } else if (variant === 'w3') {
      const [rId, h, ticket, kind, outcome, outcomeSource, finishedAt] = params as [string, string, string, string, string, string, string]
      runId = rId
      host = h
      if (this.rows.has(runId)) throw new DupEntryError('duplicate run_id')
      this.rows.set(runId, {
        ...this.blank(runId, host, ticket, kind, 100),
        outcome,
        outcome_tier: 1,
        outcome_source: outcomeSource,
        finished_at: finishedAt,
      })
    } else {
      const [rId, h, ticket, kind, cancelRequestedAt, resolvedBy, legacyKey] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
      ]
      runId = rId
      host = h
      if (this.rows.has(runId)) throw new DupEntryError('duplicate run_id')
      this.rows.set(runId, {
        ...this.blank(runId, host, ticket, kind, 10),
        cancel_requested_at: cancelRequestedAt,
        cancel_resolved_by: resolvedBy,
        legacy_key: legacyKey,
      })
    }
    return okHeader(1)
  }
}
