// lib/log-shipper/cursor-restore.ts — 從 file_offsets 還原 shipper 的續讀游標。
//
// shipper.ts 檔頭明訂這件事不屬於它：「本模組不做『從 DB 讀回游標』這件事，
// 那是掛載端的職責」。掛載端（intake-server.ts / worker-agent.ts）就是本檔的
// 使用者，經 `LogShipperDeps.initialCursors` 注入。
//
// ── 為什麼失敗時回 null 而不是回空物件 ──────────────────────────────────────
// 空物件在 shipper 眼中不是「查不到」，是「這些檔我一個都沒讀過」——它會對每個
// 檔從 offset 0 重讀，把整份歷史重送一次。目前 head 的 logs/ 是 151.8 MB／170 個
// 檔，一次 DB 讀取失敗就會變成一次全量重送。
//
// 所以「問不到答案」與「答案是沒有游標」必須分開回傳（同 D42 的精神：未評估
// 不得印成該量的零值）。null = 問不到，呼叫端該做的是**這一輪不要啟動**、下一輪
// 再試，而不是拿空游標開跑。

import type { RowDataPacket } from 'mysql2/promise'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'
import type { TailCursor } from './types.ts'

export const CURSOR_RESTORE_SQL = 'SELECT path, inode, `offset` FROM file_offsets WHERE host = ?'

/**
 * 回傳 `{ [path]: {inode, offset} }`；查詢失敗回 `null`（見檔頭）。
 *
 * `inode` 欄位可為 NULL（schema 允許）——那種列還原不出可信游標，
 * 直接略過該筆：shipper 會把它當成沒見過的檔從 0 讀起，是**保守的重複**
 * 而不是缺口，符合「結構上只重複、不缺口」的核心不變式。
 */
export async function restoreCursorsFromDb(
  executor: MonitorDbExecutor,
  host: string,
): Promise<Record<string, TailCursor> | null> {
  try {
    const [rows] = await executor.execute<RowDataPacket[]>(CURSOR_RESTORE_SQL, [host])
    const out: Record<string, TailCursor> = {}
    for (const r of rows as RowDataPacket[]) {
      const row = r as { path?: unknown; inode?: unknown; offset?: unknown }
      if (typeof row.path !== 'string') continue
      // 先擋 null/undefined 再轉數字：`Number(null)` 是 **0**，而 0 是 finite，
      // 只靠 Number.isFinite 會讓 inode=NULL 的列變成一個看起來合法的 inode 0，
      // 註解說要略過、程式卻放行（本檔的測試就是抓這一條）。
      if (row.inode === null || row.inode === undefined) continue
      if (row.offset === null || row.offset === undefined) continue
      const inode = Number(row.inode)
      const offset = Number(row.offset)
      if (!Number.isFinite(inode) || !Number.isFinite(offset)) continue
      out[row.path] = { inode, offset }
    }
    return out
  } catch {
    return null
  }
}
