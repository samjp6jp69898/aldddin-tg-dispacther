import { execFileSync } from 'node:child_process'
import type { Context } from 'grammy'
import { queryDemandPoolTickets, getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'

// 沿用同一支 bug-lock.sh（不另開 demand-lock.sh）——ticket 格式 ALDREQ-xxx
// 跟 Bug 的 FAQ-xxx 天然是不同的鎖目錄名稱，不會互相碰撞，見 tasks.json
// T33 description 的既有評估。

/**
 * 同步呼叫 bug-lock.sh claim {ticket}（mkdir 單一 syscall，真正原子）。
 * exit 0 = CLAIMED，exit 1 = LOCKED（已被其他 session 認領）。比照
 * lib/locking/claim.ts 的既有寫法。
 */
function claimLock(ticket: string): boolean {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'claim', ticket], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

/**
 * 釋放這裡的鎖。跟 claim.ts 的理由不同：這裡沒有背景流程要接手鎖的擁有權
 * （T34-T36 全自動化 pipeline 尚未完成，claim 之後不 spawn 任何東西），純粹
 * 是『瞬間 race 防護做完就該放手』——鎖不是任務狀態的權威來源（見 T33
 * acceptance_criteria）。失敗不拋出，不阻斷後續回覆。
 */
function releaseLock(ticket: string): void {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'release', ticket], { encoding: 'utf8' })
  } catch {
    // 見上方註解：不阻斷後續回覆。
  }
}

/**
 * 把需求單的『AI分析』欄位改成『分析中』（使用者 2026-08-17 定案，見
 * tasks.json T33 changelog：只動 AI分析，不動『狀態』欄位——『狀態』欄位是
 * 需求池自己的處理階段追蹤，不該由 claim 這個動作代管）。
 * 找不到頁面（ticket 格式不對或查無此單）視為失敗，讓呼叫端決定怎麼回覆
 * 使用者，不在這裡吞掉。
 */
function markAiAnalysisInProgress(ticket: string): void {
  const url = getDemandTicketNotionUrl(ticket)
  if (url === null) {
    throw new Error(`找不到 ${ticket} 對應的 Notion 頁面，無法更新 AI分析`)
  }
  execFileSync('bash', [NOTION_SH, 'update-prop', url, 'AI分析', 'select', '分析中'], { encoding: 'utf8' })
}

/**
 * demand-claim:{ticket} callback handler（見 tasks.json T33）。
 * 嚴格順序比照 claim.ts（T10）：(1) answerCallbackQuery (2) 防禦性重驗
 * 白名單＋重查 Notion (3) 同步 bug-lock.sh claim，先看結果再決定回什麼
 * 訊息 (4) 更新 Notion AI分析。每個分支都要有明確回覆，沒有安靜失敗的路徑。
 *
 * 跟 claim.ts 最大的差異：這裡刻意不 spawn 任何背景流程（T34-T36 全自動化
 * pipeline 尚未完成），claim 成功後鎖立即釋放，回覆文案誠實反映『後續處理
 * 方式仍在建置中』，不能讓使用者誤以為已經有自動化在跑。
 */
export async function handleDemandClaim(ctx: Context, techUser: TechUser, ticket: string): Promise<void> {
  await ctx.answerCallbackQuery()

  // 防禦性重驗：訊息可能是舊的，畫面上的單這期間可能已被別人處理完、或
  // Notion『技術處理人員』／『狀態』已經變了。
  const stillCandidate = (await queryDemandPoolTickets(techUser.notion_user_id)).includes(ticket)
  if (!stillCandidate) {
    await ctx.reply(`${ticket} 目前已不是你的可認領需求單（可能已被處理或狀態已變更），請重新傳 /req 取得最新清單。`)
    return
  }

  if (!claimLock(ticket)) {
    await ctx.reply(`${ticket} 認領失敗：已被其他 session 認領。`)
    return
  }

  // review 建議：改成 try/finally 而非兩處各自呼叫 releaseLock——語意上更
  //明確保證「鎖一旦拿到，不管成功失敗都恰好釋放一次」，也防之後有人在
  // try 區塊裡加新程式碼時，漏掉某個分支忘了 release（兩個分支各自呼叫的
  // 舊寫法目前雖然安全，但沒有結構性保證）。
  try {
    markAiAnalysisInProgress(ticket)
  } catch (err) {
    // Notion 寫入失敗（網路/權限/頁面找不到）：明確告知使用者 Notion 沒有
    // 同步成功——不是安靜失敗，使用者知道要重試或找人手動改。
    console.error(`demand-claim: ${ticket} 更新 AI分析 失敗: ${err}`)
    await ctx.reply(`${ticket} 認領時更新 Notion 失敗，請重試或聯絡維運人員（鎖已釋放，可重新認領）。`)
    return
  } finally {
    releaseLock(ticket)
  }

  await ctx.reply(`已認領 ${ticket}，後續處理方式仍在建置中（T34-T36），Notion AI分析已標記為「分析中」。`)
}
