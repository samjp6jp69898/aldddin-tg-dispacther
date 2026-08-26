import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { classifyPipelineResult, type Classification } from './classify-result.ts'
import { getTicketNotionUrl, getTicketAiAnalysisStatus } from '../notion-integration/candidate-tickets.ts'
import { notifyOperator } from '../notify/operator.ts'

const RESOLVE_REVIEWER_SH = '/Users/user/aladdin/scripts/resolve-reviewer.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const POST_RUN_LOG = join(LOG_DIR, 'post-run-notify.log')
// resolve-reviewer.sh／tg-notify.sh 內部各自呼叫一次 curl 打 Notion／Telegram
// API，兩者都沒有自己的 --max-time（review 發現）。這裡從呼叫端補一道上界：
// 這支腳本是從 spawn-create-mr.ts 的 bash EXIT trap 呼叫，若卡住不返回，
// 該 detached bash 行程會無上界地不結束、累積在背景——加 execFileSync 的
// timeout 讓最壞情況有限，逾時視同呼叫失敗（既有 catch 分支已處理）。
const EXEC_TIMEOUT_MS = 30_000

// T13：create-mr.md 自己的出口表已經處理過這三種——不重複發：
//   - success / needs_qa_clarification：Step 7b.1 / 7c 已發過 TG。
//   - failed：Step 7c 已留 Notion「分析失敗」留言，使用者本來就會去 Notion 看
//     （T13 原始 description 定案，非本次新決策）。
// 這裡的 'success' 標籤底下其實還收斂了 already_fixed / i18n_manual_handoff
// 兩種子情況（classify-result.ts 把三者統一收斂成 'success'，見該檔案頭
// 註解）——這兩種 create-mr 也只留 Notion 留言、不發 TG（create-mr.md Step 7
// 出口表），跟 'failed' 同一種模式：只要 create-mr 有留 Notion 留言，就假設
// 使用者會自己去 Notion 看，dispatcher 不重複補發，不是遺漏、是跟 'failed'
// 同一套已定案邏輯的自然延伸。
//
// 剩下這四種 create-mr 完全沒機會通知（skipped 是早退分支、其餘三種是 CLI
// 這層本身沒跑完/沒吐出合法結果，create-mr 連通知邏輯的程式碼都沒機會執行
// 到，也沒留 Notion 留言），由 dispatcher 這裡補發，見 T12/T13 risk_notes
// （2026-08-14 使用者定案：infra_failure/cli_failure 併入補發範圍，見
// tasks.json changelog）。
//
// 2026-08-23 補：mr-pusher 若 push 成功但 glab mr create 全數失敗（部分成
// 功），create-mr.md 的 Step 6 review PASSED 當下就已把 pipeline_status 定為
// success，Step 7 mr-pusher 之後即使改寫 Notion AI分析 為「分析失敗」也不會
// 回頭改 Step 9 報告裡的 Pipeline status 那一行；classify-result.ts 解析的
// 正是那一行，因此這種部分成功情境會被歸類為 'success'，走不到下面
// NEEDS_NOTIFY 那組。這裡不改 classify-result.ts／create-mr.md（後者是共用
// 檔、屬維護協定紅區），改成在 main() 裡對 'success' 分類額外查一次 Notion
// 目前的 AI分析 真實值：兩者不一致（回報 success、Notion 卻是分析失敗）時，
// 直接通知 Landon（見 checkPushMismatch），不透過 NEEDS_NOTIFY／assignee 那條
// 既有路徑——這是給維運者的基礎設施層級警示，不是給 ticket 指派人的一般
// 補發通知。
const NEEDS_NOTIFY = new Set<Classification>(['skipped', 'infra_failure', 'cli_failure', 'unknown_failure'])

export function shouldNotify(classification: Classification): boolean {
  return NEEDS_NOTIFY.has(classification)
}

function log(msg: string): void {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(POST_RUN_LOG, `${new Date().toISOString()} ${msg}\n`)
}

/**
 * 由 Notion「當前指派」查 tech email——跟 create-mr.md Step 0.5 同一套判準
 * （resolve-reviewer.sh，唯讀），不是回頭問「當初是誰在 Telegram 點的」：
 * 認領判斷全程以 Notion 為準（見 HOW-TO-CONTINUE.md）。查無 URL／
 * resolve-reviewer.sh 失敗／NOT_TECH 都回傳 null，不丟例外——通知本來就是
 * best-effort，找不到人就記 log 放棄，不阻斷任何東西。
 */
