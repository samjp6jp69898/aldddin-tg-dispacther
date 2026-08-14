import { InlineKeyboard, type Context } from 'grammy'
import { queryCandidateTickets } from '../notion-integration/candidate-tickets.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

/**
 * 使用者在頂層選單（T29）點『BUG』後觸發：查該人在 Notion 的候選單（T6），
 * 組成 inline keyboard 回覆（不再經過 tracker 篩選——T7 已改為觸發後才做的
 * 技術同步，不影響清單內容）。每顆單獨立一行，callback_data 格式
 * claim:{ticket}；最下方固定加一顆『需求池』按鈕（callback_data:
 * reqpool:noop，UI 佔位，見 T9/T23），沒有候選單時也要有，讓使用者永遠有
 * 下一步可按。
 * 沒有候選單時明確回覆「目前沒有可認領工單」，不留空白或無回應。
 */
export async function sendTicketList(ctx: Context, techUser: TechUser): Promise<void> {
  const tickets = await queryCandidateTickets(techUser.notion_user_id)

  const keyboard = new InlineKeyboard()
  tickets.forEach(ticket => {
    keyboard.text(ticket, `claim:${ticket}`).row()
  })
  keyboard.text('需求池', 'reqpool:noop')

  const text = tickets.length === 0 ? '目前沒有可認領工單' : '你的可認領工單：'
  await ctx.reply(text, { reply_markup: keyboard })
}
