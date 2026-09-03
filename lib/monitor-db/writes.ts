// lib/monitor-db/writes.ts — 監控 DB 的守衛式寫入層（canonical SQL）。
//
// 所有寫入都經本檔的具名函式，只有兩種形狀（plan-db-as-truth-v3.md §6.2）：
//   形狀 A｜純 additive 合併（ODKU，只用於「補空欄」與單調 rank）——W1、agent_runs。
//   形狀 B｜守衛式 UPDATE →（matched=0 才）INSERT →（ER_DUP_ENTRY 才）再 UPDATE
//          → 仍 matched=0 才進冷路徑診斷 SELECT——W2/W3/W4/W5、
//          monitor_heartbeat、file_offsets、dispatch_attempts。
//
// 硬規則（R4，§6.1）：任何寫入的守衛一律放在 WHERE，不放在 SET；
// 唯一例外是形狀 A 的 COALESCE/GREATEST 合併。
// 【G:MJ-E1】runs 的所有寫入函式一律不接受呼叫端傳入的 host，由 env.ts 的
// MON_HOST 常數供給（型別上把 host 從參數移除）。
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { MON_HOST } from './env.ts'
import { isoToMysqlDatetime3OrNull as dt } from './mysql-datetime.ts'
import { parseUpdateInfo } from './parse-update-info.ts'
import type { CancelResolvedBy, GuardedReason, MonitorHeartbeatWriter, RunKind, WriteOutcome } from './types.ts'

// 呼叫端一律傳絕對 ISO 字串（§6.5(a) 硬規則）；`dt()` 在 SQL 邊界轉成 MySQL
// DATETIME(3) 字面字串——本輪對真實 mon-mysql 實測（S7）證實 mysql2 即使搭配
// `dateStrings`，寫入時仍要求 MySQL 原生格式（無 `T`/`Z`），直接綁定 ISO 字串
// 會被 MySQL 拒絕（ER_TRUNCATED_WRONG_VALUE），不是「格式落差」而是「寫不進去」。

// ─────────────────────────────────────────────────────────────────────────
// 共用執行器介面（結構性相容 mysql2 的 Pool / PoolConnection，方便測試注入假 client）
// ─────────────────────────────────────────────────────────────────────────

export interface MonitorDbExecutor {
  execute<T = ResultSetHeader>(sql: string, params?: unknown[]): Promise<[T, unknown]>
}

function isDupEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

/** 執行一條純 UPDATE（非 ODKU），回傳解析後的 matched/changed。info 解不出來就是硬錯誤。 */
async function execUpdate(
  pool: MonitorDbExecutor,
  sql: string,
  params: unknown[],
): Promise<{ matched: number; changed: number; header: ResultSetHeader }> {
  const [header] = await pool.execute<ResultSetHeader>(sql, params)
  const parsed = parseUpdateInfo((header as ResultSetHeader).info)
  if (!parsed) {
    throw new Error(
      `execUpdate: 無法解析 UPDATE 回傳的 info 字串（lc_messages 是否為 en_US？）：` +
        `info=${JSON.stringify((header as ResultSetHeader).info)} sql=${sql}`,
    )
  }
  return { matched: parsed.matched, changed: parsed.changed, header: header as ResultSetHeader }
}

// ─────────────────────────────────────────────────────────────────────────
// runs：W1（進度，形狀 A）
// ─────────────────────────────────────────────────────────────────────────

export interface RunIdentity {
  runId: string
  ticket: string
  kind: RunKind
}

/**
 * W1：進度寫入（queued/running）。十條賦值全部包 `IF(runs.host = new.host, …, runs.<col>)`
 * 守衛（【G:MJ-E1】），host 不符時全部欄位寫回原值 ⇒ 無變更 ⇒ `-FOUND_ROWS` 下 affectedRows=0，
 * 冷路徑 SELECT 可偵測出 r1_violation。
 */
