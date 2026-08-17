import { InlineKeyboard, type Context } from 'grammy'
import { queryDemandPoolTickets } from '../notion-integration/demand-pool-tickets.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

/**
 * 使用者發 /req 或點頂層選單的『需求池』按鈕（callback_data: reqpool:noop，
 * T29/T9 沿用同一個 callback_data 名稱，行為已從固定佔位改成這裡）後觸發：
 * 查該人在需求池（總需求池資料庫）的候選單（T31），組成 inline keyboard
 * 回覆。比照 ticket-list.ts（Bug 版本）的風格，但沒有再往下加一顆跳回 BUG
 * 清單的按鈕——T32 範圍只到列表本身，不重複 T29 頂層選單已經有的入口。
 *
 * callback_data 刻意用 `demand-claim:{ticket}`，不沿用 `claim:{ticket}`——
 * 那個字首是 Bug 專用、直接觸發 /create-mr worktree 流程（T10），混用會讓
 * 需求單被誤判成 Bug 觸發錯的 pipeline。claim 這個按鈕實際能不能按下去、
 * 按下去要做什麼，是 T33 的範圍；T32 只負責讓按鈕出現且命名正確不衝突。
 *
 * 沒有候選單時明確回覆「目前沒有可認領需求單」，不留空白或無回應（維持
 * 白名單內沒有安靜失敗路徑的既有原則）。
 */
export async function sendDemandList(ctx: Context, techUser: TechUser): Promise<void> {
  const tickets = await queryDemandPoolTickets(techUser.notion_user_id)

  if (tickets.length === 0) {
    await ctx.reply('目前沒有可認領需求單')
    return
  }

  const keyboard = new InlineKeyboard()
  tickets.forEach(ticket => {
    keyboard.text(ticket, `demand-claim:${ticket}`).row()
  })
  await ctx.reply('你的可認領需求單：', { reply_markup: keyboard })
}
