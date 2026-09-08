import { execFileSync } from 'node:child_process'
import type { Context } from 'grammy'
import { queryCandidateTicketsWithMode } from '../notion-integration/candidate-tickets.ts'
import { BUG_MODE_LABEL } from '../pipeline-runner/bug-mode.ts'
import { ensureTrackerPending } from '../pipeline-runner/tracker-sync.ts'
import { GLOBAL_CONCURRENCY_LIMIT } from '../pipeline-runner/concurrency-limiter.ts'
import { dispatchBug, getRemoteEntry, describeRemoteProgress } from '../cluster/cluster-head.ts'
import { describeTicketProgress, isTicketLocked } from '../pipeline-runner/ticket-progress.ts'
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
 * 釋放這裡的鎖（review 發現：/create-mr 內部 Step 0.1.3 自己也會對同一張單
 * 叫一次 bug-lock.sh claim；這裡的鎖只是用來擋『兩個 Telegram 使用者幾乎
 * 同時點同一張單』，一旦要 spawn /create-mr 就該放手，把鎖的擁有權交給它
 * 自己的 Step 0.1.3——否則它一啟動就會撞見 LOCKED，每次都在 Step 0.1
 * SKIPPED，永遠跑不到 Step 1。使用者已定案：spawn 前先 release）。
 * 失敗不拋出——release 本身失敗頂多留下一個殘留鎖，不該擋住已經決定要
 * spawn 的流程。
 */
function releaseLock(ticket: string): void {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'release', ticket], { encoding: 'utf8' })
  } catch {
    // 見上方註解：不阻斷後續 spawn。
  }
}

/** 認領結果：code 給程式分流（ops-ui 前端依此決定顏色／是否刷新），text 是
 * 給人看的訊息——TG handler 與 Web UI 回的是同一段文字，不維護兩套文案。 */
export type ClaimOutcome = { code: ClaimCode; text: string }
export type ClaimCode =
  | 'already_running_local'
  | 'already_running_remote'
  | 'not_candidate'
  | 'lock_failed'
  | 'notion_update_failed'
  | 'spawn_error'
  | 'remote_started'
  | 'already_running'
  | 'queued'
  | 'already_queued'
  | 'started'

/**
 * Bug 工單認領的決策核心（2026-09-08 從 handleClaim 抽出，讓 Web UI
 * （lib/ops-ui/）與 TG callback 共用同一條路徑——兩個入口對同一張單的判斷
 * 與副作用必須完全一致，否則 UI 認領會繞過 TG 那邊累積的防護）。
 * 嚴格順序：(1) 防禦性重驗白名單＋重查 Notion (2) 同步 bug-lock.sh claim，
 * 先看結果再決定回什麼訊息——杜絕『claim 輸了卻回覆已開始』的靜默失敗。
 * 每個分支都回明確訊息，沒有安靜失敗的路徑。不碰 grammy ctx。
 */
