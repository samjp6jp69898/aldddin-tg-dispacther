/**
 * changelog-group-allowlist.ts — 哪些群組可以用「@changelog bot /changelog ...」。
 *
 * 允許清單由 head 機後台（tg-monitor dashboard 127.0.0.1:8799）動態設定、記錄在監控 DB 的
 * `changelog_allowed_groups`（migration 008；使用者 2026-10-28 定案：不放 .env）。寫入端是
 * lib/registry/changelog-groups-cli.ts，這裡只讀。
 *
 * changelog bot 是獨立程序（changelog-bot.ts），每則訊息都呼叫這裡重新查詢、不快取，後台改完
 * 不必重啟 bot。查詢失敗（DB 斷線、逾時、缺連線環境變數）一律視同「不允許」：回 false 並記
 * log，不讓例外中斷 bot 的 polling；私訊 /changelog 不經過這裡，不受影響。查詢本體在
 * changelog-group-allowlist-query.ts（拆檔原因見該檔檔頭）。
 */
import { queryChangelogGroupAllowed, type AllowlistQueryExecutor } from './changelog-group-allowlist-query.ts'

let executor: AllowlistQueryExecutor | null = null

async function getExecutor(): Promise<AllowlistQueryExecutor> {
  if (executor) return executor
  // 延遲到第一次真的有人 @bot /changelog 才建 pool：bot 啟動不依賴 DB，DB 沒起來也照常 polling。
  // bot 只跑在 head，連線帳號固定 mon_head（MON_DB_* 由 launchd/run-changelog-bot.sh export）。
  const { createMonitorPool } = await import('../monitor-db/pool.ts')
  executor = createMonitorPool('mon_head', { connectionLimit: 1 })
  return executor
}

export async function isChangelogGroupChat(chatId: string): Promise<boolean> {
  return queryChangelogGroupAllowed(getExecutor, chatId)
}
