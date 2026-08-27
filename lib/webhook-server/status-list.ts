import type { Context } from 'grammy'
import { queryCandidateTickets } from '../notion-integration/candidate-tickets.ts'
import { queryDemandTicketsInAnalysis } from '../notion-integration/demand-pool-tickets.ts'
import { describeTicketProgress, isTicketLocked } from '../pipeline-runner/ticket-progress.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

/**
 * /status 指令：列出這個人名下目前真的有背景 pipeline 在跑的所有票（Bug＋
 * 需求單），逐張附上 ticket-progress.ts 還原出的 stage。
 *
 * 「真的在跑」用 isTicketLocked 交集掉，不能只看 Notion 欄位：
 * - Bug 票：claim.ts 不改 Notion『狀態』欄位，候選單查詢（狀態=待處理/仍有
 *   問題）在整條 pipeline 跑完前都還會查到同一張單，必須靠鎖目錄才能分辨
 *   「還沒認領」跟「正在跑」。
 * - 需求單：demand-claim.ts 認領當下就把 AI分析 改成分析中，若之後 spawn
 *   失敗（全域併發上限/啟動錯誤），欄位不會被復原，光看 AI分析=分析中 會
 *   誤報成「還在跑」，一樣要靠鎖目錄排除。
 */
export async function sendStatusList(ctx: Context, techUser: TechUser): Promise<void> {
  const [bugCandidates, demandInAnalysis] = await Promise.all([
    queryCandidateTickets(techUser.notion_user_id),
    queryDemandTicketsInAnalysis(techUser.notion_user_id),
  ])

  const running = [...bugCandidates, ...demandInAnalysis].filter(ticket => isTicketLocked(ticket))

  if (running.length === 0) {
    await ctx.reply('你目前沒有正在執行中的工單。')
    return
  }

  const text = running.map(ticket => describeTicketProgress(ticket)).join('\n\n')
  await ctx.reply(`你目前正在執行中的工單（${running.length} 張）：\n\n${text}`)
}
