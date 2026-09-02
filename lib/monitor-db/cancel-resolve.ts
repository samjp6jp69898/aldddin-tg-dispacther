// lib/monitor-db/cancel-resolve.ts — ticket → run_id 的五段解析（cancel 專用）。
//
// 依據：
//   plan-db-as-truth-v3.2.md §6.4(4) 修訂（BL-G2，五段解析、永遠有結果、永遠照殺）
//   impl-errata-g2.md MJ-H1（指揮官裁定，凌駕 v3.2 原文的 R2→R3 次序）：
//     「確定性來源優先——R3（legacy_key/stdout_path 確定性對位）排在 R2（marker）
//      之前；R2 命中時仍須通過『marker.runId 對應列的 ticket/kind 與請求一致』
//      的無 DB 自我驗證，不一致→降級下一段並計 cancel_marker_mismatch」。
//
// 次序（本檔實作，errata 凌駕 v3.2 原文）：
//   R1（pid 對位，DB）→ R3（legacy_key/stdout_path 對位，DB，確定性）
//   → R2（本機 active-pipeline marker，無 DB，需 kind 自我驗證）
//   → R4（最新 running，DB，猜測，WARN）→ R5（placeholder，WARN）
//
// 為什麼 R3 排到 R2 前面（G2 review plan-review-G2.md MJ-H1 節）：
//   active-pipeline-marker.ts 的標記檔是「每張 ticket 一份、單值」（檔名只有
//   ticket，沒有 run_id/pid），同票 auto-retry 交疊時，後一個 run 的
//   markPipelineActive 會直接覆寫前一個 run 的標記——若 R2 排在 R3 之前，
//   使用者取消的是「先 spawn、ps 上還活著」的那個 run，但旗標卻可能被寫到
//   marker 覆寫後留下的「後一個 run」身上，正是 A-MJ-5 / B-MAJOR-4 原始 bug
//   的同型重現。R3 用 ps 反推的 legacy_key/stdout_path 對位是確定性的（同票
//   兩個 run 的 legacy_key 一定不同，因為 ISO 時間戳不同），排在 R2 之前可以
//   在「常態」（R1 因非阻斷寫入尚未落地而失效）下優先選中正確的那一個。
//
// 「永遠有結果、永遠照殺」——本模組只負責回傳一個 run_id 與可信度標籤，殺不殺
// 完全不受這裡影響（呼叫端：tg-monitor/lib/ingest.ts cancelPipeline，因跨 repo
// 沒有 import 關係而複製本檔演算法，見該檔頭部說明）。
import type { RowDataPacket } from 'mysql2/promise'
import { MON_HOST } from './env.ts'
import type { MonitorDbExecutor } from './writes.ts'
import type { CancelResolvedBy, RunKind } from './types.ts'

export interface CancelResolveTarget {
  /** ps 快照命中的 wrapper pid（cachedRunning 那一筆）。 */
  pid: number
  /** 由 pid 展開的祖先/子孫 pid 集合（含 pid 自己）。R1 用它對位 runs.pid——
   * `runs.pid` 記的是 spawnDetachedProcess 拿到的 wrapper pid。空陣列時退回
   * 只用 `pid` 自己。 */
  pidSet: number[]
}

export interface MarkerSnapshot {
  /** 本機 active-pipeline marker 檔內解出的 runId；檔案不存在／JSON 壞掉／
   * 欄位缺 runId 一律 null——這是「不可用」，不是「mismatch」。 */
  runId: string | null
  /** marker 檔內記錄的 kind；null 代表讀不到（同上，不是 mismatch）。 */
  kind: RunKind | null
}

export interface ResolveRunIdInput {
  kind: RunKind
  ticket: string
  target: CancelResolveTarget
  /** ps 反推的 legacy_key 對位鍵（`<ticket>.<ISO>`，呼叫端算好傳入——
   * deriveLegacyKey 不在本模組職責內，那是 ps 命令列/檔名反推，環境相依）。 */
  legacyKey: string | null
  stdoutPath: string | null
  marker: MarkerSnapshot
}

export interface ResolveRunIdResult {
  runId: string
  resolvedBy: CancelResolvedBy
  /** R2 命中但 kind 自我驗證不一致（errata MJ-H1）→ true；只有真的走過 R2
   * 且不一致時才是 true，供呼叫端計 cancel_marker_mismatch WARN。 */
  markerMismatch: boolean
}

function buildInPlaceholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/** R1：ps 快照對得上 pid 的那列（首選，需要 W1 已落地）。 */
export function buildR1PidMatchSql(pidCount: number): string {
  return `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = ? AND lifecycle_rank = 30 AND outcome IS NULL
   AND pid IN (${buildInPlaceholders(Math.max(pidCount, 1))})
`.trim()
}

/** R3（errata MJ-H1：排在 R2 之前）：legacy_key / stdout_path 的零成本確定性對位。 */
export const R3_LEGACY_KEY_SQL = `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = ? AND lifecycle_rank = 30 AND outcome IS NULL
   AND (legacy_key = ? OR stdout_path = ?)
`.trim()

