import { execFileSync } from 'node:child_process'
import type { Context } from 'grammy'
import { queryDemandPoolTickets, getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import { resetAiAnalysisForReclaim } from '../pipeline-runner/spawn-demand-pipeline.ts'
import { dispatchDemand, getRemoteEntry, describeRemoteProgress, isMaintenanceModeOn } from '../cluster/cluster-head.ts'
import { DEMAND_CONCURRENCY_LIMIT } from '../pipeline-runner/concurrency-limiter.ts'
import { describeTicketProgress, isTicketLocked } from '../pipeline-runner/ticket-progress.ts'
import { enqueueMaintenanceRequest, registerMaintenanceProcessor, notifyMaintenanceOutcome } from '../maintenance/request-queue.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'
import type { ClaimOutcome } from './claim.ts'

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
 * 需求單認領的決策核心（2026-09-08 從 handleDemandClaim 抽出，讓 Web UI
 * （lib/ops-ui/）與 TG callback 共用同一條路徑，理由同 claim.ts 的
 * claimBugTicket）。嚴格順序比照 claim.ts：(1) 防禦性重驗白名單＋重查
 * Notion (2) 同步 bug-lock.sh claim，先看結果再決定回什麼訊息 (3) 更新
 * Notion AI分析 (4) T36：fire-and-forget 觸發背景 pipeline（T34 規格 gate
 * → T36 範圍偵測 → T35 實作 agent）。每個分支都回明確訊息，沒有安靜失敗
 * 的路徑。不碰 grammy ctx。
 *
 * 跟 claim.ts 的差異：這裡的鎖在 spawn 前就釋放（T33 定案），背景 pipeline
 * 自己的進入點（run-demand-pipeline.ts）會重新拿一次鎖，鎖的擁有權轉移給
 * 它，比照 claim.ts 對 Bug 工單鎖『spawn 前先 release，交給即將啟動的背景
 * 流程自己管』的既有模式。
 */
export async function claimDemandTicket(techUser: TechUser, ticket: string): Promise<ClaimOutcome> {
  // 維護模式（2026-09-08，2026-09-09 改為「照收不拒絕」）：比照 claim.ts 的
  // claimBugTicket，排在最前面，開著時不查 Notion、不碰鎖、不派工，只是把
  // 這筆請求記下來排入 FIFO 佇列，維護結束後依序重新完整跑一次（見
  // request-queue.ts 檔頭）。
  if (isMaintenanceModeOn()) {
    const r = enqueueMaintenanceRequest('demand', techUser, ticket)
    return r.status === 'queued'
      ? {
          code: 'maintenance_queued',
          text:
            `系統目前維護中，${ticket} 的認領請求已收到，排入等待佇列第 ${r.position} 順位` +
            (r.ahead > 0 ? `（前面還有 ${r.ahead} 張在排隊）` : `（你是第一位）`) +
            `。維護結束後會依收到順序自動處理，完成後 TG 通知你，不需要重新認領。`,
        }
      : {
          code: 'maintenance_already_queued',
          text: `${ticket} 已在維護等待佇列中（第 ${r.position} 順位，前面還有 ${r.ahead} 張），維護結束後會依序處理，不需要重複送出。`,
        }
  }

  // 同事再次點選一張已經在跑的需求單：鎖目錄存在＝run-demand-pipeline.ts
  // 的 main() 正持有這張票的鎖（見 ticket-progress.ts 檔頭註解，跟 claim.ts
  // 對 Bug 票的判斷同一套依據），改回覆目前進度，不要走下面的認領流程。
  if (isTicketLocked(ticket)) {
    return { code: 'already_running_local', text: describeTicketProgress(ticket) }
  }

  // 多機派工：這張單已派在某台 worker 上執行（本機鎖目錄看不到，理由見
  // claim.ts 同分支註解）。cluster 停用時登記表恆空，不會進來。
  const remoteEntry = getRemoteEntry(ticket)
  if (remoteEntry) {
    return { code: 'already_running_remote', text: await describeRemoteProgress(remoteEntry) }
  }

  // 防禦性重驗：訊息可能是舊的，畫面上的單這期間可能已被別人處理完、或
  // Notion『技術處理人員』／『狀態』已經變了。
  const stillCandidate = (await queryDemandPoolTickets(techUser.notion_user_id)).includes(ticket)
  if (!stillCandidate) {
    return { code: 'not_candidate', text: `${ticket} 目前已不是你的可認領需求單（可能已被處理或狀態已變更），請重新傳 /req 取得最新清單。` }
  }

  if (!claimLock(ticket)) {
    return { code: 'lock_failed', text: `${ticket} 認領失敗：已被其他 session 認領。` }
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
    return { code: 'notion_update_failed', text: `${ticket} 認領時更新 Notion 失敗，請重試或聯絡維運人員（鎖已釋放，可重新認領）。` }
  } finally {
    releaseLock(ticket)
  }

  // 2026-08-28（使用者定案）：併發額滿改排入 FIFO 佇列，不再要求「稍後重新
  // 認領」——排隊中的單輪到時由 pipeline-queue.ts 自動 spawn 並 TG 通知，
  // Notion AI分析 維持上面剛標記的「分析中」，語意一致。
  // 多機派工：dispatchDemand 內部依名額決定本機 spawn 或派給 worker；
  // cluster 停用/無 worker 時完全等同原本的 submitDemandPipeline。
  const spawnResult = await dispatchDemand(ticket, techUser.email, techUser)
  if (!spawnResult.ok) {
    // spawn 本身失敗：明確回覆，不能讓使用者以為流程已經在跑。鎖已在上面
    // release 過；但 AI分析 已被標成「分析中」，不改回可認領值（需要重跑）
    // 的話這張單會從 /req 候選清單消失、「重新認領」在結構上做不到（對抗性
    // review 2026-08-28 round 3 N1——與佇列側 expired/啟動失敗的收尾規則
    // 同一套，共用 resetAiAnalysisForReclaim）。
    const reset = resetAiAnalysisForReclaim(ticket)
    return {
      code: 'spawn_error',
      text: reset
        ? `${ticket} 背景流程啟動失敗，Notion AI分析 已改回「需要重跑」，可直接重新認領一次；若持續失敗請聯絡維運人員檢查 spawn-errors.log。`
        : `${ticket} 背景流程啟動失敗，且 Notion AI分析 改回「需要重跑」也失敗（目前停在「分析中」）——請人工到 Notion 把 AI分析 改成「需要重跑」後重新認領，或聯絡維運人員檢查 spawn-errors.log。`,
    }
  }

  if (spawnResult.status === 'remote_started') {
    return { code: 'remote_started', text: `已認領 ${ticket}，Notion AI分析已標記「分析中」，已派工至另一台機器執行，完成後會再通知你。產出仍需人工複核，不是自動完成。` }
  }
  if (spawnResult.status === 'already_running_remote') {
    return { code: 'already_running_remote', text: `${ticket} 已在另一台機器執行中，不需要重複認領，完成後會自動通知。` }
  }
  if (spawnResult.status === 'already_running') {
    // 連點視窗防護，理由見 claim.ts 同分支註解。AI分析=分析中 與實況一致
    // （確實有一條流程在跑，它的 finalize 會自行更新），不需要改回。
    return { code: 'already_running', text: `${ticket} 已在執行中（背景流程剛啟動），不需要重複認領，完成後會自動通知。` }
  }
  if (spawnResult.status === 'queued') {
    return {
      code: 'queued',
      text:
        `已認領 ${ticket}（Notion AI分析已標記「分析中」），但需求 pipeline 併發已滿（${DEMAND_CONCURRENCY_LIMIT} 張執行中），已排入等待佇列第 ${spawnResult.position} 順位` +
        (spawnResult.ahead > 0 ? `（前面還有 ${spawnResult.ahead} 張在排隊）` : `（你是下一張）`) +
        `。輪到時會自動開始並發 TG 通知你，不需要重新認領。`,
    }
  }
  if (spawnResult.status === 'already_queued') {
    return { code: 'already_queued', text: `${ticket} 已在等待佇列中（第 ${spawnResult.position} 順位，前面還有 ${spawnResult.ahead} 張），輪到時會自動開始，不需要重複認領。` }
  }

  return { code: 'started', text: `已認領 ${ticket}，Notion AI分析已標記「分析中」，背景開始評估規格與範圍，完成後會再通知你。這是輔助草稿流程，產出需要人工複核，不是自動完成。` }
}

// 維護結束時的重新處理 callback，理由與寫法同 claim.ts 對應段落（含「維護
// 又被重新開啟時不發自相矛盾通知」的處理）。
registerMaintenanceProcessor('demand', async entry => {
  const outcome = await claimDemandTicket(entry.techUser, entry.ticket)
  if (outcome.code === 'maintenance_queued' || outcome.code === 'maintenance_already_queued') return
  notifyMaintenanceOutcome(entry.techUser, `🔧 維護結束，重新處理 ${entry.ticket}：${outcome.text}`)
})

/**
 * demand-claim:{ticket} callback handler（見 tasks.json T33/T36）。
 * (1) answerCallbackQuery (2) 決策核心 claimDemandTicket (3) 把核心回的
 * 訊息原樣回覆。每個分支都要有明確回覆，沒有安靜失敗的路徑。
 */
export async function handleDemandClaim(ctx: Context, techUser: TechUser, ticket: string): Promise<void> {
  await ctx.answerCallbackQuery()
  const outcome = await claimDemandTicket(techUser, ticket)
  await ctx.reply(outcome.text)
}
