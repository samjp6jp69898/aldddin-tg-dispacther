// lib/monitor-db/local-sweep.ts — 本機自癒（整合修補批次 item 8，BL-C5 落地件）。
//
// 兩支函式，各對應計畫的一節：
//   sweepDeadLocalRuns  — §6.6 本機 sweeper（寫入者死亡時的唯一自癒；
//                          reaper 與週期 timer 共用同一支函式，見 §5.7）。
//   sweepLostOnRestart  — §5.6 重啟一致性（BL-C5 新判準：集合成員資格，
//                          不看 lifecycle 當下值）。
//
// 兩者都只處理本機（MON_HOST）的列（R1：絕不跨 host），寫入一律是 tier 1
// 暫定終態（W3 / writeRunOutcomeProvisional），可被任何後續權威終態覆寫。
import { execFileSync } from 'node:child_process'
import { MON_HOST } from './env.ts'
import { writeRunOutcomeProvisional, type MonitorDbExecutor } from './writes.ts'
import type { RunKind } from './types.ts'

export interface SweptRun {
  runId: string
  ticket: string
  outcome: string
}

export interface SweepResult {
  swept: SweptRun[]
}

// ─────────────────────────────────────────────────────────────────────────
// §6.6 本機 sweeper
// ─────────────────────────────────────────────────────────────────────────

export const RUNNING_ROWS_SQL = `SELECT run_id, ticket, kind, pid FROM runs WHERE host = ? AND lifecycle_rank = 30 AND outcome IS NULL`
export const RUNNING_ROWS_BY_TICKET_SQL = `${RUNNING_ROWS_SQL} AND ticket = ?`

export interface LocalSweepDeps {
  /** §6.6 步驟 1：該列自己的 pid 是否還活著且命令列含該 ticket。
   * production 用 `ps -p <pid> -o command=`（見 defaultIsPidAlive）；
   * 測試注入假值，不需要真的 spawn。 */
  isPidAlive(pid: number, ticket: string): boolean
  /** local-activity 三合一（queue ∪ 鎖目錄 ∪ ps wrapper 掃描），見
   * lib/cluster/local-activity.ts 的 LocalActivity.isActive。 */
  isTicketActive(ticket: string): boolean
  /** 跳過條件（降噪，非正確性依據）：本機 spool 內是否有這個 run_id 的
   * 待重放條目。不提供時視同「沒有待重放條目」。 */
  hasPendingSpoolEntry?(runId: string): boolean
  now?(): string
}

/** production 預設：`ps -p <pid> -o command=`。找不到 pid（非 0 結束碼）視為
 * 死亡；找到但命令列不含該 ticket 也視為死亡（pid 已被別的行程重用）。 */
export function defaultIsPidAlive(pid: number, ticket: string): boolean {
  try {
    // 同步 spawn 只在週期 timer 的 tick 內執行，不在任何 HTTP handler 內
    // （tg-monitor/lib/ingest.ts:99-103 的既有禁令只擋 handler 內同步 spawn，
    // 本模組的呼叫端是 server.ts/worker-agent.ts 的 setInterval，不是
    // handler）。
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim()
    return out.length > 0 && out.includes(ticket)
  } catch {
    return false
  }
}

export interface SweepDeadLocalRunsOpts {
  /** 限定單一 ticket（reaper 用法：釋放鎖之後只驗這張票，§5.7）；不給則掃
   * 本機所有 rank=30 的列（週期 timer 用法，§6.6）。 */
  ticket?: string
  /** 寫入的 outcome 值——reaper 呼叫傳 'unknown_reaped'（reaper 不殺行程，
   * 對「怎麼結束的」沒有權威知識，§5.7 點 3）；週期 timer 呼叫用預設值
   * 'unknown_no_writer'。`pid IS NULL` 的列一律寫 'unknown_no_writer'
   * （MN-C8(b)：結構上不該存在，與這裡的 reason 無關）。 */
  reason?: 'unknown_no_writer' | 'unknown_reaped'
}

