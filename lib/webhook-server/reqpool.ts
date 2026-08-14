import type { Context } from 'grammy'

/**
 * 需求池按鈕（UI 佔位，callback_data: reqpool:noop）。
 * 完整功能見 tasks.json T23（deferred）——這裡固定回覆「開發中」，
 * 不接任何 Notion/tracker/bug-lock 查詢或後續邏輯。
 */
export async function handleReqPoolNoop(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery()
  await ctx.reply('開發中')
}
