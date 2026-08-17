import { InlineKeyboard, type Context } from 'grammy'

/**
 * T29：白名單通過後的頂層選單（取代 T8 原本「發訊息就直接列 Bug 清單」的行為，
 * 使用者在 T17 驗收現場當場定案改版）。只有兩顆按鈕：
 *   - 'menu:bug'    → 觸發既有 T6/T8 查詢＋列出候選單（whitelist.ts 分流）
 *   - 'reqpool:noop' → T9 建立此按鈕時是固定回「開發中」的佔位，T32 起已
 *     改成真的查需求池（T31）並列出候選單（whitelist.ts 分流），callback_data
 *     名稱沿用 T9 當初取的 'reqpool:noop'，不是還在佔位
 * 這裡本身不查任何 Notion/tracker/bug-lock，純組 keyboard 回覆。
 */
export async function sendTopLevelMenu(ctx: Context): Promise<void> {
  const keyboard = new InlineKeyboard().text('BUG', 'menu:bug').text('需求池', 'reqpool:noop')
  await ctx.reply('請選擇：', { reply_markup: keyboard })
}