/**
 * §6.6：唯一會把 running 列寫成暫定終態的地方。reaper（§5.7）與週期 timer
 * 共用本函式，差異只在 opts（reaper 傳 ticket + reason:'unknown_reaped'）。
 */
export async function sweepDeadLocalRuns(pool: MonitorDbExecutor, deps: LocalSweepDeps, opts: SweepDeadLocalRunsOpts = {}): Promise<SweepResult> {
  const reason = opts.reason ?? 'unknown_no_writer'
  const [rows] = opts.ticket ? await pool.execute(RUNNING_ROWS_BY_TICKET_SQL, [MON_HOST, opts.ticket]) : await pool.execute(RUNNING_ROWS_SQL, [MON_HOST])
  const result: SweepResult = { swept: [] }

  for (const r of rows as unknown as Array<{ run_id: string; ticket: string; kind: RunKind; pid: number | null }>) {
    if (deps.hasPendingSpoolEntry?.(r.run_id)) continue // 降噪：本輪跳過，非正確性依據

    if (r.pid === null) {
      // MN-C8(b)：結構上不該存在的保險，立刻寫，不等其他判定。
      await writeOutcome(pool, r, 'unknown_no_writer', deps)
      result.swept.push({ runId: r.run_id, ticket: r.ticket, outcome: 'unknown_no_writer' })
      continue
    }
    if (deps.isPidAlive(r.pid, r.ticket)) continue // 還活著，跳過
    if (deps.isTicketActive(r.ticket)) continue // local-activity 認定整票仍有活動，保守跳過

    await writeOutcome(pool, r, reason, deps)
    result.swept.push({ runId: r.run_id, ticket: r.ticket, outcome: reason })
  }
  return result
}

async function writeOutcome(
  pool: MonitorDbExecutor,
  r: { run_id: string; ticket: string; kind: RunKind },
  outcome: string,
  deps: LocalSweepDeps,
): Promise<void> {
  const finishedAt = deps.now?.() ?? new Date().toISOString()
  await writeRunOutcomeProvisional(pool, { runId: r.run_id, ticket: r.ticket, kind: r.kind, outcome, outcomeSource: 'local-sweeper', finishedAt })
}

// ─────────────────────────────────────────────────────────────────────────
// §5.6：lost_on_restart（BL-C5 新判準）
// ─────────────────────────────────────────────────────────────────────────

export const QUEUED_ROWS_SQL = `SELECT run_id, ticket, kind FROM runs WHERE host = ? AND lifecycle_rank = 10 AND outcome IS NULL`

export interface SweepLostOnRestartDeps {
  now?(): string
}

/**
 * §5.6：判準是集合成員資格，不看 lifecycle 當下值——`seen` 是
 * `recoverFromDisk()` 回傳的 `{started, requeued, skipped}` 三個 run_id
 * 陣列的聯集（呼叫端負責 union，本函式只認「不在這個集合裡」）。`seen` 為
 * 空集合（快照不存在／解析失敗）時照跑，這代表快照真的沒了。順序無關、
 * 可重跑：同一批列重跑是欄位級 no-op（`outcome IS NULL` 守衛）。
 */
export async function sweepLostOnRestart(pool: MonitorDbExecutor, seen: ReadonlySet<string>, deps: SweepLostOnRestartDeps = {}): Promise<SweepResult> {
  const [rows] = await pool.execute(QUEUED_ROWS_SQL, [MON_HOST])
  const result: SweepResult = { swept: [] }
  for (const r of rows as unknown as Array<{ run_id: string; ticket: string; kind: RunKind }>) {
    if (seen.has(r.run_id)) continue
    const finishedAt = deps.now?.() ?? new Date().toISOString()
    await writeRunOutcomeProvisional(pool, { runId: r.run_id, ticket: r.ticket, kind: r.kind, outcome: 'lost_on_restart', outcomeSource: 'restart-sweep', finishedAt })
    result.swept.push({ runId: r.run_id, ticket: r.ticket, outcome: 'lost_on_restart' })
  }
  return result
}
