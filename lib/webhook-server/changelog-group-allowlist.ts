/**
 * changelog-group-allowlist.ts — 哪些群組可以用「@changelog bot /changelog ...」。
 *
 * 允許清單由 head 機後台動態設定、記錄在 DB（使用者 2026-10-28 定案：不放 .env），
 * 實作交接中，見 HANDOFF-changelog-bot-group-ids.md。changelog bot 是獨立程序
 * （changelog-bot.ts），每則訊息都呼叫這裡重新查詢、不快取，後台改完不必重啟 bot。
 *
 * 尚未接上 DB 前一律回 false：群組觸發關閉，私訊 /changelog 不受影響。
 */
export async function isChangelogGroupChat(_chatId: string): Promise<boolean> {
  return false
}
