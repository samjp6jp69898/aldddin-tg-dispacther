// deploy/monitor-db/backfill/backfill-sqlite.ts — Phase 6 歷史回填：sqlite → MySQL。
//
// 依 plan-db-as-truth-v3.md §11.2（＋ v3.2 修訂）把 tg-monitor/data/monitor.sqlite
// 的四張表回填進 pipeline_monitor schema 的對應表：
//   pipeline_runs → runs
//   agent_runs    → agent_runs
//   events        → mcp_usage
//   status_log    → service_status_log
// file_offsets 不回填（游標是行程私有狀態，新管線自己重建）。
//
// 這是「先開發＋測試，後執行」——本檔本身不對正式 pipeline_monitor schema 寫入
// 任何資料；--dry-run 是必做模式，正式執行由指揮官另行以 --schema 指向正式庫觸發。
//
// 硬紀律（見指派）：
//   1) 讀 monitor.sqlite 禁止 cp（WAL 踩坑）——一律先 snapshotSqlite() 到工作目錄，
//      再 compareCounts() 驗「快照 vs 正式檔逐表 row count 一致」，不一致重拍一次，
//      仍不一致 exit 1。之後所有讀取只讀快照，來源檔全程唯讀。
//   2) --dry-run 必做：讀來源、跑完整 mapping、印報告，不開 MySQL 連線、不寫入。
//   3) 冪等：runs/agent_runs/mcp_usage 用 insertIgnoreRow；service_status_log
//      無唯一鍵，用 insertIfNotExists（自然鍵 service+ts+status）。

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'mysql2/promise'
import { isoToMysqlDatetime3, isoToMysqlDatetime3OrNull } from '../../../lib/monitor-db/mysql-datetime.ts'
import { KNOWN_OUTCOME_TIER, LIFECYCLE_RANK } from '../../../lib/monitor-db/types.ts'
import { parseBackfillArgs } from './lib/cli.ts'
import { countRows, insertIfNotExists, insertIgnoreRow, openBackfillPool } from './lib/db.ts'
import { BACKFILL_HOST, loadBackfillEnv } from './lib/env.ts'
import { makeReport, printReports, type SourceReport } from './lib/report.ts'
import { deriveRunId } from './lib/run-id.ts'
import { compareCounts, snapshotSqlite, tableCount } from './lib/sqlite-snapshot.ts'

export const DEFAULT_SQLITE_PATH = '/Users/user/aladdin/tg-monitor/data/monitor.sqlite'

/** 回填讀取範圍——不含 file_offsets（游標是行程私有狀態，不回填）。 */
export const BACKFILL_TABLES = ['pipeline_runs', 'agent_runs', 'events', 'status_log'] as const

// ─────────────────────────────────────────────────────────────────────────
// 快照對數（禁 cp；快照與正式檔逐表 row count 一致才可讀）
// ─────────────────────────────────────────────────────────────────────────

export class SnapshotMismatchError extends Error {
  constructor(public readonly checks: ReturnType<typeof compareCounts>) {
    super(`sqlite 快照與正式檔逐表 row count 不一致（重試一次後仍不一致）：${JSON.stringify(checks)}`)
    this.name = 'SnapshotMismatchError'
  }
}

export interface SnapshotDeps {
  snapshot: typeof snapshotSqlite
  compare: typeof compareCounts
}

const defaultSnapshotDeps: SnapshotDeps = { snapshot: snapshotSqlite, compare: compareCounts }

/**
 * 產生一致性快照並驗證 row count；不一致時重拍一次，仍不一致丟
 * SnapshotMismatchError（呼叫端／CLI 轉成 exit 1）。
 */