function resolveAssigneeEmail(ticket: string): string | null {
  const url = getTicketNotionUrl(ticket)
  if (!url) return null
  try {
    const out = execFileSync('bash', [RESOLVE_REVIEWER_SH, url], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    const match = /^TECH_MATCH:(.+)$/m.exec(out)
    return match ? match[1]!.trim() : null
  } catch {
    return null
  }
}

function buildNotifyText(ticket: string, classification: Classification, stdoutPath: string, stderrPath: string): string {
  return `⚠️ [需人工檢查] ${ticket}
/create-mr 背景流程異常結束（分類：${classification}），沒有進入正常的成功/失敗/待釐清出口，請人工檢查 log：
${stdoutPath}
${stderrPath}`
}

/**
 * classification === 'success' 時的額外一道檢查：pipeline 自己回報成功，
 * 不代表 mr-pusher 的 git push / glab mr create 真的都成功——見上方
 * NEEDS_NOTIFY 註解說明的已知落差。這裡直接查 Notion 目前的 AI分析 真實值，
 * 若是「分析失敗」（mr-pusher 的既有邏輯：只有『沒有任何 MR 成功送出』才會
 * 設這個值，見 mr-pusher.md Step 4 設定值決策矩陣），代表兩者不一致，通知
 * Landon（維運者，不是這張 ticket 的指派人——這是基礎設施層級的異常，指派
 * 人不一定有權限/知識排查 push/MR 失敗原因）。
 *
 * best-effort：查詢本身失敗（Notion API 掛掉等）只記 log，不影響呼叫端既有
 * 的分類/通知流程。deps 可覆寫（測試用，不必真的打 Notion/Telegram API）。
 */
export function checkPushMismatch(
  ticket: string,
  classification: Classification,
  stdoutPath: string,
  stderrPath: string,
  deps: { getAiAnalysisStatus?: (ticket: string) => string | null; notify?: (text: string) => boolean } = {},
): void {
  if (classification !== 'success') return

  const getAiAnalysisStatus = deps.getAiAnalysisStatus ?? getTicketAiAnalysisStatus
  const notify = deps.notify ?? notifyOperator

  let aiStatus: string | null
  try {
    aiStatus = getAiAnalysisStatus(ticket)
  } catch (err) {
    log(`${ticket} push mismatch 檢查失敗（查詢 Notion AI分析 出錯）: ${err}`)
    return
  }
  if (aiStatus !== '分析失敗') return

  log(`${ticket} pipeline 回報 success 但 Notion AI分析=分析失敗，疑似 push 成功但 glab mr create 全數失敗，通知 Landon`)
  const text = `🚨 [push 失敗警示] ${ticket}
/create-mr 回報流程成功，但 Notion「AI分析」欄位卻是「分析失敗」——極可能是 mr-pusher 的 git push 成功、但 glab mr create 全數失敗（見 mr-pusher.md Step 4 設定值決策矩陣），請人工檢查：
${stdoutPath}
${stderrPath}`
  if (notify(text)) {
    log(`${ticket} 已通知 Landon（push mismatch）`)
  } else {
    log(`${ticket} 通知 Landon 失敗（push mismatch）`)
  }
}

/**
 * T13 CLI 進入點：從 bash EXIT trap 呼叫（見 spawn-create-mr.ts），
 * argv = [ticket, exitCode, stdoutPath]。stderrPath 用命名慣例（T11 固定
 * `{base}.stdout.log` / `{base}.stderr.log` 成對）推回來，不用多帶一個參數。
 * 全程 best-effort：任何一步失敗只記 log，不丟例外（呼叫端的 trap 不會接
 * 任何錯誤處理）。
 */
function main(): void {
  const [ticket, exitCodeRaw, stdoutPath] = process.argv.slice(2)
  if (!ticket || !exitCodeRaw || !stdoutPath) {
    log(`參數不足，略過：${process.argv.slice(2).join(' ')}`)
    return
  }

  let stdoutContent = ''
  try {
    stdoutContent = readFileSync(stdoutPath, 'utf8')
  } catch {
    // 連 stdout log 檔都讀不到（極端狀況）——當空字串處理，exitCode!=0 時
    // classifyPipelineResult 仍會正確歸類 infra_failure。
  }

  const classification = classifyPipelineResult(Number(exitCodeRaw), stdoutContent)
  log(`${ticket} classification=${classification} exitCode=${exitCodeRaw}`)

  const stderrPath = stdoutPath.replace(/\.stdout\.log$/, '.stderr.log')
  checkPushMismatch(ticket, classification, stdoutPath, stderrPath)

  if (!shouldNotify(classification)) return

  const email = resolveAssigneeEmail(ticket)
  if (!email) {
    log(`${ticket} 需要補發通知但找不到 tech assignee email（Notion 當前指派可能已變更或非 tech），略過`)
    return
  }

  const text = buildNotifyText(ticket, classification, stdoutPath, stderrPath)

  try {
    execFileSync('bash', [TG_NOTIFY_SH, '--email', email, '--text', text], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    log(`${ticket} 已補發通知給 ${email}`)
  } catch (err) {
    log(`${ticket} tg-notify.sh 呼叫失敗: ${err}`)
  }
}

if (import.meta.main) {
  main()
}