export const W1_SQL = `
INSERT INTO runs
  (run_id, host, ticket, kind, lifecycle_rank, started_at, pid, stdout_path, stderr_path,
   trigger_source, retry_of_run_id, dispatch_id, legacy_key, triggered_by_email, triggered_by_name, created_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NOW(3)) AS new
ON DUPLICATE KEY UPDATE
  lifecycle_rank     = IF(runs.host = new.host, GREATEST(runs.lifecycle_rank, new.lifecycle_rank), runs.lifecycle_rank),
  started_at         = IF(runs.host = new.host, COALESCE(runs.started_at,         new.started_at),         runs.started_at),
  pid                = IF(runs.host = new.host, COALESCE(runs.pid,                new.pid),                runs.pid),
  stdout_path        = IF(runs.host = new.host, COALESCE(runs.stdout_path,        new.stdout_path),        runs.stdout_path),
  stderr_path        = IF(runs.host = new.host, COALESCE(runs.stderr_path,        new.stderr_path),        runs.stderr_path),
  trigger_source     = IF(runs.host = new.host, COALESCE(runs.trigger_source,     new.trigger_source),     runs.trigger_source),
  retry_of_run_id    = IF(runs.host = new.host, COALESCE(runs.retry_of_run_id,    new.retry_of_run_id),    runs.retry_of_run_id),
  dispatch_id        = IF(runs.host = new.host, COALESCE(runs.dispatch_id,        new.dispatch_id),        runs.dispatch_id),
  legacy_key         = IF(runs.host = new.host, COALESCE(runs.legacy_key,         new.legacy_key),         runs.legacy_key),
  triggered_by_email = IF(runs.host = new.host, COALESCE(runs.triggered_by_email, new.triggered_by_email), runs.triggered_by_email),
  triggered_by_name  = IF(runs.host = new.host, COALESCE(runs.triggered_by_name,  new.triggered_by_name),  runs.triggered_by_name)
`.trim()

export const RUNS_COLD_PATH_W1_SQL = 'SELECT host, lifecycle_rank FROM runs WHERE run_id = ?'

export interface WriteRunProgressInput extends RunIdentity {
  lifecycleRank: 10 | 30
  startedAt?: string | null
  pid?: number | null
  stdoutPath?: string | null
  stderrPath?: string | null
  triggerSource?: string | null
  retryOfRunId?: string | null
  dispatchId?: string | null
  legacyKey?: string | null
  triggeredByEmail?: string | null
  triggeredByName?: string | null
}

export async function writeRunProgress(pool: MonitorDbExecutor, input: WriteRunProgressInput): Promise<WriteOutcome> {
  const params = [
    input.runId,
    MON_HOST,
    input.ticket,
    input.kind,
    input.lifecycleRank,
    dt(input.startedAt),
    input.pid ?? null,
    input.stdoutPath ?? null,
    input.stderrPath ?? null,
    input.triggerSource ?? null,
    input.retryOfRunId ?? null,
    input.dispatchId ?? null,
    input.legacyKey ?? null,
    input.triggeredByEmail ?? null,
    input.triggeredByName ?? null,
  ]
  const [header] = await pool.execute<ResultSetHeader>(W1_SQL, params)
  const affected = (header as ResultSetHeader).affectedRows
  // -FOUND_ROWS 下：1=INSERT、2=UPDATE 且有變更、0=UPDATE 但無變更（冪等重放或 guard 擋下）。
  if (affected === 1) return { kind: 'inserted' }
  if (affected === 2) return { kind: 'applied' }
  return classifyRunsColdPathW1(pool, input.runId, input.lifecycleRank)
}