export function ensureConsistentSnapshot(
  srcPath: string,
  workdir: string,
  tables: readonly string[] = BACKFILL_TABLES,
  deps: SnapshotDeps = defaultSnapshotDeps,
): string {
  const snapshotPath = path.join(workdir, 'monitor-snapshot.sqlite')
  deps.snapshot(srcPath, snapshotPath)
  let checks = deps.compare(srcPath, snapshotPath, [...tables])
  if (checks.every((c) => c.ok)) return snapshotPath

  // 重試一次：正式檔可能在兩次讀取之間又有新寫入（tg-monitor collector 仍在跑）。
  deps.snapshot(srcPath, snapshotPath)
  checks = deps.compare(srcPath, snapshotPath, [...tables])
  if (checks.every((c) => c.ok)) return snapshotPath

  throw new SnapshotMismatchError(checks)
}

// ─────────────────────────────────────────────────────────────────────────
// 來源列型別（sqlite 原始欄位）
// ─────────────────────────────────────────────────────────────────────────

export interface SqlitePipelineRun {
  key: string
  kind: string
  ticket: string
  started_at: string
  stdout_path: string | null
  stderr_path: string | null
  finished_at: string | null
  outcome: string | null
  cancelled_at: string | null
  triggered_by: string | null
  review_rounds: number | null
  final_review_rounds: number | null
}

export interface SqliteAgentRun {
  path: string
  ticket: string
  kind: string
  stage: string
  started_at: string
  ended_at: string | null
}

export interface SqliteEvent {
  service: string
  ts: string
  identity: string | null
  source_ip: string | null
  raw: string
}

export interface SqliteStatusLog {
  service: string
  ts: string
  status: string
  pid: number | null
  detail: string | null
}

// ─────────────────────────────────────────────────────────────────────────
// 目的列型別（MySQL 目標表）
// ─────────────────────────────────────────────────────────────────────────

export interface RunsInsertRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  lifecycle_rank: number
  started_at: string | null
  finished_at: string | null
  stdout_path: string | null
  stderr_path: string | null
  legacy_key: string
  outcome: string | null
  outcome_source: string | null
  outcome_tier: number | null
  legacy_outcome_raw: string | null
  cancel_requested_at: string | null
  triggered_by_email: string | null
  review_rounds: number | null
  final_review_rounds: number | null
}

export interface AgentRunsInsertRow {
  run_id: string
  path: string
  host: string
  agent_name: string | null
  started_at: string | null
  finished_at: string | null
}

export interface McpUsageInsertRow {
  service: string
  identity: string | null
  source_ip: string | null
  raw: string
  ts: string
}

export interface ServiceStatusLogInsertRow {
  service: string
  host: string
  ts: string
  status: string | null
  detail_json: string | null
}

// ─────────────────────────────────────────────────────────────────────────
// mapping：pipeline_runs → runs（§11.2）
// ─────────────────────────────────────────────────────────────────────────

/** outcome 原值直接沿用（原字串本身就是合法終態）的集合。 */
const DIRECT_OUTCOMES = new Set(['success', 'failed', 'timeout', 'needs_qa_clarification'])

export interface TimeoutRecompute {
  /** 原 finished_at（可能為 null）與重算值的差（秒）；原值 null 時為 null（無法比較）。 */
  diffSeconds: number | null
}

export interface MapPipelineRunResult {
  skip: boolean
  skipReason?: string
  row?: RunsInsertRow
  /** 本列的一次性 note（如「outcome NULL 但 finished_at 非 NULL」）。 */
  note?: string
  /** 只有 outcome==='timeout' 時才有值（finished_at 依 §9.0(G)/MJ-8 重算為 started_at+7200s）。 */
  timeoutRecompute?: TimeoutRecompute
}

function addSecondsIso(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
}