/** R4：取最新 running 列（猜測，猜錯有明確代價，見 plan §6.4(4) R4）。 */
export const R4_LATEST_RUNNING_SQL = `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = ? AND lifecycle_rank = 30 AND outcome IS NULL
 ORDER BY started_at DESC, created_at DESC LIMIT 1
`.trim()

/** 恰好一列才採用；0 列或 >1 列（不明確）都降級到下一段，不猜。 */
async function selectSingleRunId(pool: MonitorDbExecutor, sql: string, params: unknown[]): Promise<string | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(sql, params)
  const r = rows as unknown as Array<{ run_id: string }>
  if (r.length !== 1) return null
  return r[0]!.run_id
}

async function resolveR1(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<string | null> {
  const pidSet = input.target.pidSet.length > 0 ? input.target.pidSet : [input.target.pid]
  const sql = buildR1PidMatchSql(pidSet.length)
  return selectSingleRunId(pool, sql, [MON_HOST, input.ticket, input.kind, ...pidSet])
}

async function resolveR3(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<string | null> {
  if (!input.legacyKey && !input.stdoutPath) return null // 兩者都沒有 → 這段沒有意義，直接降級
  // `col = NULL` 在 SQL 裡恆為 unknown（不會誤判成「兩者皆 NULL 即相等」）；
  // 這裡故意讓缺少的那一半用 null 傳入，交給資料庫的三值邏輯處理。
  return selectSingleRunId(pool, R3_LEGACY_KEY_SQL, [MON_HOST, input.ticket, input.kind, input.legacyKey ?? null, input.stdoutPath ?? null])
}

/**
 * R2：本機 marker，純函式、無 DB。
 * 【errata MJ-H1】自我驗證：marker 記錄的 kind 若與本次請求的 kind 不一致，
 * 視為 mismatch（ticket 一致性由呼叫端讀取路徑本身保證——marker 檔已經是用
 * 這張 ticket 找到的，不需要在這裡重複驗證）。檔案不存在/壞掉/沒有 runId
 * 一律回 null（不可用，不算 mismatch）。
 */
function resolveR2(input: ResolveRunIdInput): { runId: string; mismatch: boolean } | null {
  const { marker, kind } = input
  if (!marker.runId) return null
  if (marker.kind !== null && marker.kind !== kind) {
    return { runId: marker.runId, mismatch: true }
  }
  return { runId: marker.runId, mismatch: false }
}

async function resolveR4(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<string | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(R4_LATEST_RUNNING_SQL, [MON_HOST, input.ticket, input.kind])
  const r = rows as unknown as Array<{ run_id: string }>
  return r.length > 0 ? r[0]!.run_id : null
}

function mintPlaceholderRunId(): string {
  return crypto.randomUUID()
}

/**
 * 五段解析主體。永遠有結果（R5 保證收斂），呼叫端一律照殺，不受這裡影響。
 * WARN 級告警（`cancel_marker_mismatch` / `cancel_runid_fallback` /
 * `cancel_runid_placeholder`）以 `console.warn` 落地——本模組不擁有告警管線，
 * 呼叫端（或部署層的 log 收集）決定要不要另外升級成 TG 通知。
 */
export async function resolveRunId(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<ResolveRunIdResult> {
  const r1 = await resolveR1(pool, input)
  if (r1) return { runId: r1, resolvedBy: 'pid_match', markerMismatch: false }

  // errata MJ-H1：確定性來源優先於 marker——R3 排在 R2 之前（v3.2 原文的
  // R2→R3 已被指揮官裁定覆寫，理由見檔頭）。
  const r3 = await resolveR3(pool, input)
  if (r3) return { runId: r3, resolvedBy: 'legacy_key', markerMismatch: false }

  const r2 = resolveR2(input)
  if (r2 && !r2.mismatch) return { runId: r2.runId, resolvedBy: 'marker', markerMismatch: false }
  const markerMismatch = r2?.mismatch === true
  if (markerMismatch) {
    console.warn(
      `cancel_marker_mismatch: ticket=${input.ticket} kind=${input.kind} ` +
        `markerRunId=${r2!.runId} markerKind=${input.marker.kind}（marker 的 kind 與請求不一致，` +
        `降級到下一段，見 impl-errata-g2.md MJ-H1）`,
    )
  }

  const r4 = await resolveR4(pool, input)
  if (r4) {
    console.warn(
      `cancel_runid_fallback: ticket=${input.ticket} kind=${input.kind} runId=${r4}` +
        `（R1/R2/R3 皆未命中，採用最新 running 列，猜錯風險見 plan-db-as-truth-v3.2.md §6.4(4) R4）`,
    )
    return { runId: r4, resolvedBy: 'latest_running', markerMismatch }
  }

  const placeholder = mintPlaceholderRunId()
  console.warn(`cancel_runid_placeholder: ticket=${input.ticket} kind=${input.kind} runId=${placeholder}（R1–R4 全部落空，鑄孤兒佔位列）`)
  return { runId: placeholder, resolvedBy: 'placeholder', markerMismatch }
}
