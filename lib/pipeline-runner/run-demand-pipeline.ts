import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchDemandTicketContent, checkSpecSufficiencyFromContent } from './spec-sufficiency-gate.ts'
import { detectRepoScope } from './repo-scope-gate.ts'
import { getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import { runDemandPlanPipeline } from './demand-plan-pipeline.ts'
import {
  classifyAiAnalysis,
  shouldUploadPlan,
  buildNotionCommentText,
  buildTelegramText,
  demandOutcomeToRunsOutcome,
  type DemandOutcome,
} from './demand-finalize.ts'
import { writeDemandOutcomeAuthoritative } from './demand-monitor-writes.ts'

const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'
const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
const GDRIVE_SH = '/Users/user/.claude/gdrive.sh'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const DEMAND_LOG = join(LOG_DIR, 'demand-pipeline.log')
// 2026-08-17 建立，見 tasks.json T36 changelog：demand-pool 專用 Drive 父資料夾
// （跟 Bug pipeline 的 bug-list 資料夾同一層、平行存在，不共用同一個資料夾）。
const DEMAND_POOL_DRIVE_PARENT_ID = '1E21H-5UycBfCvfWs06ZChV-E84bs-vzP'

/**
 * T36：需求 pipeline 整合進 dispatcher，唯一的 CLI 進入點（`bun
 * run-demand-pipeline.ts <ticket> <assigneeEmail>`），由
 * spawn-demand-pipeline.ts fire-and-forget spawn。主要的收尾保證是這支
 * Bun 腳本自己的 try/finally（涵蓋正常結束、任何步驟拋例外的情況）；
 * spawn-demand-pipeline.ts 額外包了一層 bash `timeout` + EXIT trap 當
 * SIGKILL 情境下的最後安全網（見該檔案 WRAPPER_SCRIPT 註解）。
 *
 * 流程：(1) 抓需求單內容 (2) T34 gate：規格不足 → 收尾＋結束 (3) T36 範圍
 * 偵測：判斷會動到哪些 repo（不再拿來擋——見下方 2026-08-21 定案）(4) 交給
 * demand-plan-pipeline.ts 跑 draft×2 → review×3 → synthesize → classify，
 * 產出 plan.md（不改任何 repo 程式碼）(5) finalize：分類結果 →（若有
 * plan.md）上傳 Google Drive → Notion 留言＋更新 AI分析 → Telegram 通知。
 *
 * 2026-08-18 使用者定案二次修正（見 tasks.json T36 changelog 完整脈絡）：
 * 第一版重新設計（implementer agent 直接改 code）→ 第二版（本機啟動全服務
 * 驗證，見 demand-implementer-prompt.ts，已刪除）→ 第三版（也就是這裡）：
 * 不建全服務 worktree，改用「2 個 draft agent 平行調查 → 3 個 review agent
 * 各自角度審查 → synthesize 彙整」取代單一 agent 自己審自己，且用零工具
 * 嚴格 JSON 分類取代自由文字結尾格式解析（第二版真實跑壞過一次：
 * RESULT_STATUS 被包進一句話裡，regex 解析失敗，已改用 T34/T36 gate 既有
 * 的可靠模式）。實際 draft/review/synthesize/classify 呼叫細節見
 * demand-plan-pipeline.ts。
 *
 * 2026-08-21 使用者定案：跨 ≥2 個 repo 的需求單不再被 repo-scope-gate 擋下
 * 直接收尾成『需人工複核』（原本 2026-08-17 的定案，理由是 T35 回溯測試
 * 證實跨 repo 範圍窮盡性不可靠）——實測發現這個關卡連「加一個欄位、明確
 * 知道要動哪三個 repo」這種小需求都會擋，太保守。detectRepoScope 的判斷
 * 結果現在只決定 demand-plan-pipeline.ts 要建幾個 repo 的 worktree，不再
 * 是收尾分支的判準；跨 repo 範圍窮盡性不可靠的風險本身沒有消失，只是改由
 * plan pipeline 產出的 plan.md 走人工複核把關（跟單一 repo 的既有流程一
 * 致），不再用「repo 數量」這個粗粒度訊號提前攔截。
 */

function log(msg: string): void {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(DEMAND_LOG, `${new Date().toISOString()} ${msg}\n`)
}

function notify(ticket: string, email: string, text: string): void {
  try {
    execFileSync('bash', [TG_NOTIFY_SH, '--email', email, '--text', text], { encoding: 'utf8', timeout: 30_000 })
    log(`${ticket} 已通知 ${email}`)
  } catch (err) {
    log(`${ticket} tg-notify.sh 呼叫失敗: ${err}`)
  }
}

function claimLock(ticket: string): boolean {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'claim', ticket], { encoding: 'utf8', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

function releaseLock(ticket: string): void {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'release', ticket], { encoding: 'utf8', timeout: 10_000 })
  } catch {
    // best-effort，不阻斷收尾
  }
}

