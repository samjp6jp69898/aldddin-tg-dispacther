import type { Bot } from 'grammy'
import { resolveTechUserByChatId } from '../user-resolution/tech-user.ts'

// grammy 的 secretToken（見 lib/webhook-server/bot.ts / server.ts）只驗證請求
// 真的來自 Telegram，不驗證是不是授權使用者；chat_id 白名單要在這一層自己做
// （webhook-transport 調查明確指出的分工，見 tasks.json T3 risk_notes）。

/**
 * 掛載 bot.on('message') 與 bot.on('callback_query:data')，白名單外的 chat_id
 * 一律靜默 return，不執行任何後續 Notion/tracker 查詢或 keyboard 組裝。
 * 白名單內的 chat_id 通過後往下流動——實際的候選單查詢與 inline keyboard 組裝
 * 由後續 task（T6/T8/T9/T10）接上，這裡先留掛載點。
 */
export function registerHandlers(bot: Bot): void {
  bot.on('message', async ctx => {
    const chatId = String(ctx.chat.id)
    const techUser = resolveTechUserByChatId(chatId)
    if (techUser === null) return // 白名單外：靜默 return

    // 通過白名單——先送 typing 讓使用者知道有在處理，實際查詢/組 keyboard 待 T6/T8/T9。
    await ctx.replyWithChatAction('typing')
  })

  bot.on('callback_query:data', async ctx => {
    const chatId = String(ctx.chat?.id ?? ctx.from.id)
    const techUser = resolveTechUserByChatId(chatId)
    if (techUser === null) {
      // 理論上白名單外的人永遠收不到 inline keyboard，這裡是防禦性重驗。
      // 仍要 answer 消掉 Telegram 端的 loading 圈，但不做任何查詢或分流。
      await ctx.answerCallbackQuery()
      return
    }

    // 通過白名單——實際的 reqpool:noop / claim:{ticket} 分流待 T9/T10 接上。
    await ctx.answerCallbackQuery()
  })
}
