// lib/cluster/artifact-sync.ts — head 端的跨機器產物同步（2026-09-08，
// pipeline-modes-project-docs/plan-pipeline-modes-v1.md §4.1／§4.2，Phase 4）。
//
// 問題：`只做問題分析` 的票可能派在 worker 上跑，產出的 obsidian/Debug/<ticket>/
// 只存在那一台；之後同事按「產出修復程式碼並開 MR」時，若派到別台就等於從頭
// 重跑（使用者明確不接受）。
//
// 方案（§0 裁定 4）：**head 拉取**——job-done 之後 head 用既有的 head→worker
// ssh 信任（`deploy/sync-workers.sh` 的一次性前提，本檔沿用同一條信任鏈與同一組
// ssh 參數）rsync 把產物拉回；派工到 worker 前若 head 有產物就先推過去。反向
// （worker→head 登入）刻意不做：2026-09-08 實測 worker→head 的 22 port 關閉、
// head 也沒有 authorized_keys，開這條等於新增一整片攻擊面。
//
// 硬性紀律：
// - 只處理 bug 票（`FAQ-\d+`）。demand（ALDREQ）不在範圍，它沒有續跑既有產物的模式。
// - 一切失敗只 log + 記 DB，**絕不 throw**：這是 best-effort 的旁路，不得反過來
//   影響 job-done 回應、sweeper 或派工正確性。
// - `execFile`（不經 shell）＋ argv 陣列，路徑與 host 都不做字串拼接進 shell；
//   ticket 先過 `FAQ_TICKET_RE`、host 先過白名單 regex，兩道都擋不住的一律放棄。
// - 逾時是 I/O 上限（打不通就放棄），不是拿等待解決正確性問題：拉取 30 秒、
//   推送 6 秒（派工在 grammy webhook 的 10 秒預算內，見 worker-client.ts 檔頭）。
// - 拉取**不動 worker 端檔案**（worker 那份是備援）；拉回 head 後也不自動 git
//   commit（obsidian/Debug 由人工批次 commit，維持現況）。

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'
import { dispatchMonitorWrite } from '../monitor-db/runtime.ts'
import { isoToMysqlDatetime3OrNull } from '../monitor-db/mysql-datetime.ts'
import { upsertTicketArtifactSync, type MonitorDbExecutor } from '../monitor-db/writes.ts'
import type { WorkerInfo } from './worker-registry.ts'

const execFileAsync = promisify(execFile)

const DEBUG_DIR = '/Users/user/aladdin/obsidian/Debug'
/** 與 deploy/sync-workers.sh 的 `SSH_USER=user` 同一個約定（README「同帳號同路徑」）。 */
const SSH_USER = 'user'
/** 逐字比照 sync-workers.sh 的 ssh 參數：免密（BatchMode）、8 秒連線上限、首次連線接受金鑰。 */
export const SSH_TRANSPORT = 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new'
export const PULL_TIMEOUT_MS = 30_000
export const PUSH_TIMEOUT_MS = 6_000
/** last_error 欄寬（VARCHAR(255)，migration 005）。 */
const LAST_ERROR_MAX = 255

export const FAQ_TICKET_RE = /^FAQ-\d+$/
/** worker.url 抽出的 host 白名單：LAN 上只會是 IPv4 或主機名，其餘形狀（IPv6
 * 的 `[::1]`、含 `@`/`:` 的怪值）一律拒絕——它會被放進 `user@<host>:` 這個
 * rsync 位址，不能讓奇怪的字元有機會改變語意。 */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type PullResult = { ok: true; fileCount: number } | { ok: false; error: string }

export function isSyncableTicket(ticket: unknown): ticket is string {
  return typeof ticket === 'string' && FAQ_TICKET_RE.test(ticket)
}

export function ticketDebugDir(ticket: string): string {
  return join(DEBUG_DIR, ticket)
}