async function classifyRunsColdPathW1(pool: MonitorDbExecutor, runId: string, attemptedRank: number): Promise<WriteOutcome> {
  const [rows] = await pool.execute<RowDataPacket[]>(RUNS_COLD_PATH_W1_SQL, [runId])
  const row = (rows as RowDataPacket[])[0] as { host: string; lifecycle_rank: number } | undefined
  if (!row) return { kind: 'guarded', guardedReason: 'guarded_other' as GuardedReason }
  if (row.host !== MON_HOST) return { kind: 'guarded', guardedReason: 'r1_violation' }
  if (row.lifecycle_rank >= attemptedRank) return { kind: 'guarded', guardedReason: 'guarded_rank' }
  return { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// runs：W2（權威終態，tier 2，形狀 B，cancel 合成）
// ─────────────────────────────────────────────────────────────────────────

export const W2_UPDATE_SQL = `
UPDATE runs
   SET outcome        = IF(cancel_requested_at IS NOT NULL AND ? = 'infra_failure', 'cancelled', ?),
       outcome_tier   = 2,
       outcome_source = ?,
       finished_at    = ?,
       exit_code      = ?,
       lifecycle_rank = 100
 WHERE run_id = ? AND host = ?
   AND (outcome IS NULL OR outcome_tier < 2)
`.trim()

export const W2_INSERT_SQL = `
INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, outcome, outcome_tier, outcome_source, finished_at, exit_code, created_at)
VALUES (?, ?, ?, ?, 100, ?, 2, ?, ?, ?, NOW(3))
`.trim()

export const RUNS_COLD_PATH_TERMINAL_SQL = 'SELECT host, outcome, outcome_tier FROM runs WHERE run_id = ?'
export const RUNS_PRE_READ_TIER_SQL = 'SELECT outcome_tier FROM runs WHERE run_id = ? AND host = ?'

export interface WriteRunOutcomeAuthoritativeInput extends RunIdentity {
  /** exit code 分類出的原始 outcome（例如 'infra_failure'）；cancel 合成由 SQL 內的 IF 完成。 */
  outcome: string
  outcomeSource: string
  finishedAt: string
  exitCode?: number | null
}

/**
 * W2：權威終態（tier 2）。cancel 旗標先到／同時到都在同一語句內合成
 * （`outcome='infra_failure'` 且 `cancel_requested_at IS NOT NULL` → 寫 'cancelled'）；
 * 旗標晚到由 W5 兜底。
 */
export async function writeRunOutcomeAuthoritative(
  pool: MonitorDbExecutor,
  input: WriteRunOutcomeAuthoritativeInput,
): Promise<WriteOutcome> {
  // 診斷用預讀（非正確性依據，見 types.ts WriteOutcome.supersededProvisional 的說明）：
  // 判斷這次寫入是否覆寫了一個 tier 1 暫定終態。讀失敗不得影響正確性，吞掉即可。
  let wasProvisional = false
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(RUNS_PRE_READ_TIER_SQL, [input.runId, MON_HOST])
    const row = (rows as RowDataPacket[])[0] as { outcome_tier: number | null } | undefined
    wasProvisional = row?.outcome_tier === 1
  } catch {
    wasProvisional = false
  }

  const updateParams = [input.outcome, input.outcome, input.outcomeSource, dt(input.finishedAt), input.exitCode ?? null, input.runId, MON_HOST]
  let r = await execUpdate(pool, W2_UPDATE_SQL, updateParams)
  if (r.matched > 0) {
    return { kind: 'applied', supersededProvisional: wasProvisional && r.changed > 0 }
  }

  try {
    await pool.execute(W2_INSERT_SQL, [
      input.runId,
      MON_HOST,
      input.ticket,
      input.kind,
      input.outcome,
      input.outcomeSource,
      dt(input.finishedAt),
      input.exitCode ?? null,
    ])
    return { kind: 'inserted' }
  } catch (err) {
    if (!isDupEntry(err)) throw err
    r = await execUpdate(pool, W2_UPDATE_SQL, updateParams)
    if (r.matched > 0) return { kind: 'applied', supersededProvisional: wasProvisional && r.changed > 0 }
  }

  return classifyRunsColdPathTerminal(pool, input.runId)
}

async function classifyRunsColdPathTerminal(pool: MonitorDbExecutor, runId: string): Promise<WriteOutcome> {
  const [rows] = await pool.execute<RowDataPacket[]>(RUNS_COLD_PATH_TERMINAL_SQL, [runId])
  const row = (rows as RowDataPacket[])[0] as { host: string; outcome: string | null; outcome_tier: number | null } | undefined
  if (!row) return { kind: 'guarded', guardedReason: 'guarded_other' as GuardedReason }
  if (row.host !== MON_HOST) return { kind: 'guarded', guardedReason: 'r1_violation' }
  if (row.outcome !== null) return { kind: 'guarded', guardedReason: 'guarded_terminal' }
  return { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// runs：W3（暫定終態，tier 1，形狀 B）
// ─────────────────────────────────────────────────────────────────────────

export const W3_UPDATE_SQL = `
UPDATE runs
   SET outcome = ?, outcome_tier = 1, outcome_source = ?, finished_at = ?, lifecycle_rank = 100
 WHERE run_id = ? AND host = ? AND outcome IS NULL
`.trim()

export const W3_INSERT_SQL = `
INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, outcome, outcome_tier, outcome_source, finished_at, created_at)
VALUES (?, ?, ?, ?, 100, ?, 1, ?, ?, NOW(3))
`.trim()

export interface WriteRunOutcomeProvisionalInput extends RunIdentity {
  outcome: string
  outcomeSource: string
  finishedAt: string
}

/** W3：暫定終態（tier 1）。守衛只有 `outcome IS NULL`——已有任何終態（tier 1 或 2）都不覆寫。 */
export async function writeRunOutcomeProvisional(
  pool: MonitorDbExecutor,
  input: WriteRunOutcomeProvisionalInput,
): Promise<WriteOutcome> {
  const updateParams = [input.outcome, input.outcomeSource, dt(input.finishedAt), input.runId, MON_HOST]
  let r = await execUpdate(pool, W3_UPDATE_SQL, updateParams)
  if (r.matched > 0) return { kind: 'applied' }

  try {
    await pool.execute(W3_INSERT_SQL, [input.runId, MON_HOST, input.ticket, input.kind, input.outcome, input.outcomeSource, dt(input.finishedAt)])
    return { kind: 'inserted' }
  } catch (err) {
    if (!isDupEntry(err)) throw err
    r = await execUpdate(pool, W3_UPDATE_SQL, updateParams)
    if (r.matched > 0) return { kind: 'applied' }
  }

  return classifyRunsColdPathTerminal(pool, input.runId)
}

// ─────────────────────────────────────────────────────────────────────────
// runs：W4（cancel 旗標，形狀 B）／W5（cancel 遲到修正）
// ─────────────────────────────────────────────────────────────────────────

export const W4A_SQL = `
UPDATE runs
   SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
       cancel_resolved_by  = COALESCE(cancel_resolved_by,  ?)
 WHERE run_id = ? AND host = ?
`.trim()

export const W4B_INSERT_SQL = `
INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, cancel_requested_at, cancel_resolved_by, legacy_key, created_at)
VALUES (?, ?, ?, ?, 10, ?, ?, ?, NOW(3))
`.trim()

export interface WriteCancelFlagInput extends RunIdentity {
  cancelRequestedAt: string
  resolvedBy: CancelResolvedBy
  legacyKey?: string | null
}

/**
 * W4：cancel 旗標。W4a 先試守衛式 UPDATE（冪等，`COALESCE` 只在首次寫入生效）；
 * `matched=0` 才用 W4b 建最小佔位列（`lifecycle_rank=10`，`outcome`/`outcome_tier` 一律不列名 → NULL）。
 * `ER_DUP_ENTRY`（同時有人建了列）→ 再跑一次 W4a。
 * 呼叫端（cancelPipeline 等）決定 `runId`/`resolvedBy` 怎麼解析出來——那不在本模組職責內，
 * 本函式只負責把已經解析好的旗標**冪等、可重放**地落地。
 */
export async function writeCancelFlag(pool: MonitorDbExecutor, input: WriteCancelFlagInput): Promise<WriteOutcome> {
  const updateParams = [dt(input.cancelRequestedAt), input.resolvedBy, input.runId, MON_HOST]
  let r = await execUpdate(pool, W4A_SQL, updateParams)
  if (r.matched > 0) return { kind: 'applied' }

  try {
    await pool.execute(W4B_INSERT_SQL, [
      input.runId,
      MON_HOST,
      input.ticket,
      input.kind,
      dt(input.cancelRequestedAt),
      input.resolvedBy,
      input.legacyKey ?? null,
    ])
    return { kind: 'inserted' }
  } catch (err) {
    if (!isDupEntry(err)) throw err
    r = await execUpdate(pool, W4A_SQL, updateParams)
    if (r.matched > 0) return { kind: 'applied' }
  }

  return classifyRunsColdPathTerminal(pool, input.runId)
}

export const W5_SQL = `
UPDATE runs
   SET outcome = 'cancelled', outcome_source = 'cancel_late_fix'
 WHERE run_id = ? AND host = ?
   AND cancel_requested_at IS NOT NULL AND outcome = 'infra_failure'
`.trim()

/** W5：cancel 遲到修正（獨立語句，可重跑；旗標晚於終態抵達時把 infra_failure 改正為 cancelled）。 */
export async function fixCancelLateOutcome(pool: MonitorDbExecutor, runId: string): Promise<WriteOutcome> {
  const r = await execUpdate(pool, W5_SQL, [runId, MON_HOST])
  if (r.matched > 0) return { kind: 'applied' }
  return { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// monitor_heartbeat（migration 002 已套用 plan-db-as-truth-v3.2.md 裁定 1 §11.1
// 的 (host, writer) 修訂：head 上有 server/tg-monitor/log-intake 三個監控寫入
// 行程共用一列時，只要任一還活著，「head 自己 DB 不可寫」就永遠不會觸發——
// PK 改 (host, writer) 讓每個行程各自一列，守衛條件不變：
// WHERE host=? AND writer=? AND ts < ?。）
// ─────────────────────────────────────────────────────────────────────────

export const HEARTBEAT_UPDATE_SQL = `
UPDATE monitor_heartbeat SET ts = ?, spool_depth = ?, spool_oldest_ts = ? WHERE host = ? AND writer = ? AND ts < ?
`.trim()

export const HEARTBEAT_INSERT_SQL = `
INSERT INTO monitor_heartbeat (host, writer, ts, spool_depth, spool_oldest_ts) VALUES (?, ?, ?, ?, ?)
`.trim()

export interface UpsertHeartbeatInput {
  /** §11.1 修訂的值域：server（head）、worker-agent（每台 worker）、tg-monitor、log-intake（裁定 4 新增）。 */
  writer: MonitorHeartbeatWriter
  ts: string
  spoolDepth?: number | null
  spoolOldestTs?: string | null
}

/** 重放舊心跳不會把時間推回過去：`WHERE host=? AND writer=? AND ts < ?`。 */
export async function upsertMonitorHeartbeat(pool: MonitorDbExecutor, input: UpsertHeartbeatInput): Promise<WriteOutcome> {
  const updateParams = [dt(input.ts), input.spoolDepth ?? null, dt(input.spoolOldestTs), MON_HOST, input.writer, dt(input.ts)]
  let r = await execUpdate(pool, HEARTBEAT_UPDATE_SQL, updateParams)
  if (r.matched > 0) return { kind: 'applied' }

  try {
    await pool.execute(HEARTBEAT_INSERT_SQL, [MON_HOST, input.writer, dt(input.ts), input.spoolDepth ?? null, dt(input.spoolOldestTs)])
    return { kind: 'inserted' }
  } catch (err) {
    if (!isDupEntry(err)) throw err
    r = await execUpdate(pool, HEARTBEAT_UPDATE_SQL, updateParams)
    if (r.matched > 0) return { kind: 'applied' }
  }
  return { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// file_offsets（migration 002 已套用 G 卷 MAJOR-F10／【G:MN-G11】的 event_seq
// 修訂：守衛改為純 `WHERE host=? AND path=? AND event_seq < ?`——rotate 不再
// 是特例，跨 inode 的舊事件因 event_seq 較小而被擋。`inode`/`offset` 兩欄保留，
// 仍是 collector 續讀游標的實際依據，只是不再是「值是否生效」的判斷依據。
// `event_seq` 由呼叫端（log shipper）用記憶體單調計數器產生
// （`max(prev+1, Date.now()*1000)`，見 G 卷原文），本模組只負責把它當成不透明
// 的守衛值寫入，不在這裡重新實作那個計數器（那是 shipper 行程的狀態，不是
// DB 層的職責）。
// ─────────────────────────────────────────────────────────────────────────

export const FILE_OFFSET_UPDATE_SQL = `
UPDATE file_offsets SET \`offset\` = ?, inode = ?, event_seq = ? WHERE host = ? AND path = ? AND event_seq < ?
`.trim()

export const FILE_OFFSET_INSERT_SQL = `
INSERT INTO file_offsets (host, path, inode, \`offset\`, event_seq) VALUES (?, ?, ?, ?, ?)
`.trim()

export interface UpsertFileOffsetInput {
  path: string
  inode: number
  offset: number
  /** 單調遞增守衛值（跨 inode/rotate 都不回退）。JS number 精度在此用途下足夠
   *（`Date.now()*1000` 量級約 1.7e15，遠低於 Number.MAX_SAFE_INTEGER 的 9e15）。 */
  eventSeq: number
}

/** rotate 不再是特例：純用 `event_seq` 判斷「這次事件是否比 DB 現值新」。 */
export async function upsertFileOffset(pool: MonitorDbExecutor, input: UpsertFileOffsetInput): Promise<WriteOutcome> {
  const updateParams = [input.offset, input.inode, input.eventSeq, MON_HOST, input.path, input.eventSeq]
  let r = await execUpdate(pool, FILE_OFFSET_UPDATE_SQL, updateParams)
  if (r.matched > 0) return { kind: 'applied' }

  try {
    await pool.execute(FILE_OFFSET_INSERT_SQL, [MON_HOST, input.path, input.inode, input.offset, input.eventSeq])
    return { kind: 'inserted' }
  } catch (err) {
    if (!isDupEntry(err)) throw err
    r = await execUpdate(pool, FILE_OFFSET_UPDATE_SQL, updateParams)
    if (r.matched > 0) return { kind: 'applied' }
  }
  return { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// dispatch_attempts（head only；PK=dispatch_id；status_rank 單調守衛）
// ─────────────────────────────────────────────────────────────────────────

export const DISPATCH_ATTEMPT_INSERT_SQL = `
INSERT INTO dispatch_attempts (dispatch_id, ticket, kind, worker_name, worker_url, status, status_rank, dispatched_at, head_run_id, triggered_by_email, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
`.trim()

// MA-2（review-final-A-dispatcher.md）：confirmed_at / cleared_at / clear_reason /
// remote_run_id 與 worker_name/worker_url 一樣是「一次寫定」語意——這些欄位由
// **不同的 advance 各自帶來**（dispatched 帶 confirmed_at/remote_run_id、
// job_done/exception 只帶 cleared_at/clear_reason），後續 advance 未帶的欄位
// 一律傳 null，plain 賦值會把先前寫好的值抹回 NULL（本機實查：status='cleared',
// clear_reason='job_done' 的列 confirmed_at/remote_run_id 2/2 皆 NULL）。全部
// 改 COALESCE(col, ?)，只在該欄仍為 NULL 時生效。R4 合規：每條 COALESCE 只讀
// 自己那一欄的舊值（同 W1 的純 additive 慣例）。
export const DISPATCH_ATTEMPT_ADVANCE_SQL = `
UPDATE dispatch_attempts
   SET status = ?, status_rank = ?,
       confirmed_at = COALESCE(confirmed_at, ?), cleared_at = COALESCE(cleared_at, ?),
       clear_reason = COALESCE(clear_reason, ?), remote_run_id = COALESCE(remote_run_id, ?),
       worker_name = COALESCE(worker_name, ?), worker_url = COALESCE(worker_url, ?)
 WHERE dispatch_id = ? AND status_rank < ?
`.trim()

export interface CreateDispatchAttemptInput {
  dispatchId: string
  ticket: string
  kind: RunKind
  workerName?: string | null
  workerUrl?: string | null
  status: string
  statusRank: number
  dispatchedAt?: string | null
  headRunId?: string | null
  triggeredByEmail?: string | null
}

/** 建立一筆派工紀錄（第一次一定是 INSERT，dispatch_id 由呼叫端鑄好的 UUID）。 */
export async function createDispatchAttempt(pool: MonitorDbExecutor, input: CreateDispatchAttemptInput): Promise<WriteOutcome> {
  await pool.execute(DISPATCH_ATTEMPT_INSERT_SQL, [
    input.dispatchId,
    input.ticket,
    input.kind,
    input.workerName ?? null,
    input.workerUrl ?? null,
    input.status,
    input.statusRank,
    dt(input.dispatchedAt),
    input.headRunId ?? null,
    input.triggeredByEmail ?? null,
  ])
  return { kind: 'inserted' }
}

export interface AdvanceDispatchAttemptInput {
  dispatchId: string
  status: string
  statusRank: number
  confirmedAt?: string | null
  clearedAt?: string | null
  clearReason?: string | null
  remoteRunId?: string | null
  /** worker 在 create() 當下（status='dispatching'）還沒選出，第一次 advance
   * 到 'dispatched'/'already_running_remote' 才知道是哪一台——`COALESCE`
   * 只在首次寫入生效（worker 選定後不會再變），未提供時傳 null 不清空既有值
   * （否則 2C 回報的缺口：cleared/exception 等後續 advance 沒帶 worker 資訊，
   * 會把已經寫好的 worker_name/worker_url 覆蓋回 NULL）。
   *
   * MA-2（2026-09-03）：同一個「一次寫定」語意擴及 confirmedAt / clearedAt /
   * clearReason / remoteRunId——2C 當時只修了 worker 兩欄，其餘四欄留著 plain
   * 賦值，job_done 的 advance 把 dispatched 寫好的 confirmed_at/remote_run_id
   * 抹回 NULL（本機實查 2/2 列）。八個選填欄現在全部 COALESCE。 */
  workerName?: string | null
  workerUrl?: string | null
}

/** `status_rank` 只能單調前進：`WHERE dispatch_id=? AND status_rank < ?`。 */
export async function advanceDispatchAttempt(pool: MonitorDbExecutor, input: AdvanceDispatchAttemptInput): Promise<WriteOutcome> {
  const r = await execUpdate(pool, DISPATCH_ATTEMPT_ADVANCE_SQL, [
    input.status,
    input.statusRank,
    dt(input.confirmedAt),
    dt(input.clearedAt),
    input.clearReason ?? null,
    input.remoteRunId ?? null,
    input.workerName ?? null,
    input.workerUrl ?? null,
    input.dispatchId,
    input.statusRank,
  ])
  if (r.matched > 0) return { kind: 'applied' }
  return { kind: 'guarded', guardedReason: 'guarded_rank' }
}

export const DISPATCH_ATTEMPT_SUPERSEDE_SQL = `
UPDATE dispatch_attempts
   SET status = 'superseded', status_rank = 100
 WHERE ticket = ? AND kind = ? AND status_rank < 100 AND dispatch_id != ?
`.trim()

export interface SupersedeDispatchAttemptsInput {
  ticket: string
  kind: RunKind
  /** 新鑄的 dispatch_id；此刻通常還沒有列（markDispatching 剛鑄好，
   * create() 尚未落地），排除它只是防禦性寫法，不依賴呼叫順序。 */
  excludeDispatchId: string
}

/**
 * §5.3（MJ-C6 後半）：`markDispatching` 鑄新 `dispatch_id` 時，對同
 * `(ticket, kind)` 的所有 `status_rank < 100`（尚未終結）舊列一併寫
 * `superseded`——單一 UPDATE，守衛與 `advanceDispatchAttempt` 相同的
 * `status_rank < 100`。純觀察面 best-effort，`matched=0`（沒有舊列，第一次
 * 派工這張票）是正常情況，不是錯誤。
 */
export async function supersedeOtherDispatchAttempts(pool: MonitorDbExecutor, input: SupersedeDispatchAttemptsInput): Promise<WriteOutcome> {
  const r = await execUpdate(pool, DISPATCH_ATTEMPT_SUPERSEDE_SQL, [input.ticket, input.kind, input.excludeDispatchId])
  return r.matched > 0 ? { kind: 'applied' } : { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// agent_runs（形狀 A：純 additive，PK=(run_id, path)）
// ─────────────────────────────────────────────────────────────────────────

// migration 003（migration-003-proposal.md，已採納）：補 10 個 payload 欄，
// 對齊 tg-monitor 既有 sqlite agent_runs 表與 api-inventory 的 AgentSummary
// 形狀。刻意不搬 ticket/kind（可由 run_id → runs join 得到，不反正規化）與
// file_mtime（collector 私有再解析游標，行程私有狀態不進權威表）。
// first-write-wins（COALESCE 補空）取捨見提案 §4：Phase 4 collector 建議只在
// trace 終態（ended_at 已知）時才帶 payload 欄寫入，未終態先寫 NULL——
// 與既有 §6.2.2「finished_at 一次寫定」同構，不需要為此破例改守衛形狀。
export const AGENT_RUN_UPSERT_SQL = `
INSERT INTO agent_runs (
  run_id, path, host, agent_name, started_at, finished_at,
  model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
  cost_usd, num_turns, tool_calls, is_error, result_preview
)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) AS new
ON DUPLICATE KEY UPDATE
  agent_name          = COALESCE(agent_runs.agent_name,          new.agent_name),
  started_at          = COALESCE(agent_runs.started_at,          new.started_at),
  finished_at          = COALESCE(agent_runs.finished_at,          new.finished_at),
  model                 = COALESCE(agent_runs.model,                 new.model),
  input_tokens           = COALESCE(agent_runs.input_tokens,           new.input_tokens),
  output_tokens            = COALESCE(agent_runs.output_tokens,            new.output_tokens),
  cache_read_tokens          = COALESCE(agent_runs.cache_read_tokens,          new.cache_read_tokens),
  cache_create_tokens          = COALESCE(agent_runs.cache_create_tokens,          new.cache_create_tokens),
  cost_usd                       = COALESCE(agent_runs.cost_usd,                       new.cost_usd),
  num_turns                        = COALESCE(agent_runs.num_turns,                        new.num_turns),
  tool_calls                         = COALESCE(agent_runs.tool_calls,                         new.tool_calls),
  is_error                             = COALESCE(agent_runs.is_error,                             new.is_error),
  result_preview                         = COALESCE(agent_runs.result_preview,                         new.result_preview)
`.trim()

export interface UpsertAgentRunInput {
  runId: string
  path: string
  agentName?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheCreateTokens?: number | null
  costUsd?: number | null
  numTurns?: number | null
  toolCalls?: number | null
  isError?: boolean | null
  /** 呼叫端應截斷至 512 字元（result_preview 欄寬）；本函式仍防禦性截斷一次。 */
  resultPreview?: string | null
}

/** 純 additive 合併（COALESCE 補空欄），`finished_at` 一次寫定後不會被後續呼叫改掉。 */
export async function upsertAgentRun(pool: MonitorDbExecutor, input: UpsertAgentRunInput): Promise<WriteOutcome> {
  const [header] = await pool.execute<ResultSetHeader>(AGENT_RUN_UPSERT_SQL, [
    input.runId,
    input.path,
    MON_HOST,
    input.agentName ?? null,
    dt(input.startedAt),
    dt(input.finishedAt),
    input.model ?? null,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    input.cacheReadTokens ?? null,
    input.cacheCreateTokens ?? null,
    input.costUsd ?? null,
    input.numTurns ?? null,
    input.toolCalls ?? null,
    input.isError == null ? null : input.isError ? 1 : 0,
    input.resultPreview == null ? null : input.resultPreview.slice(0, 512),
  ])
  const affected = (header as ResultSetHeader).affectedRows
  if (affected === 1) return { kind: 'inserted' }
  if (affected === 2) return { kind: 'applied' }
  return { kind: 'guarded', guardedReason: 'guarded_other' }
}

// ─────────────────────────────────────────────────────────────────────────
// append-only 表：INSERT IGNORE + 唯一鍵（重放安全，天生冪等）
// ─────────────────────────────────────────────────────────────────────────

export const MCP_USAGE_INSERT_IGNORE_SQL = `
INSERT IGNORE INTO mcp_usage (service, identity, source_ip, raw, ts) VALUES (?, ?, ?, ?, ?)
`.trim()

export interface InsertMcpUsageInput {
  service: string
  identity?: string | null
  sourceIp?: string | null
  raw: string
  ts: string
}

/** `UNIQUE(service, raw_sha256)`（`raw_sha256` 是生成欄位）去重，重放安全。 */
export async function insertMcpUsage(pool: MonitorDbExecutor, input: InsertMcpUsageInput): Promise<WriteOutcome> {
  const [header] = await pool.execute<ResultSetHeader>(MCP_USAGE_INSERT_IGNORE_SQL, [
    input.service,
    input.identity ?? null,
    input.sourceIp ?? null,
    input.raw,
    dt(input.ts),
  ])
  const affected = (header as ResultSetHeader).affectedRows
  return affected > 0 ? { kind: 'inserted' } : { kind: 'guarded', guardedReason: 'guarded_other' }
}

export const TG_UNKNOWN_SENDER_INSERT_IGNORE_SQL = `
INSERT IGNORE INTO tg_unknown_senders (chat_id_enc, chat_id_bidx, sender_profile_enc, ts) VALUES (?, ?, ?, ?)
`.trim()

export interface InsertTgUnknownSenderInput {
  /** 密文；明文絕不進入本函式（MJ-C7），呼叫端必須先經 lib/crypto 加密。 */
  chatIdEnc: string
  chatIdBidx: Buffer
  senderProfileEnc?: string | null
  ts: string
}

/** `UNIQUE(chat_id_bidx, ts)` 去重。簽名只收密文與 bidx，明文永遠不會進入這一層。 */
export async function insertTgUnknownSender(pool: MonitorDbExecutor, input: InsertTgUnknownSenderInput): Promise<WriteOutcome> {
  const [header] = await pool.execute<ResultSetHeader>(TG_UNKNOWN_SENDER_INSERT_IGNORE_SQL, [
    input.chatIdEnc,
    input.chatIdBidx,
    input.senderProfileEnc ?? null,
    dt(input.ts),
  ])
  const affected = (header as ResultSetHeader).affectedRows
  return affected > 0 ? { kind: 'inserted' } : { kind: 'guarded', guardedReason: 'guarded_other' }
}

export const STATUS_LOG_TABLES = ['worker_status_log', 'service_status_log', 'tg_webhook_status_log'] as const
export type StatusLogTable = (typeof STATUS_LOG_TABLES)[number]

/**
 * *_log 三張表都是純歷史紀錄（無業務唯一鍵，PK 是 auto_increment id），直接 INSERT。
 * 這三張表結構彼此不同（欄位不完全一樣），呼叫端自行組好欄位/值——本函式只負責
 * 白名單表名，擋掉打錯表名的攻擊面（MAJOR-F4 的部分處置）。
 */
export async function insertStatusLogRow(
  pool: MonitorDbExecutor,
  table: StatusLogTable,
  columns: string[],
  values: unknown[],
): Promise<WriteOutcome> {
  if (!STATUS_LOG_TABLES.includes(table)) {
    throw new Error(`insertStatusLogRow: 不在白名單內的表名：${table}`)
  }
  if (columns.some(c => !/^[a-z_][a-z0-9_]*$/.test(c))) {
    throw new Error(`insertStatusLogRow: 欄位名格式不合法：${JSON.stringify(columns)}`)
  }
  const placeholders = columns.map(() => '?').join(', ')
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
  await pool.execute(sql, values)
  return { kind: 'inserted' }
}