/**
 * 把 plan.md 上傳到 Drive：demand-pool 父資料夾底下建一個 {ticket} 子資料夾
 * （比照 Bug pipeline drive-uploader 對 bug-list 資料夾的既有慣例），上傳
 * plan.md，公開分享，回傳資料夾連結。任何一步失敗都往外拋，呼叫端決定要
 * 不要把這個當成技術性失敗（不吞成 undefined 靜默略過連結——使用者需要
 * 知道『plan.md 產出了但上傳失敗』跟『plan.md 產出成功』是不同狀態）。
 */
function uploadPlanToDrive(ticket: string, planPath: string): string {
  const mkdirOut = execFileSync('bash', [GDRIVE_SH, 'mkdir', ticket, DEMAND_POOL_DRIVE_PARENT_ID], { encoding: 'utf8', timeout: 30_000 })
  const folderIdMatch = /FOLDER_ID=(\S+)/.exec(mkdirOut)
  if (!folderIdMatch) throw new Error(`gdrive.sh mkdir 沒有回傳 FOLDER_ID: ${mkdirOut.slice(0, 300)}`)
  const folderId = folderIdMatch[1]!

  execFileSync('bash', [GDRIVE_SH, 'upload', planPath, folderId], { encoding: 'utf8', timeout: 60_000 })
  execFileSync('bash', [GDRIVE_SH, 'share', folderId], { encoding: 'utf8', timeout: 30_000 })

  return `https://drive.google.com/drive/folders/${folderId}`
}

/**
 * 統一收尾：分類 AI分析 值 → （若有 plan.md）上傳 Drive → Notion 留言＋
 * 更新 AI分析 → Telegram 通知。每個子步驟各自 try/catch，一個失敗不阻斷
 * 其他步驟（比照 drive-uploader.md『無論如何都要嘗試更新 AI分析欄位』的
 * 既有原則），但都會記進 demand-pipeline.log 供事後排查。
 */