export function mapPipelineRunToRunsRow(r: SqlitePipelineRun): MapPipelineRunResult {
  const raw = r.outcome

  if (raw === null && r.finished_at === null) {
    return {
      skip: true,
      skipReason: `pipeline_runs 略過（outcome 與 finished_at 皆為 NULL，快照當下可能仍在跑）：key=${r.key}`,
    }
  }

  let outcome: string
  let outcomeSource: string
  let legacyOutcomeRaw: string | null = null
  let note: string | undefined

  if (raw === null) {
    outcome = 'unknown_failure'
    outcomeSource = 'backfill'
    note = `outcome IS NULL 但 finished_at 非 NULL，補 unknown_failure：key=${r.key}`
  } else if (raw === '' || raw === 'empty') {
    outcome = 'unknown_failure'
    outcomeSource = 'backfill'
    legacyOutcomeRaw = raw.slice(0, 64)
  } else if (raw === 'recovered') {
    outcome = 'recovered'
    outcomeSource = 'tracker_reconcile'
  } else if (DIRECT_OUTCOMES.has(raw) || raw === 'unknown_failure') {
    outcome = raw
    outcomeSource = 'backfill'
  } else {
    outcome = 'legacy_unmapped'
    outcomeSource = 'backfill'
    legacyOutcomeRaw = raw.slice(0, 64)
  }

  const outcomeTier = KNOWN_OUTCOME_TIER[outcome]

  let finishedAtIso = r.finished_at
  let timeoutRecompute: TimeoutRecompute | undefined
  if (raw === 'timeout') {
    const recomputed = addSecondsIso(r.started_at, 7200)
    const diffSeconds =
      r.finished_at === null ? null : (new Date(recomputed).getTime() - new Date(r.finished_at).getTime()) / 1000
    timeoutRecompute = { diffSeconds }
    finishedAtIso = recomputed
  }

  const row: RunsInsertRow = {
    run_id: deriveRunId(r.key),
    host: BACKFILL_HOST,
    ticket: r.ticket,
    kind: r.kind,
    lifecycle_rank: LIFECYCLE_RANK.finished,
    started_at: isoToMysqlDatetime3OrNull(r.started_at),
    finished_at: isoToMysqlDatetime3OrNull(finishedAtIso),
    stdout_path: r.stdout_path,
    stderr_path: r.stderr_path,
    legacy_key: r.key,
    outcome,
    outcome_source: outcomeSource,
    outcome_tier: outcomeTier,
    legacy_outcome_raw: legacyOutcomeRaw,
    cancel_requested_at: isoToMysqlDatetime3OrNull(r.cancelled_at),
    triggered_by_email: r.triggered_by,
    review_rounds: r.review_rounds,
    final_review_rounds: r.final_review_rounds,
  }

  return { skip: false, row, note, timeoutRecompute }
}

// ─────────────────────────────────────────────────────────────────────────
// mapping：agent_runs → agent_runs（§11.2）
// ─────────────────────────────────────────────────────────────────────────

export interface MapAgentRunResult {
  skip: boolean
  skipReason?: string
  row?: AgentRunsInsertRow
}

/**
 * 建立 agent_runs 對位器：
 *   kind='bug'    → path 對 pipeline_runs.stdout_path 等值找列。
 *   kind='demand' → 同 ticket、kind='demand'、started_at ≤ agent.started_at 的
 *                    pipeline_runs 中 started_at 最大者。
 * ISO 字串固定格式（毫秒＋'Z'）下，字典序比較等同時間序，故直接用字串比較。
 */
export function buildAgentRunMapper(pipelineRuns: readonly SqlitePipelineRun[]): (agent: SqliteAgentRun) => MapAgentRunResult {
  const byStdoutPath = new Map<string, SqlitePipelineRun>()
  const demandByTicket = new Map<string, SqlitePipelineRun[]>()
  for (const pr of pipelineRuns) {
    if (pr.stdout_path) byStdoutPath.set(pr.stdout_path, pr)
    if (pr.kind === 'demand') {
      const arr = demandByTicket.get(pr.ticket) ?? []
      arr.push(pr)
      demandByTicket.set(pr.ticket, arr)
    }
  }
  for (const arr of demandByTicket.values()) arr.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))

  function buildRow(agent: SqliteAgentRun, pr: SqlitePipelineRun): AgentRunsInsertRow {
    return {
      run_id: deriveRunId(pr.key),
      path: agent.path,
      host: BACKFILL_HOST,
      agent_name: agent.stage,
      started_at: isoToMysqlDatetime3OrNull(agent.started_at),
      finished_at: isoToMysqlDatetime3OrNull(agent.ended_at),
    }
  }

  return function mapAgentRun(agent: SqliteAgentRun): MapAgentRunResult {
    if (agent.kind === 'bug') {
      const pr = byStdoutPath.get(agent.path)
      if (!pr) return { skip: true, skipReason: `bug agent_run 對不到 pipeline_runs.stdout_path：path=${agent.path}` }
      return { skip: false, row: buildRow(agent, pr) }
    }
    if (agent.kind === 'demand') {
      const candidates = (demandByTicket.get(agent.ticket) ?? []).filter((pr) => pr.started_at <= agent.started_at)
      if (candidates.length === 0) {
        return {
          skip: true,
          skipReason: `demand agent_run 對不到同 ticket 且 started_at 較早的 pipeline_runs：ticket=${agent.ticket} path=${agent.path}`,
        }
      }
      const pr = candidates[candidates.length - 1]!
      return { skip: false, row: buildRow(agent, pr) }
    }
    return { skip: true, skipReason: `未知 kind（非 bug/demand）：kind=${agent.kind} path=${agent.path}` }
  }
}

