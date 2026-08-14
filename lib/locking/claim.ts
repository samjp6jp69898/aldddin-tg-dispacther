import { execFileSync } from 'node:child_process'
import type { Context } from 'grammy'
import { queryCandidateTickets } from '../notion-integration/candidate-tickets.ts'
import { ensureTrackerPending } from '../pipeline-runner/tracker-sync.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'

/**
 * 同步呼叫 bug-lock.sh claim {ticket}（mkdir 單一 syscall，真正原子）。
 * exit 0 = CLAIMED，exit 1 = LOCKED（已被其他 session 認領）。
 */
function claimLock(ticket: string): boolean {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'claim', ticket], { encoding: 'utf8' })
    return true
  } catch {
    return false // 非零 exit（LOCKED）視為認領失敗，不重拋
  }
}

/**
 * claim:{ticket} callback handler（見 tasks.json T10）。
 * 嚴格順序：(1) answerCallbackQuery (2) 防禦性重驗白名單＋重查 Notion
 * (3) 同步 bug-lock.sh claim，先看結果再決定回什麼訊息——杜絕『claim 輸了
 * 卻回覆已開始』的靜默失敗。每個分支都要有明確回覆，沒有安靜失敗的路徑。
 */
export async function handleClaim(ctx: Context, techUser: TechUser, ticket: string): Promise<void> {
  await ctx.answerCallbackQuery()

  // 防禦性重驗：訊息可能是舊的，畫面上的單這期間可能已被別人處理完、
  // 或 Notion『當前指派』／『狀態』已經變了。
  const stillCandidate = queryCandidateTickets(techUser.notion_user_id).includes(ticket)
  if (!stillCandidate) {
    await ctx.reply(`${ticket} 目前已不是你的可認領工單（可能已被處理或狀態已變更），請重新傳訊息取得最新清單。`)
    return
  }

  if (!claimLock(ticket)) {
    await ctx.reply(`${ticket} 認領失敗：已被其他 session 認領，絕不會啟動背景流程。`)
    return
  }

  await ctx.reply(`已開始處理 ${ticket}`)

  ensureTrackerPending(ticket)

  // TODO(T11): fire-and-forget 觸發 /create-mr 背景流程
}
