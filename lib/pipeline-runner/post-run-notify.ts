import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { classifyPipelineResult, type Classification } from './classify-result.ts'
import { getTicketNotionUrl } from '../notion-integration/candidate-tickets.ts'

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
// 已知限制（review 發現，非本 task 範圍，未處理）：mr-pusher 若 push 成功但
// glab mr create 失敗（部分成功），create-mr.md 的 Step 6 review PASSED 當下
// 就已把 pipeline_status 定為 success，Step 7 mr-pusher 之後即使改寫 Notion
// AI分析 為「分析失敗」也不會回頭改 Step 9 報告裡的 Pipeline status 那一行；
// classify-result.ts 解析的正是那一行，因此這種部分成功情境目前仍會被歸類
// 為 'success' 而不補發通知。
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

  if (!shouldNotify(classification)) return

  const email = resolveAssigneeEmail(ticket)
  if (!email) {
    log(`${ticket} 需要補發通知但找不到 tech assignee email（Notion 當前指派可能已變更或非 tech），略過`)
    return
  }

  const stderrPath = stdoutPath.replace(/\.stdout\.log$/, '.stderr.log')
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
