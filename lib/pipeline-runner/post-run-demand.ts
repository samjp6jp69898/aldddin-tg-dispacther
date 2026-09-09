// lib/pipeline-runner/post-run-demand.ts
//
// demand pipeline 的 EXIT trap 收尾（監控 DB 化，plan-db-as-truth-v3.md §9
// Phase 2「demand 終態（trap 側，v1/v2 都缺實作）」列）。掛進
// spawn-demand-pipeline.ts 的 WRAPPER_SCRIPT EXIT trap，跟 bug-lock.sh
// release 同一個 shell 呼叫序列裡執行：
//   bun post-run-demand.ts "$1" "$EC" "$2"
//   （$1=ticket, $EC=timeout/bun 那行的結束碼, $2=assigneeEmail）
//
// 這裡只是安全網：run-demand-pipeline.ts 本身的 try/finally 幾乎涵蓋了全部
// 正常路徑（含拋例外時的 unexpected-error 分支），都會呼叫
// demand-finalize.ts 的分類邏輯配合 demand-monitor-writes.ts 的
// writeDemandOutcomeAuthoritative() 寫下真正的結構化終態（W2，tier 2），也
// 是它自己更新 Notion AI分析／發 TG 通知的地方。這裡只補「
// run-demand-pipeline.ts 這個行程本身完全沒機會跑到 finally」的情況：
//   - exitCode===0（正常結束）→ 什麼都不做，finalize() 是權威來源。
//   - exitCode===124（GNU timeout 逾時砍掉）→ 'timeout'。
//   - 其餘非 0（含 monitor 頁面手動取消：cancelPipeline 送 SIGTERM 後這裡
//     收到的 exit code）→ 'infra_failure'（分類語意比照 classify-result.ts
//     :83-84 的既有慣例，demand 沒有 stdout JSON 可解析，只能靠 exit
//     code）。
//
// 2026-09-09（使用者實測回報 ALDREQ-746：手動取消執行中的需求 pipeline
// 後，Notion AI分析 停在 claim 時寫的「分析中」沒人改回去，TG 也沒查到送達
// 紀錄）：這之前只寫監控 DB，完全沒碰 Notion、也沒有留下 TG 送出結果的
// log。現在這裡是 outcome!=null（trap 真的被觸發）時的統一收尾點：
//   1) 監控 DB 終態寫入（既有邏輯，行為不變）。
//   2) Notion AI分析 改回「需要重跑」——邏輯等同
//      spawn-demand-pipeline.ts 的 resetAiAnalysisForReclaim()，但刻意不
//      import 那個檔案：它在模組載入當下就會建立 demandQueue／
//      concurrencyLimiter 等長駐單例並讀寫 pipeline-queue.demand.json，對這
//      支一次性短命 CLI 是不必要且有風險的副作用（比照 post-run-notify.ts
//      的 markNotionAnalysisFailed() 不 import spawn-create-mr.ts 的既有先
//      例）。
//   3) TG 通知——從 spawn-demand-pipeline.ts 的 bash trap 移進來，改寫進
//      有時間戳記的 post-run-demand.log（比照 post-run-notify.log），不再
//      整段 `>/dev/null 2>&1` 吞掉、無從查證是否真的送達。
// W2 的守衛（outcome IS NULL OR outcome_tier < 2）保證步驟 1 不會覆蓋
// finalize() 已經寫過的更精確結構化值（guarded_terminal，先到先定）；步驟
// 2/3 則完全獨立於監控 DB 是否啟用（isMonitorDbEnabled()===false 或缺
// MON_RUN_ID 只影響步驟 1，不影響 2/3——Notion／TG 這兩件事跟監控 DB 開關
// 無關）。
//
// run_id 來源：MON_RUN_ID 環境變數。spawn-demand-pipeline.ts 在 spawn 當下
// 用 `{ MON_RUN_ID: runId }` 顯式覆寫子行程環境；trap 跟
// run-demand-pipeline.ts 是同一個 bash shell（不是 subshell），直接繼承
// 同一份環境，不需要另外查 DB／讀 active-pipeline marker 檔。
import { appendFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { isMonitorDbEnabled } from '../monitor-db/env.ts'
import { writeDemandOutcomeAuthoritative } from './demand-monitor-writes.ts'
import { getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const POST_RUN_DEMAND_LOG = join(LOG_DIR, 'post-run-demand.log')
const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'
// resolve-reviewer.sh／tg-notify.sh 同款上界，理由比照 post-run-notify.ts 的
// EXEC_TIMEOUT_MS：這支腳本是 bash EXIT trap 呼叫的短命子行程，任何一步卡住
// 不返回都要有限，逾時視同呼叫失敗。
const EXEC_TIMEOUT_MS = 30_000

function log(msg: string): void {
  mkdirSync(dirname(POST_RUN_DEMAND_LOG), { recursive: true })
  appendFileSync(POST_RUN_DEMAND_LOG, `${new Date().toISOString()} ${msg}\n`)
}

export function classifyTrapExitCode(exitCode: number): 'timeout' | 'infra_failure' | null {
  if (exitCode === 0) return null
  if (exitCode === 124) return 'timeout'
  return 'infra_failure'
}

/**
 * 把 Notion AI分析 改回「需要重跑」——語意與
 * spawn-demand-pipeline.ts 的 resetAiAnalysisForReclaim() 完全一致（同一個
 * 目標值，同樣是 WANTED_AI_ANALYSIS 白名單內唯一語意正確的可重新認領
 * 值），不 import 那個檔案的理由見檔頭註解。best-effort：查無頁面／
 * notion.sh 失敗都只記 log、回傳 false，不拋例外。
 */
function resetAiAnalysisToRerun(ticket: string): boolean {
  try {
    const url = getDemandTicketNotionUrl(ticket)
    if (url === null) {
      log(`${ticket} 找不到 Notion 頁面，無法把 AI分析 改回「需要重跑」`)
      return false
    }
    execFileSync('bash', [NOTION_SH, 'update-prop', url, 'AI分析', 'select', '需要重跑'], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    log(`${ticket} 已把 Notion AI分析 改回「需要重跑」`)
    return true
  } catch (err) {
    log(`${ticket} 把 Notion AI分析 改回「需要重跑」失敗: ${err}`)
    return false
  }
}

/** tg-notify.sh 失敗只記 log、回傳 false，不拋例外（比照 post-run-notify.ts 的 notifyViaEmail）。 */
function notifyViaEmail(email: string, text: string): boolean {
  try {
    execFileSync('bash', [TG_NOTIFY_SH, '--email', email, '--text', text], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    return true
  } catch (err) {
    log(`tg-notify.sh 呼叫失敗: ${err}`)
    return false
  }
}

async function main(): Promise<void> {
  const [ticket, exitCodeRaw, assigneeEmail] = process.argv.slice(2)
  if (!ticket || exitCodeRaw === undefined) return

  const exitCode = Number(exitCodeRaw)
  if (!Number.isInteger(exitCode)) return
  const outcome = classifyTrapExitCode(exitCode)
  if (!outcome) return // exitCode===0：finalize() 是權威來源，這裡完全不用管，Notion／TG 它自己會處理

  log(`${ticket} outcome=${outcome} exitCode=${exitCode}`)

  // 步驟 1：監控 DB 終態寫入（既有邏輯，獨立包一層守衛——DB 停用/run_id
  // 缺失只影響這一步，不影響下面 Notion／TG）。
  if (isMonitorDbEnabled()) {
    const runId = (process.env.MON_RUN_ID ?? '').trim()
    if (runId) {
      try {
        await writeDemandOutcomeAuthoritative(
          { runId, ticket, outcome, outcomeSource: 'post-run-demand-trap', finishedAt: new Date().toISOString(), exitCode },
          { writerName: 'post-run-demand' },
        )
      } catch (err) {
        log(`${ticket} writeDemandOutcomeAuthoritative 例外（不影響 Notion／TG 收尾）: ${err}`)
      }
    } else {
      log(`${ticket} 缺 MON_RUN_ID，略過監控 DB 終態寫入`)
    }
  }

  // 步驟 2：Notion AI分析 重置。少了這步，取消/timeout 之後這張單永遠停在
  // claim 時寫入的「分析中」，/req 候選 filter 也撈不到它，變成死單（實測
  // 回報的根因）。
  const reset = resetAiAnalysisToRerun(ticket)

  // 步驟 3：TG 通知（原本在 spawn-demand-pipeline.ts 的 bash trap 裡，整段
  // `>/dev/null 2>&1`，送出結果查無可考——現在統一在這裡發、且成功/失敗都
  // 留 log）。
  const situation = outcome === 'timeout' ? '被逾時強制中止' : '異常終止（可能是被手動取消或行程中斷）'
  const text = reset
    ? `⚠️ ${ticket} 需求 pipeline ${situation}（exit=${exitCode}），Notion AI分析 已改回「需要重跑」。若仍需要分析，請重新認領一次；詳情請查 logs/demand-pipeline.log 與工作目錄 worktrees/${ticket}/。`
    : `⚠️ ${ticket} 需求 pipeline ${situation}（exit=${exitCode}），且 Notion AI分析 改回「需要重跑」失敗（目前仍停在「分析中」）——請人工到 Notion 把 AI分析 改成「需要重跑」後重新認領，或聯絡維運人員。詳情請查 logs/demand-pipeline.log 與工作目錄 worktrees/${ticket}/。`

  if (assigneeEmail) {
    const sent = notifyViaEmail(assigneeEmail, text)
    log(`${ticket} TG 通知${sent ? '已送出' : '送出失敗'}（${assigneeEmail}）`)
  } else {
    log(`${ticket} 缺 assigneeEmail 參數，無法發送 TG 通知`)
  }
}

if (import.meta.main) {
  main().catch(err => log(`main() 例外: ${err}`))
}
