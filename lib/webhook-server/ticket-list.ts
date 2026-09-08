import { InlineKeyboard, type Context } from 'grammy'
import { queryCandidateTicketsWithMode } from '../notion-integration/candidate-tickets.ts'
import { BUG_MODE_LABEL } from '../pipeline-runner/bug-mode.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

/**
 * 使用者在頂層選單（T29）點『BUG』後觸發：查該人在 Notion 的候選單（T6），
 * 組成 inline keyboard 回覆（不再經過 tracker 篩選——T7 已改為觸發後才做的
 * 技術同步，不影響清單內容）。每顆單獨立一行，callback_data 格式
 * claim:{ticket}；按鈕文字附上該單 Notion「AI分析」對應的執行模式標籤
 * （2026-09-08，讓認領人在點下去之前就知道會做到哪一步），callback_data 本身
 * 不帶模式——認領當下 claim.ts 會重查 Notion 取當時的值，畫面舊了也不會跑錯
 * 模式。最下方固定加一顆『需求池』按鈕（callback_data: reqpool:noop，UI 佔位，
 * 見 T9/T23），沒有候選單時也要有，讓使用者永遠有下一步可按。
 * 沒有候選單時明確回覆「目前沒有可認領工單」，不留空白或無回應。
 */
export async function sendTicketList(ctx: Context, techUser: TechUser): Promise<void> {
  const candidates = await queryCandidateTicketsWithMode(techUser.notion_user_id)

  const keyboard = new InlineKeyboard()
  candidates.forEach(c => {
    keyboard.text(`${c.ticket}｜${BUG_MODE_LABEL[c.mode]}`, `claim:${c.ticket}`).row()
  })
  keyboard.text('需求池', 'reqpool:noop')

  // 標題文字維持既有契約（lib/security/whitelist.test.ts 對 /bug 路由斷言的就是
  // 這兩個字串），模式說明只放在按鈕文字裡。
  const text = candidates.length === 0 ? '目前沒有可認領工單' : '你的可認領工單：'
  await ctx.reply(text, { reply_markup: keyboard })
}
