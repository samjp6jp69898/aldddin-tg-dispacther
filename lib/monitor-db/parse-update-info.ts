// lib/monitor-db/parse-update-info.ts — 解析 mysql2 UPDATE 回傳的 info 字串。
//
// 依據 plan-db-as-truth-v3.2.md 裁定 2 §6.3：
//   形狀 B（守衛式 UPDATE）的三態判定訊號來源是 ResultSetHeader.info 字串的
//   `Rows matched: X  Changed: Y  Warnings: Z`，不依賴 affectedRows（那是形狀
//   A / ODKU 專用的訊號，見 pool.ts 的 -FOUND_ROWS 說明）。
//   這個字串是 server 端 lc_messages 可在地化的訊息（S4 第四條斷言：
//   `SHOW VARIABLES LIKE 'lc_messages'` 必須是 en_US），regex 綁死在英文格式上。

export interface UpdateInfo {
  matched: number
  changed: number
  warnings: number
}

const UPDATE_INFO_RE = /^Rows matched:\s*(\d+)\s+Changed:\s*(\d+)\s+Warnings:\s*(\d+)$/

/**
 * 解析純 UPDATE（非 ODKU）回傳的 `ResultSetHeader.info`。
 * 格式不符（例如 lc_messages 不是 en_US、或這支語句其實是 ODKU）回 null，
 * 呼叫端必須把 null 當成「訊號不可信」處理，不得臆測 matched/changed。
 */
export function parseUpdateInfo(info: string | undefined | null): UpdateInfo | null {
  if (!info) return null
  const m = UPDATE_INFO_RE.exec(info.trim())
  if (!m) return null
  return { matched: Number(m[1]), changed: Number(m[2]), warnings: Number(m[3]) }
}