export async function claimBugTicket(techUser: TechUser, ticket: string): Promise<ClaimOutcome> {
  // 同事再次點選一張已經在跑的單：鎖目錄存在＝/create-mr 自己的 Step 0.1.3
  // 正持有這張票的鎖（見 ticket-progress.ts 檔頭註解），改回覆目前進度到
  // 哪個 stage，不要走下面的認領流程（那條路只會用「已被其他 session 認
  // 領」這種不含任何進度細節的訊息擋下來）。
  if (isTicketLocked(ticket)) {
    return { code: 'already_running_local', text: describeTicketProgress(ticket) }
  }

  // 多機派工：這張單已派在某台 worker 上執行——本機鎖目錄看不到（鎖跟著
  // 執行機走），要靠 head 的派工登記表判斷（見 cluster-head.ts）。單機部署
  // （cluster 停用）時登記表恆空，這個分支永遠不會進來。
  const remoteEntry = getRemoteEntry(ticket)
  if (remoteEntry) {
    return { code: 'already_running_remote', text: await describeRemoteProgress(remoteEntry) }
  }

  // 防禦性重驗：訊息可能是舊的，畫面上的單這期間可能已被別人處理完、
  // 或 Notion『當前指派』／『狀態』已經變了。同一次查詢也取回這張單**當下**
  // 的 AI分析 值對應的執行模式（2026-09-08，plan-pipeline-modes-v1 §2）——
  // 模式以認領當下的 Notion 為準，不信按鈕/畫面上的舊標籤。
  const candidate = (await queryCandidateTicketsWithMode(techUser.notion_user_id)).find(c => c.ticket === ticket)
  if (!candidate) {
    return { code: 'not_candidate', text: `${ticket} 目前已不是你的可認領工單（可能已被處理或狀態已變更），請重新傳訊息取得最新清單。` }
  }
  const mode = candidate.mode
  const modeNote = `（模式：${BUG_MODE_LABEL[mode]}）`

  if (!claimLock(ticket)) {
    return { code: 'lock_failed', text: `${ticket} 認領失敗：已被其他 session 認領，絕不會啟動背景流程。` }
  }

  ensureTrackerPending(ticket)

  // 把鎖的擁有權交給即將 spawn 的 /create-mr 自己的 Step 0.1.3（見 releaseLock 註解）。
  releaseLock(ticket)

  // T26：先真的 submit（有名額直接 spawn，額滿排入 FIFO 佇列——2026-08-28
  // 使用者定案，不再「達上限請稍後再試」），看實際結果再決定回什麼訊息——
  // 順序很重要：如果先回「已開始處理」才發現額度不夠，會變成回覆內容自相
  // 矛盾的靜默失敗（違反 T10 的『每個分支都要有明確回覆』原則）。per-ticket
  // 鎖已經在上面 release 掉；排隊中的單不持有鎖，靠佇列的同票去重擋重複排隊
  // （見 pipeline-queue.ts 檔頭註解）。
  // 多機派工：dispatchBug 內部依名額決定本機 spawn 或派給 worker；cluster
  // 停用/無 worker 時完全等同原本的 submitCreateMr（見 cluster-head.ts）。
  const result = await dispatchBug(ticket, techUser, { mode })
  if (!result.ok) {
    // spawn 本身失敗（磁碟/fd 用盡等）：明確回覆，不能讓使用者在例外未接住
    // 的舊版行為下完全收不到任何訊息。per-ticket 鎖已經 release，可以重新
    // 嘗試認領。
    return { code: 'spawn_error', text: `${ticket} 目前無法啟動：背景流程啟動失敗，請稍後再試或聯絡維運人員檢查 spawn-errors.log。` }
  }

  if (result.status === 'remote_started') {
    return { code: 'remote_started', text: `已開始處理 ${ticket}${modeNote}（派工至另一台機器執行，完成後會自動通知你）` }
  }
  if (result.status === 'already_running_remote') {
    return { code: 'already_running_remote', text: `${ticket} 已在另一台機器執行中，不需要重複認領，完成後會自動通知。` }
  }
  if (result.status === 'already_running') {
    // 連點兩次落在「已 spawn、claude 冷啟動尚未拿鎖」的視窗（2026-08-28
    // FAQ-4768 實測踩到）：isTicketLocked 看不到、佇列去重也掃不到，由佇列的
    // running 集合擋下——絕不能再 spawn 第二條（它早退時的 EXIT trap 會誤放
    // 第一條的鎖並清 worktree）。
    return { code: 'already_running', text: `${ticket} 已在執行中（背景流程剛啟動），不需要重複認領，完成後會自動通知。` }
  }
  if (result.status === 'queued') {
    return {
      code: 'queued',
      text:
        `${ticket} 已排入等待佇列：背景併發已滿（${GLOBAL_CONCURRENCY_LIMIT} 張執行中），你目前排第 ${result.position} 順位` +
        (result.ahead > 0 ? `（前面還有 ${result.ahead} 張在排隊）` : `（你是下一張）`) +
        `。輪到時會自動開始並發 TG 通知你，不需要重新認領。`,
    }
  }
  if (result.status === 'already_queued') {
    return { code: 'already_queued', text: `${ticket} 已在等待佇列中（第 ${result.position} 順位，前面還有 ${result.ahead} 張），輪到時會自動開始，不需要重複認領。` }
  }

  return { code: 'started', text: `已開始處理 ${ticket}${modeNote}` }
}

/**
 * claim:{ticket} callback handler（見 tasks.json T10）。
 * 嚴格順序：(1) answerCallbackQuery (2) 決策核心 claimBugTicket（含防禦性
 * 重驗與 bug-lock）(3) 把核心回的訊息原樣回覆。每個分支都要有明確回覆，
 * 沒有安靜失敗的路徑。
 */
export async function handleClaim(ctx: Context, techUser: TechUser, ticket: string): Promise<void> {
  await ctx.answerCallbackQuery()
  const outcome = await claimBugTicket(techUser, ticket)
  await ctx.reply(outcome.text)
}
