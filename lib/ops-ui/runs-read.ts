import type { MonitorDbExecutor } from '../monitor-db/writes.ts'
import type { TicketKind } from './notion-tickets.ts'

// ops-ui 的監控 DB 唯讀面（2026-09-08）：只 SELECT `runs`——「處理過的工單」
// 唯一的權威來源（bug_analysis_tracker.md 只有 Bug 且欄位貧乏；logs/ 檔名掃描
// 是 tg-monitor 遷移前的舊做法）。head 行程本來就以 mon_head 連線（有 runs 的
// SELECT），這裡直接沿用 runtime.ts 的長駐 pool，不另建 pool（MN-G7：全案只有
// pool.ts 一個 createPool 呼叫點）。
//
// LIMIT/OFFSET 不走 prepared 參數（mysql2 對整數參數的處理版本相依，tg-monitor
// 的 limitClause 同一個理由）：先在 TS 端夾成安全整數再拼進 SQL 字串。

export type RunRow = {
  runId: string
  host: string
  ticket: string
  kind: TicketKind | string
  lifecycle: 'queued' | 'running' | 'finished' | 'unknown'
  outcome: string | null
  outcomeTier: number | null
  /** ISO 8601（UTC）。pool 以 dateStrings 回 'YYYY-MM-DD HH:MM:SS.mmm'，這裡轉成 ISO。 */
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  triggerSource: string | null
  triggeredByEmail: string | null
  triggeredByName: string | null
  retryOfRunId: string | null
  exitCode: number | null
}

export const HISTORY_MAX_LIMIT = 200
export const ACTIVE_MAX_ROWS = 200

const COLUMNS = `run_id, host, ticket, kind, lifecycle, outcome, outcome_tier, started_at, finished_at, created_at,
  trigger_source, triggered_by_email, triggered_by_name, retry_of_run_id, exit_code`

export function mysqlDatetimeToIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  if (typeof v !== 'string' || v.trim() === '') return null
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(v.trim())
  if (!m) return null
  return `${m[1]}T${m[2]}${m[3] ?? '.000'}Z`
}

function toRow(r: Record<string, unknown>): RunRow {
  const lifecycle = r.lifecycle
  return {
    runId: String(r.run_id),
    host: String(r.host ?? ''),
    ticket: String(r.ticket ?? ''),
    kind: String(r.kind ?? ''),
    lifecycle: lifecycle === 'queued' || lifecycle === 'running' || lifecycle === 'finished' ? lifecycle : 'unknown',
    outcome: typeof r.outcome === 'string' ? r.outcome : null,
    outcomeTier: typeof r.outcome_tier === 'number' ? r.outcome_tier : null,
    startedAt: mysqlDatetimeToIso(r.started_at),
    finishedAt: mysqlDatetimeToIso(r.finished_at),
    createdAt: mysqlDatetimeToIso(r.created_at) ?? '',
    triggerSource: typeof r.trigger_source === 'string' ? r.trigger_source : null,
    triggeredByEmail: typeof r.triggered_by_email === 'string' ? r.triggered_by_email : null,
    triggeredByName: typeof r.triggered_by_name === 'string' ? r.triggered_by_name : null,
    retryOfRunId: typeof r.retry_of_run_id === 'string' ? r.retry_of_run_id : null,
    exitCode: typeof r.exit_code === 'number' ? r.exit_code : null,
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 尚未終態（queued／running）的 run，跨 host。 */
export async function readActiveRuns(pool: MonitorDbExecutor): Promise<RunRow[]> {
  const [rows] = await pool.execute<Record<string, unknown>[]>(
    `SELECT ${COLUMNS} FROM runs WHERE lifecycle_rank < 100 ORDER BY created_at DESC LIMIT ${ACTIVE_MAX_ROWS}`,
    [],
  )
  return rows.map(toRow)
}

export type HistoryQuery = {
  limit?: number
  offset?: number
  ticket?: string
  kind?: string
  outcome?: string
  /**
   * 隱私邊界（2026-09-08，使用者發現「處理過」分頁能看到別人的紀錄後定案）：
   * ops-ui 只讓登入者看自己發起的工單，不比照 tg-monitor（維運用、可看全隊）
   * 或 Notion 候選單（本來就是全隊共用資料）。呼叫端（lib/ops-ui/index.ts 的
   * buildHistory）一律帶入當前登入者的 email；不帶就是舊行為（給未來若真的
   * 需要「全隊」視角的呼叫端保留彈性，但目前唯一呼叫端一定會帶）。
   * 比對用 `=`（欄位 collation 是 utf8mb4_0900_ai_ci，天生大小寫不敏感）。
   */
  triggeredByEmail?: string
}

export async function readFinishedRuns(pool: MonitorDbExecutor, q: HistoryQuery): Promise<{ rows: RunRow[]; total: number; limit: number; offset: number }> {
  const limit = clampInt(q.limit, 1, HISTORY_MAX_LIMIT, 50)
  const offset = clampInt(q.offset, 0, 1_000_000, 0)
  const where: string[] = ['lifecycle_rank = 100']
  const params: unknown[] = []
  const ticket = (q.ticket ?? '').trim()
  if (ticket !== '') {
    where.push('ticket LIKE ?')
    params.push(`%${ticket.replace(/[%_\\]/g, ch => `\\${ch}`)}%`)
  }
  if (q.kind === 'bug' || q.kind === 'demand') {
    where.push('kind = ?')
    params.push(q.kind)
  }
  const outcome = (q.outcome ?? '').trim()
  if (outcome !== '') {
    where.push('outcome = ?')
    params.push(outcome)
  }
  const triggeredByEmail = (q.triggeredByEmail ?? '').trim()
  if (triggeredByEmail !== '') {
    where.push('triggered_by_email = ?')
    params.push(triggeredByEmail)
  }
  const whereSql = where.join(' AND ')
  const [rows] = await pool.execute<Record<string, unknown>[]>(
    `SELECT ${COLUMNS} FROM runs WHERE ${whereSql} ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const [countRows] = await pool.execute<Record<string, unknown>[]>(`SELECT COUNT(*) AS n FROM runs WHERE ${whereSql}`, params)
  const total = Number(countRows[0]?.n ?? 0)
  return { rows: rows.map(toRow), total: Number.isFinite(total) ? total : 0, limit, offset }
}