/** 「這張票有沒有既有分析產物」的判定檔（§4.2／§4.3 共用同一個檔名）。 */
export function analysisNotesPath(ticket: string): string {
  return join(DEBUG_DIR, ticket, `${ticket}-analysis-notes.md`)
}

/** 從 worker.url（`http://10.0.0.5:8801`）抽 ssh 用的 host；不合法回 null。 */
export function workerHost(url: string): string | null {
  try {
    const h = new URL(url).hostname
    return HOST_RE.test(h) ? h : null
  } catch {
    return null
  }
}

/**
 * rsync 的 argv（純函式，給單元測試逐項比對）。**不含任何 shell 字串**：
 * `-e` 的值是單一 argv 元素，由 rsync 自己解析成 ssh 命令，不經 /bin/sh。
 * 兩端都以 `/` 結尾＝同步「目錄內容」而非「把目錄塞進目錄」；目的地最後一層
 * 目錄不存在時由 rsync 自行建立（上層 Debug/ 兩端都必定存在）。
 */
export function buildRsyncArgs(direction: 'pull' | 'push', host: string, ticket: string): string[] {
  const local = `${join(DEBUG_DIR, ticket)}/`
  const remote = `${SSH_USER}@${host}:${DEBUG_DIR}/${ticket}/`
  return direction === 'pull' ? ['-az', '-e', SSH_TRANSPORT, remote, local] : ['-az', '-e', SSH_TRANSPORT, local, remote]
}

/** head 本機有沒有這張票的分析產物（§4.2 的推送前提、§4.3 A1 的判定）。 */
export function headHasArtifacts(ticket: string): boolean {
  if (!isSyncableTicket(ticket)) return false
  try {
    return existsSync(analysisNotesPath(ticket))
  } catch {
    return false
  }
}

/** 拉回後 head 本機該票目錄的檔案數（觀察用的量化欄位，不是正確性依據）。 */
function countLocalFiles(ticket: string): number {
  try {
    return readdirSync(ticketDebugDir(ticket), { withFileTypes: true }).filter(e => e.isFile()).length
  } catch {
    return 0
  }
}

function describeExecError(err: unknown): string {
  const e = err as { killed?: boolean; stderr?: unknown; message?: unknown } | null
  if (e?.killed === true) return `rsync 逾時被中止`
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim().split('\n').filter(Boolean).pop() : ''
  const msg = stderr || (typeof e?.message === 'string' ? e.message : String(err))
  return msg.slice(0, LAST_ERROR_MAX)
}

async function runRsync(args: string[], timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileAsync('rsync', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeExecError(err) }
  }
}

/** `ticket_artifact_sync` 的一次記錄（非阻斷、落 spool，比照 stage-snapshot.ts）。 */
function recordSync(input: { ticket: string; sourceHost: string; lastAttemptAt: string; headSyncedAt: string | null; lastError: string | null; fileCount: number | null }): void {
  const args = {
    // 這張表的列由 ticket 擁有、不屬於任何一次 run（拉取是 head 的旁路動作）：
    // `runId: null` 只是為了滿足 dispatchMonitorWrite 的 spool 條目形狀，
    // upsertTicketArtifactSync 本身不讀它。
    runId: null,
    ticket: input.ticket,
    sourceHost: input.sourceHost,
    lastAttemptAt: input.lastAttemptAt,
    headSyncedAt: input.headSyncedAt,
    lastError: input.lastError === null ? null : input.lastError.slice(0, LAST_ERROR_MAX),
    fileCount: input.fileCount,
  }
  void dispatchMonitorWrite('upsertTicketArtifactSync', args, pool => upsertTicketArtifactSync(pool, args)).catch(err =>
    console.error(`artifact-sync: ${input.ticket} 的 ticket_artifact_sync 寫入失敗（不影響同步結果）: ${err}`),
  )
}

/**
 * §4.1：把 worker 上這張票的 Debug 目錄拉回 head（job-done 之後 fire-and-forget，
 * 以及 sweeper 每輪對失敗票的重試）。成功/失敗都記一列 `ticket_artifact_sync`。
 */