/** schema 無對應欄位、回填時丟棄的 sqlite agent_runs 欄位清單（notes 用）。 */
export const AGENT_RUNS_DROPPED_COLUMNS = [
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_create_tokens',
  'cost_usd',
  'num_turns',
  'tool_calls',
  'is_error',
  'result_preview',
  'file_mtime',
] as const

// ─────────────────────────────────────────────────────────────────────────
// mapping：events → mcp_usage、status_log → service_status_log（純映射，無 skip）
// ─────────────────────────────────────────────────────────────────────────

export function mapEventToMcpUsageRow(e: SqliteEvent): McpUsageInsertRow {
  return {
    service: e.service,
    identity: e.identity,
    source_ip: e.source_ip,
    raw: e.raw,
    ts: isoToMysqlDatetime3(e.ts),
  }
}

export function mapStatusLogToRow(s: SqliteStatusLog): ServiceStatusLogInsertRow {
  const detailJson = s.pid === null && s.detail === null ? null : JSON.stringify({ pid: s.pid, detail: s.detail })
  return {
    service: s.service,
    host: BACKFILL_HOST,
    ts: isoToMysqlDatetime3(s.ts),
    status: s.status,
    detail_json: detailJson,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DB 寫入（insertIgnoreRow / insertIfNotExists 包一層具名欄位順序）
// ─────────────────────────────────────────────────────────────────────────

async function writeRunsRow(pool: Pool, row: RunsInsertRow): Promise<boolean> {
  return insertIgnoreRow(
    pool,
    'runs',
    [
      'run_id',
      'host',
      'ticket',
      'kind',
      'lifecycle_rank',
      'started_at',
      'finished_at',
      'stdout_path',
      'stderr_path',
      'legacy_key',
      'outcome',
      'outcome_source',
      'outcome_tier',
      'legacy_outcome_raw',
      'cancel_requested_at',
      'triggered_by_email',
      'review_rounds',
      'final_review_rounds',
    ],
    [
      row.run_id,
      row.host,
      row.ticket,
      row.kind,
      row.lifecycle_rank,
      row.started_at,
      row.finished_at,
      row.stdout_path,
      row.stderr_path,
      row.legacy_key,
      row.outcome,
      row.outcome_source,
      row.outcome_tier,
      row.legacy_outcome_raw,
      row.cancel_requested_at,
      row.triggered_by_email,
      row.review_rounds,
      row.final_review_rounds,
    ],
  )
}

async function writeAgentRunsRow(pool: Pool, row: AgentRunsInsertRow): Promise<boolean> {
  return insertIgnoreRow(
    pool,
    'agent_runs',
    ['run_id', 'path', 'host', 'agent_name', 'started_at', 'finished_at'],
    [row.run_id, row.path, row.host, row.agent_name, row.started_at, row.finished_at],
  )
}

async function writeMcpUsageRow(pool: Pool, row: McpUsageInsertRow): Promise<boolean> {
  return insertIgnoreRow(
    pool,
    'mcp_usage',
    ['service', 'identity', 'source_ip', 'raw', 'ts'],
    [row.service, row.identity, row.source_ip, row.raw, row.ts],
  )
}

async function writeServiceStatusLogRow(pool: Pool, row: ServiceStatusLogInsertRow): Promise<boolean> {
  return insertIfNotExists(
    pool,
    'service_status_log',
    ['service', 'host', 'ts', 'status', 'detail_json'],
    [row.service, row.host, row.ts, row.status, row.detail_json],
    ['service', 'ts', 'status'],
    [row.service, row.ts, row.status],
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 主流程：讀快照 → mapping → (dry-run 印報告 | 寫入) → 回傳四個 SourceReport
// ─────────────────────────────────────────────────────────────────────────

export interface RunBackfillOptions {
  snapshotPath: string
  dryRun: boolean
}

export interface RunBackfillDeps {
  /** !dryRun 時必須提供（真實 pool 或測試用假 pool）。 */
  pool?: Pool
}

export async function runBackfill(opts: RunBackfillOptions, deps: RunBackfillDeps = {}): Promise<SourceReport[]> {
  if (!opts.dryRun && !deps.pool) {
    throw new Error('runBackfill: dryRun=false 時必須提供 deps.pool')
  }

  const db = new Database(opts.snapshotPath, { readonly: true })
  try {
    const pipelineRuns = db
      .query(
        `SELECT key, kind, ticket, started_at, stdout_path, stderr_path, finished_at, outcome, cancelled_at, triggered_by,
                review_rounds, final_review_rounds
         FROM pipeline_runs`,
      )
      .all() as SqlitePipelineRun[]
    const agentRuns = db.query(`SELECT path, ticket, kind, stage, started_at, ended_at FROM agent_runs`).all() as SqliteAgentRun[]
    const events = db.query(`SELECT service, ts, identity, source_ip, raw FROM events`).all() as SqliteEvent[]
    const statusLogs = db.query(`SELECT service, ts, status, pid, detail FROM status_log`).all() as SqliteStatusLog[]

    const runsReport = await backfillPipelineRuns(pipelineRuns, opts.dryRun, deps.pool)
    const agentRunsReport = await backfillAgentRuns(agentRuns, pipelineRuns, opts.dryRun, deps.pool)
    const mcpUsageReport = await backfillEvents(events, opts.dryRun, deps.pool)
    const statusLogReport = await backfillStatusLogs(statusLogs, opts.dryRun, deps.pool)

    return [runsReport, agentRunsReport, mcpUsageReport, statusLogReport]
  } finally {
    db.close()
  }
}

async function backfillPipelineRuns(rows: SqlitePipelineRun[], dryRun: boolean, pool: Pool | undefined): Promise<SourceReport> {
  const report = makeReport('sqlite.pipeline_runs → runs', dryRun)
  report.sourceRows = rows.length

  let timeoutCount = 0
  let timeoutDiffSum = 0
  let timeoutDiffKnown = 0

  for (const r of rows) {
    const mapped = mapPipelineRunToRunsRow(r)
    if (mapped.skip) {
      report.skipped++
      report.notes.push(mapped.skipReason!)
      continue
    }
    report.attempted++
    if (mapped.note) report.notes.push(mapped.note)
    if (mapped.timeoutRecompute) {
      timeoutCount++
      if (mapped.timeoutRecompute.diffSeconds !== null) {
        timeoutDiffSum += mapped.timeoutRecompute.diffSeconds
        timeoutDiffKnown++
      }
    }
    if (!dryRun) {
      const inserted = await writeRunsRow(pool!, mapped.row!)
      if (inserted) report.inserted++
      else report.ignored++
    }
  }

  if (timeoutCount > 0) {
    const avg = timeoutDiffKnown > 0 ? (timeoutDiffSum / timeoutDiffKnown).toFixed(1) : 'n/a'
    report.notes.push(`timeout finished_at 重算為 started_at+7200s：${timeoutCount} 列，重算值與原值平均差 ${avg} 秒`)
  }
  report.notes.push('triggered_by 欄位語意不符：來源是顯示名不是 email，照存至 triggered_by_email')

  return report
}

async function backfillAgentRuns(
  agentRows: SqliteAgentRun[],
  pipelineRuns: SqlitePipelineRun[],
  dryRun: boolean,
  pool: Pool | undefined,
): Promise<SourceReport> {
  const report = makeReport('sqlite.agent_runs → agent_runs', dryRun)
  report.sourceRows = agentRows.length

  const mapAgentRun = buildAgentRunMapper(pipelineRuns)

  for (const a of agentRows) {
    const mapped = mapAgentRun(a)
    if (mapped.skip) {
      report.skipped++
      report.notes.push(mapped.skipReason!)
      continue
    }
    report.attempted++
    if (!dryRun) {
      const inserted = await writeAgentRunsRow(pool!, mapped.row!)
      if (inserted) report.inserted++
      else report.ignored++
    }
  }

  report.notes.push(`schema 無對應欄位，已丟棄欄位清單：${AGENT_RUNS_DROPPED_COLUMNS.join(', ')}`)

  return report
}

async function backfillEvents(events: SqliteEvent[], dryRun: boolean, pool: Pool | undefined): Promise<SourceReport> {
  const report = makeReport('sqlite.events → mcp_usage', dryRun)
  report.sourceRows = events.length

  for (const e of events) {
    const row = mapEventToMcpUsageRow(e)
    report.attempted++
    if (!dryRun) {
      const inserted = await writeMcpUsageRow(pool!, row)
      if (inserted) report.inserted++
      else report.ignored++
    }
  }

  return report
}

async function backfillStatusLogs(rows: SqliteStatusLog[], dryRun: boolean, pool: Pool | undefined): Promise<SourceReport> {
  const report = makeReport('sqlite.status_log → service_status_log', dryRun)
  report.sourceRows = rows.length

  for (const s of rows) {
    const row = mapStatusLogToRow(s)
    report.attempted++
    if (!dryRun) {
      const inserted = await writeServiceStatusLogRow(pool!, row)
      if (inserted) report.inserted++
      else report.ignored++
    }
  }

  return report
}

// ─────────────────────────────────────────────────────────────────────────
// CLI 入口
// ─────────────────────────────────────────────────────────────────────────

function parseExtraArgs(rest: string[]): { sqlitePath: string; workdir: string } {
  let sqlitePath = DEFAULT_SQLITE_PATH
  let workdir = path.join(os.tmpdir(), 'telegram-dispatcher-backfill-sqlite')
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--sqlite') sqlitePath = rest[++i]!
    else if (rest[i] === '--workdir') workdir = rest[++i]!
  }
  return { sqlitePath, workdir }
}

export async function main(): Promise<number> {
  const args = parseBackfillArgs()
  const { sqlitePath, workdir } = parseExtraArgs(args.rest)
  loadBackfillEnv(args.envFile)
  mkdirSync(workdir, { recursive: true })

  let snapshotPath: string
  try {
    snapshotPath = ensureConsistentSnapshot(sqlitePath, workdir)
  } catch (err) {
    if (err instanceof SnapshotMismatchError) {
      console.error(err.message)
      return 1
    }
    throw err
  }

  const pool = args.dryRun ? undefined : openBackfillPool()
  try {
    const reports = await runBackfill({ snapshotPath, dryRun: args.dryRun }, { pool })
    printReports(reports)
    const fileOffsetsCount = tableCount(snapshotPath, 'file_offsets')
    console.log(`note: sqlite.file_offsets（${fileOffsetsCount} 列）不回填 — 游標是行程私有狀態，由新管線自行重建。`)
    // 逐表對數：來源快照 row count 供人工核對（countRows 只在非 dry-run 時有意義，
    // dry-run 不開連線）。
    if (!args.dryRun && pool) {
      for (const table of ['runs', 'agent_runs', 'mcp_usage', 'service_status_log']) {
        const n = await countRows(pool, table)
        console.log(`note: MySQL ${table} 目前總列數（含既有線上寫入）＝${n}`)
      }
    }
    return 0
  } finally {
    if (pool) await pool.end()
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code))
}