async function finalize(ticket: string, email: string, outcome: DemandOutcome): Promise<void> {
  const aiAnalysis = classifyAiAnalysis(outcome)
  log(`${ticket} finalize：${outcome.kind}${outcome.kind === 'plan' ? `/${outcome.status}` : ''} → AI分析=${aiAnalysis}`)

  let driveLink: string | undefined
  if (shouldUploadPlan(outcome)) {
    try {
      driveLink = uploadPlanToDrive(ticket, outcome.planPath)
      log(`${ticket} plan.md 已上傳 Drive：${driveLink}`)
    } catch (err) {
      log(`${ticket} plan.md 上傳 Drive 失敗: ${err}`)
    }
  }

  let notionUrl: string | null = null
  try {
    notionUrl = getDemandTicketNotionUrl(ticket)
    if (notionUrl === null) {
      log(`${ticket} finalize：找不到對應 Notion 頁面，跳過留言與 AI分析更新`)
    } else {
      const commentText = buildNotionCommentText(ticket, outcome)
      if (driveLink) {
        execFileSync('bash', [NOTION_SH, 'comment-text', notionUrl, commentText, driveLink, 'plan.md'], { encoding: 'utf8', timeout: 30_000 })
      } else {
        execFileSync('bash', [NOTION_SH, 'comment-text', notionUrl, commentText], { encoding: 'utf8', timeout: 30_000 })
      }
      execFileSync('bash', [NOTION_SH, 'update-prop', notionUrl, 'AI分析', 'select', aiAnalysis], { encoding: 'utf8', timeout: 30_000 })
      log(`${ticket} Notion 留言＋AI分析=${aiAnalysis} 已更新`)
    }
  } catch (err) {
    log(`${ticket} finalize：Notion 留言/更新失敗: ${err}`)
  }

  const text = buildTelegramText(ticket, outcome, { driveLink, notionUrl: notionUrl ?? undefined })
  notify(ticket, email, text)

  // 監控 DB 化（plan-db-as-truth-v3.md §9 Phase 2「demand 結構化 outcome」
  // 列）：demand pipeline 的結構化終態權威寫入（W2，tier 2）。這是本次改動
  // 對現況（舊軌 runs.outcome 只有截斷 80 字的 log 字串）的核心改善——見
  // demand-finalize.ts 的 demandOutcomeToRunsOutcome() 映射。best-effort：
  // 上面的 Notion/Telegram 收尾已經完成，這裡失敗只記 log，不倒流影響使用者
  // 已經收到的通知。§6.7：短命行程要 await，writeDemandOutcomeAuthoritative
  // 內部自帶 3 秒預算與 spool 落地，全程不拋出，這裡的 try/catch 只是多一層
  // 防禦（不依賴它才是正確性的保證）。
  const runId = (process.env.MON_RUN_ID ?? '').trim()
  if (runId) {
    try {
      await writeDemandOutcomeAuthoritative(
        {
          runId,
          ticket,
          outcome: demandOutcomeToRunsOutcome(outcome),
          outcomeSource: 'run-demand-pipeline-finalize',
          finishedAt: new Date().toISOString(),
        },
        { writerName: 'cli' },
      )
    } catch (err) {
      log(`${ticket} finalize：監控 DB 結構化終態寫入失敗: ${err}`)
    }
  } else {
    log(`${ticket} finalize：MON_RUN_ID 未設定（監控 DB 未啟用，或非經 spawn-demand-pipeline.ts 啟動），略過監控 DB 寫入`)
  }
}

async function main(): Promise<void> {
  const [ticket, assigneeEmail] = process.argv.slice(2)
  if (!ticket || !assigneeEmail) {
    log(`參數不足，略過：${process.argv.slice(2).join(' ')}`)
    return
  }

  log(`${ticket} 開始執行需求 pipeline（assignee=${assigneeEmail}）`)

  // Bug pipeline 的既有慣例：T33 claim 時的鎖只防『幾乎同時點同一張單』的
  // 瞬間 race，claim 成功就放手；真正開始跑背景流程前，這裡重新拿一次鎖，
  // 鎖的擁有權轉移到這個背景流程自己身上（比照 create-mr.md Step 0.1.3 對
  // Bug 工單鎖的既有模式）。
  if (!claimLock(ticket)) {
    log(`${ticket} 重新上鎖失敗（理論上不該發生，T33 claim 時已確認過），中止`)
    notify(ticket, assigneeEmail, `⚠️ ${ticket} 背景流程啟動異常（鎖衝突），請重新認領或聯絡維運人員。`)
    return
  }

  try {
    const { bodyText, comments } = await fetchDemandTicketContent(ticket)

    const sufficiency = await checkSpecSufficiencyFromContent(ticket, bodyText, comments)
    if (!sufficiency.sufficient) {
      log(`${ticket} 規格不足：${sufficiency.missing}`)
      await finalize(ticket, assigneeEmail, { kind: 'insufficient-spec', missing: sufficiency.missing })
      return
    }

    const repos = await detectRepoScope(ticket, bodyText, comments)
    log(`${ticket} 範圍偵測結果：${repos.join(', ')}`)

    log(`${ticket} 開始 plan pipeline（repos=${repos.join(', ')}）`)
    const outcome = await runDemandPlanPipeline(ticket, bodyText, comments, repos)
    log(`${ticket} plan pipeline 結束，分類=${outcome.kind}${outcome.kind === 'plan' ? `/${outcome.status}` : ''}`)
    await finalize(ticket, assigneeEmail, outcome)
  } catch (err) {
    log(`${ticket} pipeline 未預期例外：${err}`)
    await finalize(ticket, assigneeEmail, { kind: 'unexpected-error', detail: String(err).slice(0, 300) })
  } finally {
    releaseLock(ticket)
  }
}

if (import.meta.main) {
  main()
}