export async function pullTicketArtifacts(worker: WorkerInfo, ticket: string): Promise<PullResult> {
  if (!isSyncableTicket(ticket)) return { ok: false, error: 'ticket 格式不合法（只同步 FAQ- 票）' }
  const now = new Date().toISOString()
  const host = workerHost(worker.url)
  if (host === null) {
    const error = `worker ${worker.name} 的 url 無法抽出合法 host：${worker.url}`
    console.error(`artifact-sync: ${ticket} 拉取放棄——${error}`)
    recordSync({ ticket, sourceHost: worker.name, lastAttemptAt: now, headSyncedAt: null, lastError: error, fileCount: null })
    return { ok: false, error }
  }
  const r = await runRsync(buildRsyncArgs('pull', host, ticket), PULL_TIMEOUT_MS)
  if (!r.ok) {
    console.error(`artifact-sync: ${ticket} 從 worker ${worker.name}(${host}) 拉取失敗（sweeper 會重試）: ${r.error}`)
    recordSync({ ticket, sourceHost: worker.name, lastAttemptAt: now, headSyncedAt: null, lastError: r.error, fileCount: null })
    return { ok: false, error: r.error }
  }
  const fileCount = countLocalFiles(ticket)
  console.error(`artifact-sync: ${ticket} 已從 worker ${worker.name}(${host}) 拉回 ${fileCount} 個檔案`)
  recordSync({ ticket, sourceHost: worker.name, lastAttemptAt: now, headSyncedAt: now, lastError: null, fileCount })
  return { ok: true, fileCount }
}

/**
 * §4.2：派工到 worker 之前把 head 本機的產物推過去。只在 head 真的有產物時呼叫
 * （呼叫端 dispatch.ts 已先判 `headHas`，本函式再自我防護一次）。回 false ＝
 * 呼叫端必須改走本機執行（絕不在缺產物的機器上開跑）。
 */
