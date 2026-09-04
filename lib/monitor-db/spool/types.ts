// lib/monitor-db/spool/types.ts
//
// spool 模組共用型別。與尚未存在的 lib/monitor-db/writes.ts（DB client 負責人
// 的檔案）之間的介面，先以本檔定義的 thin type 頂著——整合時由對方符合這裡的
// 簽名，不是這裡去等對方存在。依據：
// plan-db-as-truth-v3.2.md 【G】§6.5（spool 修訂全節）。

/** spool 目錄（v3.2 §6.5(a)）：0700，單一 monitor-spool.jsonl 這條舊路徑已廢除。 */
export const SPOOL_DIR = '/Users/user/aladdin/telegram-dispatcher/logs/spool'

/** 重放者互斥鎖檔名（§6.5(d)）。 */
export const REPLAYER_LOCK_NAME = '.replayer.lock'

/**
 * 固定身分名集合（v3.2 §6.5(a)）。
 * 長駐：server / worker-agent / tg-monitor / log-intake（裁定 4 新增的行程）。
 * 短命：post-run-notify / post-run-demand / cli / backfill。
 */
export type SpoolWriterName =
  | 'server'
  | 'worker-agent'
  | 'tg-monitor'
  | 'log-intake'
  | 'post-run-notify'
  | 'post-run-demand'
  | 'cli'
  | 'backfill'

/**
 * spool 條目（§6.5(a)）。硬規則（呼叫端必須遵守，寫入時就要滿足，不是重放
 * 時才檢查）：
 *   - `args` 只收密文與 bidx（MJ-C7），明文永不進 spool。
 *   - `args` 內不得攜帶任何相對時間或「執行時求值」的表達式——`ts` 一律是
 *     寫入當下算好的絕對 ISO 字串。
 *   - 【G:MJ-G2】`run_id` 不得為空、不得留給重放時再解析；writer.ts 對空
 *     run_id 會直接拒絕寫入並丟例外（見 writer.ts 的硬性檢查）。
 *     **2026-09-02 指揮官裁定（Phase 4）：這條硬規則的適用範圍收斂成 per-fn**
 *     ——它的原始理由是「row 的身分不得留給重放時求值」，而身分帶 `run_id`
 *     的只有 `runs` 與 `agent_runs` 兩張表；`file_offsets`（PK=(host,path)）、
 *     `mcp_usage`（PK=id + UNIQUE(service,raw_sha256)）、`monitor_heartbeat`
 *     （PK=(host,writer)）、`*_log`、`tg_unknown_senders` 的列**結構上沒有
 *     run_id**，硬要它們帶一個假值反而是把「無主」偽裝成「有主」。
 *     因此 `run_id` 型別放寬為 `string | null`，並由 writer.ts 依 `fn` 分流檢查
 *     （見該檔的 `RUN_SCOPED_SPOOL_FNS`）。重放端（replayer.ts / replay-dead.ts /
 *     apply-entry.ts）本來就完全不看 `run_id`，不需要任何配套改動。
 */
export interface SpoolEntry {
  seq: number
  ts: string
  host: string
  /** `runs`/`agent_runs` 類的 fn 必為非空字串；其餘表的 fn 允許 `null`（見上）。 */
  run_id: string | null
  fn: string
  args: unknown[]
}

/**
 * 游標檔內容（§6.5(c)）。由重放者獨佔讀寫，寫入者永不碰它。
 * `failing`：seq（字串鍵，JSON 物件鍵本來就只能是字串）→ 累計失敗次數，
 * 用於 §6.5(g) 的 dead-letter 判定（達 5 次移出）。
 */
export interface CursorState {
  acked_bytes: number
  acked_seq: number
  failing: Record<string, number>
  updated_at: string
}

export function emptyCursor(): CursorState {
  return { acked_bytes: 0, acked_seq: 0, failing: {}, updated_at: new Date(0).toISOString() }
}

// 資料檔檔名格式：<writer>.<pid>.<startEpochMs>.jsonl。刻意不比對 writer 是否
// 落在 SpoolWriterName 集合內（回收器/重放者要能容忍未來新增的身分名，值域
// 檢查交給寫入端），只認語法形狀。這個 regex 同時負責把 `<same>.dead.jsonl`
// 與 `<same>.jsonl.cursor` 排除在外（見檔尾的手算驗證）。
const FILE_NAME_RE = /^([a-zA-Z0-9_-]+)\.(\d+)\.(\d+)\.jsonl$/

export function buildSpoolFileName(writer: string, pid: number, startEpochMs: number): string {
  return `${writer}.${pid}.${startEpochMs}.jsonl`
}

export function parseSpoolFileName(name: string): { writer: string; pid: number; startEpochMs: number } | null {
  const m = FILE_NAME_RE.exec(name)
  if (!m) return null
  return { writer: m[1]!, pid: Number(m[2]), startEpochMs: Number(m[3]) }
}

export function isSpoolDataFileName(name: string): boolean {
  return FILE_NAME_RE.test(name)
}
