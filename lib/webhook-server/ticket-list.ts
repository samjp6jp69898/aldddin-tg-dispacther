import { InlineKeyboard, type Context } from 'grammy'
import { queryCandidateTickets } from '../notion-integration/candidate-tickets.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

/**
 * 白名單通過後：查該人在 Notion 的候選單（T6），組成 inline keyboard 回覆
 * （不再經過 tracker 篩選——T7 已改為觸發後才做的技術同步，不影響清單內容）。
 * 每顆按鈕 callback_data 格式 claim:{ticket}。
 * 沒有候選單時明確回覆「目前沒有可認領工單」，不留空白或無回應。
 */
export async function sendTicketList(ctx: Context, techUser: TechUser): Promise<void> {
  const tickets = queryCandidateTickets(techUser.notion_user_id)

  if (tickets.length === 0) {
    await ctx.reply('目前沒有可認領工單')
    return
  }

  const keyboard = new InlineKeyboard()
  tickets.forEach((ticket, i) => {
    keyboard.text(ticket, `claim:${ticket}`)
    if (i < tickets.length - 1) keyboard.row() // 每顆按鈕獨立一行，但不留結尾空 row
  })

  await ctx.reply('你的可認領工單：', { reply_markup: keyboard })
}