export async function pushTicketArtifacts(worker: WorkerInfo, ticket: string): Promise<boolean> {
  if (!isSyncableTicket(ticket) || !headHasArtifacts(ticket)) return false
  const host = workerHost(worker.url)
  if (host === null) {
    console.error(`artifact-sync: ${ticket} 推送放棄——worker ${worker.name} 的 url 無法抽出合法 host：${worker.url}`)
    return false
  }
  const r = await runRsync(buildRsyncArgs('push', host, ticket), PUSH_TIMEOUT_MS)
  if (!r.ok) {
    console.error(`artifact-sync: ${ticket} 推送到 worker ${worker.name}(${host}) 失敗，改走 head 本機執行: ${r.error}`)
    return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────
// DB 讀取端（§4.3 A2 的「產物在哪台」＋ sweeper 的重試清單）
// ─────────────────────────────────────────────────────────────────────────
//
// 兩支都吃注入的 executor、DB 關閉時由呼叫端（cluster-head.ts wiring）傳 null
// ⇒ 整段 no-op；任何查詢例外都吞成 null/空陣列，讀不到 DB 一律退回「查無紀錄」
// 的既有流程（§3：DB 關閉不得讓任何路徑失敗）。

export const ARTIFACT_HOST_FROM_SYNC_SQL = 'SELECT source_host FROM ticket_artifact_sync WHERE ticket = ?'
export const ARTIFACT_HOST_FROM_STAGES_SQL =
  'SELECT host FROM ticket_stages WHERE ticket = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1'

/**
 * 這張票的既有產物在哪台機器：先看 `ticket_artifact_sync.source_host`（head
 * 拉取的來源），缺才退 `ticket_stages` 最新一列的 host。
 *
 * `selfHost` ＝ head 自己（MON_HOST）：查出來是自己時回 null——呼叫端會走到這裡
 * 一定是因為 `headHasArtifacts()` 已經是 false，紀錄說「在 head」就代表那份紀錄
 * 過時（目錄被改名/刪除），這種情況該視同「查無紀錄」重新分析，而不是回一句
 * 「產物在 head，該機離線」的鬼話。
 */
export async function queryArtifactHost(pool: MonitorDbExecutor, ticket: string, selfHost: string): Promise<string | null> {
  if (!isSyncableTicket(ticket)) return null
  const pick = (rows: unknown, col: string): string | null => {
    const row = (rows as RowDataPacket[] | null)?.[0] as Record<string, unknown> | undefined
    const v = row?.[col]
    return typeof v === 'string' && v !== '' ? v : null
  }
  const [syncRows] = await pool.execute<RowDataPacket[]>(ARTIFACT_HOST_FROM_SYNC_SQL, [ticket])
  const host = pick(syncRows, 'source_host') ?? pick((await pool.execute<RowDataPacket[]>(ARTIFACT_HOST_FROM_STAGES_SQL, [ticket]))[0], 'host')
  return host === null || host === selfHost ? null : host
}

/** sweeper 每輪最多重試幾張票：單張最壞 30 秒，5 張＝2.5 分鐘，遠小於 10 分鐘的 sweep 週期。 */
export const ARTIFACT_RETRY_BATCH = 5
export const ARTIFACT_RETRY_MIN_AGE_MS = 10 * 60_000

export const PENDING_ARTIFACT_PULL_SQL = `
SELECT ticket, source_host FROM ticket_artifact_sync
 WHERE head_synced_at IS NULL AND last_attempt_at IS NOT NULL AND last_attempt_at < ?
 ORDER BY last_attempt_at ASC
 LIMIT ${ARTIFACT_RETRY_BATCH}
`.trim()

export async function queryPendingArtifactPulls(pool: MonitorDbExecutor, beforeIso: string): Promise<{ ticket: string; sourceHost: string }[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(PENDING_ARTIFACT_PULL_SQL, [isoToMysqlDatetime3OrNull(beforeIso)])
  return ((rows as RowDataPacket[] | null) ?? [])
    .map(r => ({ ticket: String((r as { ticket?: unknown }).ticket ?? ''), sourceHost: String((r as { source_host?: unknown }).source_host ?? '') }))
    .filter(r => isSyncableTicket(r.ticket) && r.sourceHost !== '')
}

/**
 * §4.1 的重試：remote sweeper 每輪（10 分鐘）順便對「head 沒有完整副本、且距上次
 * 嘗試超過 10 分鐘」的票再拉一次。不新增 timer——掛在既有 sweep 週期上。
 * 回傳實際嘗試的張數（測試/log 用）。DB 關閉（pool=null）或任何例外都回 0。
 */
export async function retryPendingArtifactPulls(deps: {
  pool: MonitorDbExecutor | null
  listWorkers: () => WorkerInfo[]
  now?: () => number
  pull?: (worker: WorkerInfo, ticket: string) => Promise<PullResult>
}): Promise<number> {
  if (deps.pool === null) return 0
  try {
    const cutoff = new Date((deps.now?.() ?? Date.now()) - ARTIFACT_RETRY_MIN_AGE_MS).toISOString()
    const pending = await queryPendingArtifactPulls(deps.pool, cutoff)
    if (pending.length === 0) return 0
    const workers = deps.listWorkers()
    const pull = deps.pull ?? pullTicketArtifacts
    let attempted = 0
    for (const p of pending) {
      const w = workers.find(x => x.name === p.sourceHost)
      if (!w) continue // 產物所在機器已不在名冊（退役/停用）：這輪跳過，不改任何狀態
      attempted += 1
      await pull(w, p.ticket) // 失敗自己記 DB，不 throw
    }
    return attempted
  } catch (err) {
    console.error(`artifact-sync: 待拉取清單處理失敗（下一輪 sweep 會再試）: ${err}`)
    return 0
  }
}
