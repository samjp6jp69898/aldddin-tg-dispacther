import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { classifyPipelineResult, type Classification } from './classify-result.ts'
import { getTicketNotionUrl, getTicketAiAnalysisStatus } from '../notion-integration/candidate-tickets.ts'
import { notifyOperator } from '../notify/operator.ts'
import { submitCreateMr } from './spawn-create-mr.ts'
import { declareMonitorRole, isMonitorDbEnabled, MON_HOST } from '../monitor-db/env.ts'
import { writeRunOutcomeAuthoritative, type MonitorDbExecutor } from '../monitor-db/writes.ts'
import { createSpoolWriter, type SpoolWriterHandle } from '../monitor-db/spool/writer.ts'
import { SHORT_LIVED_WRITE_BUDGET_MS, closeLongLivedMonitorPool, monitorRoleForThisHost, tryWriteOrSpool } from '../monitor-db/runtime.ts'
import type { RunKind } from '../monitor-db/types.ts'

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
// timeout 分類（exitCode 124）的強制升級對象：Landon（tech-users.csv 的
// 「KHH Landon Lo」列）。跟下面 resolveAssigneeEmail 抓到的「當前指派」是
// 兩件事、互不取代——指派 tech 可能換人或查無資料，2026-08-25 使用者定案
// 「遇到 timeout 一定要發 TG 通知到 landon」，不能讓這條路徑跟著指派解析
// 一起 best-effort 放棄，所以獨立於下面 main() 的 email 分支之外，永遠嘗試。
const TIMEOUT_ESCALATION_EMAIL = 'pkh_samjp6jp69898@photons.com.tw'
const TRACKER_SH = '/Users/user/aladdin/scripts/tracker.sh'
// 2026-08-26 使用者定案：timeout 分類不能只發通知乾等人工，要能自己重試——
// 但「resume 模式重跑」本身也可能再度 timeout（例如這張票本來就結構性偏
// 大，任何一輪都跑不完 180 分鐘），沒有上限會對同一張票無限燒 opus。跟
// aladdin-05（同時在做 tg-monitor 手動重試按鈕，兩邊共用 spawnCreateMr 的
// opts.resume 介面，見 2026-08-26 對齊訊息）講好的分工：resume 偵測/續跑本身
// 是 create-mr.md Step 0.2 + resume-inventory.sh 的職責，這裡只負責「要不要
// 觸發、觸發幾次」的判斷。
const AUTO_RETRY_LIMIT = 2
// 跟 telegram-dispatcher/lib/pipeline-runner/concurrency-limiter.ts 的
// GLOBAL_CONCURRENCY_LIMIT 同步——這裡故意不 import 那個 in-memory 計數器：
// 本檔是 spawn-create-mr.ts 的 bash EXIT trap 每次現叫的全新 bun 子行程，
// import 到的計數器永遠是這個一次性 process 自己從 0 開始的獨立副本，看不到
// 真正常駐的 webhook server process 累積了多少名額，用它判斷會允許實際併發
// 超過上限（tg-monitor 的 /api/pipelines/retry 也踩過同一個坑，同一套修法：
// 改用 ps 現場真實計數，不管由哪個 process 觸發都反映同一個事實）。
const BUG_PIPELINE_CONCURRENCY_LIMIT = 5
// 尾端可選的字面 `resume`（2026-08-26）：WRAPPER_SCRIPT 的 $3 值域固定
// {'resume', ''}——resume 模式的 wrapper 命令列多一個尾 token，不允許它的話
// resume run 會完全掃不到（tg-monitor lib/ingest.ts 同一條 regex 實際踩過，
// 兩處要同步維護）。
const RUN_CREATE_MR_PROC_RE = /^bash -c [\s\S]*\brun-create-mr\s+([A-Z]+-\d+)\s+(\S+?)(?:\s+resume)?\s*$/

// T13：create-mr.md 自己的出口表已經處理過這三種——不重複發：
//   - success / needs_qa_clarification：Step 7b.1 / 7c 已發過 TG。
//   - failed：Step 7c 已留 Notion「分析失敗」留言（2026-08-26 起 create-mr 的
//     7c 還會自己發 TG 通知＋附 Drive 分析文件連結——dispatcher 這裡照舊不補
//     發，否則同一張 failed 會收到兩則）
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
// 2026-09-04：session_limit（見 classify-result.ts 檔頭「2026-09-04 研究
// 補充」）跟其他四類同源——create-mr 完全沒機會通知，一併納入補發範圍。
const NEEDS_NOTIFY = new Set<Classification>(['skipped', 'timeout', 'infra_failure', 'cli_failure', 'unknown_failure', 'session_limit'])

export function shouldNotify(classification: Classification): boolean {
  return NEEDS_NOTIFY.has(classification)
}

/**
 * `path` 可注入（2026-09-04，MON_DB_USER 根因調查發現的污染源修復）：
 * `post-run-notify.test.ts` 的角色不符測試（FAQ-9007/9008）刻意不注入
 * `deps.pool`，讓 `writeAuthoritativeOutcome()` 真的走到 `createMonitorPool()`
 * 拋出例外的分支——但拋出後的 `log()` 呼叫沒有路徑可覆寫，於是每次
 * `bun test` 都真的把測試訊息寫進生產事故日誌（實測 FAQ-9007 19 筆、
 * FAQ-9008 14 筆）。預設值＝現行硬編路徑，正常呼叫端（本檔其餘十幾個
 * `log(msg)` 呼叫點）完全不用改，行為逐位元組不變。
 */
function log(msg: string, path: string = POST_RUN_LOG): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${new Date().toISOString()} ${msg}\n`)
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

/** 預設的 email 通知管道：tg-notify.sh 失敗只回傳 false，不拋例外（跟 notifyOperator 同一套 best-effort 慣例）。 */
function notifyViaEmail(email: string, text: string): boolean {
  try {
    execFileSync('bash', [TG_NOTIFY_SH, '--email', email, '--text', text], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/**
 * 2026-09-04 bug 修復：原本 resolveAssigneeEmail() 解析失敗（Notion 查詢失敗
 * ／指派人非 tech／例外）時只印一行 log，完全不發任何 TG 通知——只有
 * classification==='timeout' 才有強制升級給 TIMEOUT_ESCALATION_EMAIL 的保底
 * 機制，其餘分類（session_limit/infra_failure/cli_failure/unknown_failure/
 * skipped）沒有，等於補發通知路徑本身可能靜默失敗。現在不管哪個分類，只要
 * 走到這裡（見 main() 呼叫處，NEEDS_NOTIFY 已篩過），最終一定會嘗試發給
 * 一個人：優先嘗試 ticket 的當前指派 tech，解析失敗/通知失敗都退回發給同一個
 * TIMEOUT_ESCALATION_EMAIL（沿用既有常數，不另開新的）。
 *
 * classification==='timeout' 是唯一例外：main() 在呼叫這個函式之前已經無
 * 條件對 TIMEOUT_ESCALATION_EMAIL 發過一次強制升級通知（見該處註解），這裡
 * 的 escalate() 對 timeout 分類直接跳過，避免同一個人收到兩則幾乎一樣的
 * 訊息——不是漏做，是刻意不重複。
 *
 * deps 可覆寫（測試用，不必真的打 Notion/Telegram API）。
 */
export function notifyAssigneeOrEscalate(
  ticket: string,
  classification: Classification,
  text: string,
  deps: { resolveEmail?: (ticket: string) => string | null; notify?: (email: string, text: string) => boolean } = {},
): void {
  const resolveEmail = deps.resolveEmail ?? resolveAssigneeEmail
  const notify = deps.notify ?? notifyViaEmail

  const escalate = (reason: string): void => {
    if (classification === 'timeout') {
      log(`${ticket} classification=timeout，保底聯絡人已在強制升級區塊處理過，不重複發（${reason}）`)
      return
    }
    if (notify(TIMEOUT_ESCALATION_EMAIL, text)) {
      log(`${ticket} 已改發保底聯絡人 ${TIMEOUT_ESCALATION_EMAIL}（原因：${reason}）`)
    } else {
      log(`${ticket} 保底聯絡人 ${TIMEOUT_ESCALATION_EMAIL} 通知也失敗（原因：${reason}）`)
    }
  }

  let email: string | null
  try {
    email = resolveEmail(ticket)
  } catch (err) {
    log(`${ticket} assignee 解析例外: ${err}`)
    escalate('assignee 解析例外')
    return
  }

  if (!email) {
    log(`${ticket} 需要補發通知但找不到 tech assignee email（Notion 當前指派可能已變更或非 tech）`)
    escalate('找不到 tech assignee email')
    return
  }

  if (classification === 'timeout' && email === TIMEOUT_ESCALATION_EMAIL) {
    // classification==='timeout' 且 email 剛好等於 Landon 時，上面已經發過
    // 同一份文字給同一個人，這裡跳過避免重複發送。
    return
  }

  if (notify(email, text)) {
    log(`${ticket} 已補發通知給 ${email}`)
  } else {
    log(`${ticket} 補發通知給 ${email} 失敗`)
    escalate('補發給 assignee 失敗')
  }
}

/**
 * 2026-09-04：逐一檢查每種需要補發通知的分類，確保收到訊息的人一眼就能看出
 * 是哪種結束方式——不能共用同一段泛用文字（改動前只有 timeout 有專屬文字，
 * 其餘四類全部共用同一句「異常結束（分類：xxx）」，只在括號裡塞分類代號，
 * 對非技術 assignee 不夠一眼看懂）。每個分支的第一行方括號標籤故意互不相同。
 */
export function buildNotifyText(ticket: string, classification: Classification, stdoutPath: string, stderrPath: string, retryNote: string): string {
  const logLines = `${stdoutPath}\n${stderrPath}`

  switch (classification) {
    case 'timeout':
      return `⚠️ [逾時中止] ${ticket}
/create-mr 背景流程逾時（超過 spawn-create-mr.ts 設定的 180 分鐘上限）被強制中止，沒有進入正常的成功/失敗/待釐清出口。${retryNote}請人工檢查 log：
${logLines}`

    case 'session_limit':
      // 見 classify-result.ts 檔頭「2026-09-04 研究補充」：這是低信心度字串
      // 比對，不是官方保證的訊號，文字必須用「疑似」，不能斷言為事實。
      return `⚠️ [疑似 Claude 額度用盡] ${ticket}
/create-mr 背景流程異常結束，log 內容疑似出現 Claude session/usage limit（5 小時或週上限）已用盡的訊息——這是低信心度的文字特徵比對，不保證正確，請人工核實：若確認是額度問題，可等額度重置後手動重試（或用 resume 模式重跑）；若判斷有誤，請依下方 log 內容自行歸類為其他問題：
${logLines}`

    case 'skipped':
      return `⚠️ [提早結束] ${ticket}
/create-mr 在正式分析前的前置檢查就判定這張票不可認領（例如已被鎖定、或當前指派不在 tech 名單）而提早結束，沒有進入正常的成功/失敗/待釐清出口。請確認這張票是否需要人工介入，log：
${logLines}`

    case 'infra_failure':
      return `⚠️ [CLI 執行環境異常] ${ticket}
/create-mr 背景流程的外層執行環境本身以非 0 exit code 結束（非逾時），代表 claude -p 這層可能根本沒能正常啟動或跑完（例如指令找不到、環境設定錯誤），沒有進入正常的成功/失敗/待釐清出口。請人工檢查 log：
${logLines}`

    case 'cli_failure':
      return `⚠️ [CLI 回報失敗] ${ticket}
/create-mr 的 claude -p 有執行完畢，但輸出結果被 CLI 自己標記為失敗（is_error 或非 success 狀態），沒有進入正常的成功/失敗/待釐清出口。請人工檢查 log：
${logLines}`

    case 'unknown_failure':
      return `⚠️ [輸出無法辨識] ${ticket}
/create-mr 的 claude -p 有執行完畢且 CLI 層級回報成功，但輸出內容裡找不到可辨識的 Pipeline status（可能是報告格式被改寫、或輸出了非預期內容），沒有進入正常的成功/失敗/待釐清出口。請人工檢查 log：
${logLines}`

    default:
      // success/needs_qa_clarification/failed 這三類不會走到補發通知路徑
      // （見上方 NEEDS_NOTIFY），這裡只是保底分支，理論上不會被呼叫到。
      return `⚠️ [需人工檢查] ${ticket}
/create-mr 背景流程異常結束（分類：${classification}），沒有進入正常的成功/失敗/待釐清出口，請人工檢查 log：
${logLines}`
  }
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

const MONITOR_WRITE_BUDGET_MS = SHORT_LIVED_WRITE_BUDGET_MS // §6.7：短命行程總預算（await，不是 fire-and-forget）
const BUG_RUN_KIND: RunKind = 'bug'

/**
 * 2026-09-03 根因修復（見 switch-readiness.ts C4/C6 持續性缺口分析）：從
 * stdoutPath 反推 `<ticket>.<timestamp>` 格式的 legacy_key——spawn-create-mr.ts
 * 的 spawnCreateMrNow 用同一個 `base`（見該檔 `const base = \`${ticket}.${timestamp}\``）
 * 同時鑄出 legacyKey 與 stdoutPath（`${base}.stdout.log`），兩者互為可逆運算，
 * 這裡只是反過來剝掉目錄與 `.stdout.log` 後綴，不是重新臆測格式。
 */
function deriveLegacyKeyFromStdoutPath(stdoutPath: string): string {
  return basename(stdoutPath).replace(/\.stdout\.log$/, '')
}

// `<ticket>.<timestamp>` 裡的 timestamp 段固定是
// `new Date().toISOString().replace(/[:.]/g, '-')` 的輸出（spawn-create-mr.ts
// 的 `const timestamp = ...`），形狀固定是 `YYYY-MM-DDTHH-MM-SS-mmmZ`——把
// `:`/`.` 換回來就是可還原的 ISO 字串，不是憑空臆測格式。
const TIMESTAMP_TOKEN_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

/**
 * 2026-09-03 根因修復追加：只補 legacy_key/stdout_path/stderr_path 三欄不夠——
 * tg-monitor 的 `RUNS_LIST_WHERE`（lib/read/mysql.ts）要求 `started_at IS NOT
 * NULL` 才會被 `pipelineRuns()`（switch-readiness.ts C4 的實際讀取入口）看見，
 * W2 INSERT fallback 原本完全不寫這欄，即使 legacy_key/stdout_path 都補齊，
 * C4 缺口仍不會消失。
 *
 * 這裡從 legacyKey 反推 startedAt：與 sqlite 側 `pipeline_runs.started_at`
 * 完全同構——兩邊都是從同一個 log 檔名時間戳反推（見
 * switch-readiness.ts 檔頭「`started_at` 的兩軌容差」說明），不是臆測值，
 * C5 的 `STARTED_AT_TOLERANCE_MS` 容差窗本來就是為這種「兩次獨立 new Date()」
 * 的落差設計，這裡反而是 Δ=0（同一個字串反推）。
 *
 * 解析失敗（legacyKey 不是預期形狀）回傳 null，呼叫端就不硬填假值。
 */
function deriveStartedAtFromLegacyKey(legacyKey: string, ticket: string): string | null {
  if (!legacyKey.startsWith(`${ticket}.`)) return null
  const token = legacyKey.slice(ticket.length + 1)
  const m = TIMESTAMP_TOKEN_RE.exec(token)
  if (!m) return null
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
}

/**
 * 2026-09-03 根因修復追加：補列路徑（W2 INSERT fallback）沒有 in-memory 的
 * `entry.triggeredBy` 可用——唯一還原得到的來源是 spawn 當時同一個 base
 * 寫的 sidecar 檔（見 spawn-create-mr.ts spawnCreateMrNow：只有
 * `entry.triggeredBy` 存在時才會寫這個檔，因此檔案存在 ⟺ 這一輪原本就是
 * `trigger_source='telegram'`，跟 spawn-create-mr.ts 的
 * `triggerSource: entry.triggeredBy ? 'telegram' : 'cli'` 同構）。
 *
 * 檔案不存在時無法分辨「本來就是 cli 觸發（正常，不寫檔）」還是「telegram
 * 觸發但檔案也一併遺失」——回傳 null，呼叫端讓三欄維持 NULL，不猜一個可能
 * 錯誤的 'cli'（寧可留白也不誤植假值）。JSON 損毀視同讀不到，同樣回傳
 * null 並記 log；全程 best-effort，不拋例外。
 */
function readTriggeredBy(legacyKey: string): { email: string; name: string } | null {
  const path = join(LOG_DIR, `${legacyKey}.triggered-by.json`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; email?: unknown }
    if (typeof parsed.email !== 'string' || typeof parsed.name !== 'string') {
      log(`${legacyKey} triggered-by.json 格式不符預期（缺 email/name），略過: ${path}`)
      return null
    }
    return { email: parsed.email, name: parsed.name }
  } catch (err) {
    log(`${legacyKey} triggered-by.json 解析失敗，略過: ${path}: ${err}`)
    return null
  }
}

/**
 * 【plan-db-as-truth-v3.2.md §9 Phase2】bug 終態（權威，tier2）：本檔是
 * WRAPPER_SCRIPT 的 EXIT trap 子行程，`process.env.MON_RUN_ID` 繼承自
 * spawn 時顯式覆寫的值（見 spawn-create-mr.ts 的 spawnCreateMrNow），正是
 * 這一輪 run 自己的 run_id——不需要碰 DB／讀 marker 檔就能拿到。
 *
 * 短命行程紀律（§6.7）：await（不是 fire-and-forget），總預算 3 秒，逾時或
 * 失敗落 spool；退出前明確關閉本函式自己建立的連線／spool fd（不是等待，
 * 是確定性地釋放資源，讓行程能乾淨結束，不留著 socket 卡住 event loop）。
 * `deps` 只給測試注入假 pool/spool，production 呼叫端一律不傳。
 *
 * `stdoutPath`/`stderrPath`（2026-09-03 新增，根因修復）：main() 從 argv/命名
 * 慣例推回的這一輪 log 路徑——W2 若因 W1 遺失而走 INSERT fallback，這是
 * legacy_key/stdout_path/stderr_path 唯一能落地的機會（見 writes.ts
 * W2_INSERT_SQL 檔頭註解）。W1 若已正常寫過，這三欄早已存在，UPDATE 路徑不會
 * 用到這裡傳的值（W2_UPDATE_SQL 本來就不觸碰這三欄）。
 */
export async function writeAuthoritativeOutcome(
  ticket: string,
  classification: Classification,
  exitCode: number,
  stdoutPath: string,
  stderrPath: string,
  deps: { pool?: MonitorDbExecutor | null; spool?: SpoolWriterHandle; logPath?: string } = {},
): Promise<void> {
  // logPath 只給測試注入暫存路徑（見 log() 檔頭理由），production 呼叫端
  // 一律不傳，等同直接呼叫 log(msg)。
  const logMsg = (msg: string): void => log(msg, deps.logPath)
  const testMode = 'pool' in deps || 'spool' in deps
  if (!isMonitorDbEnabled() && !testMode) return

  const runId = (process.env.MON_RUN_ID ?? '').trim()
  if (!runId) {
    logMsg(`${ticket} 監控 DB 寫入略過：process.env.MON_RUN_ID 為空（非本次 v3.2 spawn 鏈觸發，或環境變數遺失）`)
    return
  }

  const finishedAt = new Date().toISOString()
  const legacyKey = deriveLegacyKeyFromStdoutPath(stdoutPath)
  const triggeredBy = readTriggeredBy(legacyKey)
  const input = {
    runId,
    ticket,
    kind: BUG_RUN_KIND,
    outcome: classification,
    outcomeSource: 'post-run-notify',
    finishedAt,
    exitCode,
    legacyKey,
    stdoutPath,
    stderrPath,
    startedAt: deriveStartedAtFromLegacyKey(legacyKey, ticket),
    triggerSource: triggeredBy ? 'telegram' : null,
    triggeredByEmail: triggeredBy?.email ?? null,
    triggeredByName: triggeredBy?.name ?? null,
  }

  let pool: MonitorDbExecutor | null = null
  let ownsPool = false
  try {
    if ('pool' in deps) {
      pool = deps.pool ?? null
    } else {
      const { createMonitorPool } = await import('../monitor-db/pool.ts')
      pool = createMonitorPool(monitorRoleForThisHost(), { connectionLimit: 1 })
      ownsPool = true
    }
  } catch (err) {
    logMsg(`${ticket} 監控 DB 連線建立失敗: ${err}`)
  }

  // 整合修補批次 item 7：「預算內嘗試寫入，逾時/失敗落 spool」的核心邏輯
  // 已收斂進 lib/monitor-db/runtime.ts 的 tryWriteOrSpool（與 demand pipeline
  // 的短命行程共用同一份實作）。pool 一開始就是 null（連線建立失敗，或測試
  // 注入 `{pool:null}` 模擬）時完全不必試寫，直接落 spool——這一層判斷留在
  // 本檔（tryWriteOrSpool 的介面要求 pool 一定存在），行為與重構前逐位元組
  // 相同。
  if (pool) {
    const spoolForWrite = deps.spool ?? createSpoolWriter({ writer: 'post-run-notify' })
    await tryWriteOrSpool({
      budgetMs: MONITOR_WRITE_BUDGET_MS,
      pool,
      spool: spoolForWrite,
      runId,
      fn: 'writeRunOutcomeAuthoritative',
      args: [input],
      attempt: p => writeRunOutcomeAuthoritative(p, input),
      onFailLabel: `${ticket} 監控 DB 寫入`,
    })
    if (!deps.spool) spoolForWrite.close()
  } else {
    try {
      const spool = deps.spool ?? createSpoolWriter({ writer: 'post-run-notify' })
      spool.append({ ts: new Date().toISOString(), host: MON_HOST, run_id: runId, fn: 'writeRunOutcomeAuthoritative', args: [input] })
      if (!deps.spool) spool.close()
    } catch (spoolErr) {
      logMsg(`${ticket} 監控 DB 寫入與落 spool 都失敗，本次終態遺失: ${spoolErr}`)
    }
  }

  // 退出前明確釋放本函式自己建立的連線（注入的假 pool 由呼叫端自己管理生命
  // 週期，不在這裡關）；短命行程不留著連線讓 process 掛在 event loop 上。
  if (ownsPool && pool && 'end' in pool && typeof (pool as unknown as { end: unknown }).end === 'function') {
    try {
      await (pool as unknown as { end: () => Promise<void> }).end()
    } catch (err) {
      logMsg(`${ticket} 監控 DB 連線關閉失敗（不影響已完成的寫入/落 spool）: ${err}`)
    }
  }
}

/**
 * post-run-notify.log 逐行都有 `<ticket> classification=<...>` 這行（main()
 * 每次都先 log 一行，不管要不要通知——見下方呼叫處），從尾端往回數這張票
 * 連續幾次都是 timeout：中間只要出現過一次非 timeout（含真正的 success），
 * 就代表上一輪的失敗鏈已經斷開，計數自然歸零，不需要額外的重置邏輯或狀態。
 */
function countTrailingTimeouts(ticket: string): number {
  let content = ''
  try {
    content = readFileSync(POST_RUN_LOG, 'utf8')
  } catch {
    return 0
  }
  const re = new RegExp(`^\\S+Z ${ticket} classification=(\\S+) exitCode=\\S+$`)
  const classifications: string[] = []
  for (const line of content.split('\n')) {
    const m = re.exec(line)
    if (m) classifications.push(m[1]!)
  }
  let count = 0
  for (let i = classifications.length - 1; i >= 0; i--) {
    if (classifications[i] !== 'timeout') break
    count++
  }
  return count
}

/**
 * ps 現場掃描目前還活著的 bug pipeline wrapper（見 concurrency 註解）。
 *
 * excludePid 一定要傳這個 process 自己的 process.ppid（見呼叫端）：本檔是
 * spawn-create-mr.ts 的 WRAPPER_SCRIPT EXIT trap 直接執行的子行程（trap body
 * 跑在觸發 trap 的同一個 bash 裡，不是 subshell），trap 執行期間那個 wrapper
 * bash 自己還沒結束、仍活在 ps 裡，且它的完整 argv（`bash -c <script>
 * run-create-mr <ticket> <stdoutPath>`）本身就會命中 RUN_CREATE_MR_PROC_RE
 * ——不排除的話，這張票「自己」永遠會被算進「目前正在跑」，讓
 * planAutoRetry 的防禦性檢查每次都對自己誤判，自動重試永遠不會觸發（2026-08-26
 * aladdin-05 review 實測驗證：`bash -c 'trap "true" EXIT; sleep 3' run-create-mr
 * <ticket> <log> &` 之後 `ps` 就能看到這行，且 trap 內指令的 argv 不會蓋掉
 * 外層 script 的位置參數，多指令 trap body 也不會被 exec 取代掉行程本身）。
 */
export function parseRunningBugTickets(psOutput: string, excludePid: number): string[] {
  const tickets: string[] = []
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    if (Number(m[1]) === excludePid) continue
    const mm = RUN_CREATE_MR_PROC_RE.exec(m[2]!)
    if (mm) tickets.push(mm[1]!)
  }
  return tickets
}

function listRunningBugTickets(): string[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    return parseRunningBugTickets(out, process.ppid)
  } catch {
    return []
  }
}

type RetryDecision = { attempted: boolean; note: string }

/**
 * timeout 分類的自動重試判斷（不含實際觸發，觸發交給呼叫端）：依序檢查
 * 「這張票連續 timeout 是否已達上限」→「這張票此刻是否仍在跑（不該發生，
 * 防禦用）」→「全域 bug pipeline 併發是否已滿」。任一條件擋下就不重試，只
 * 回傳給人看的說明文字，不做任何有副作用的動作（tracker.sh set / spawn 由
 * main() 在拿到 attempted=true 之後才執行，讓「決定」與「動作」分開，方便
 * 各自獨立記 log 追蹤）。
 */
function planAutoRetry(ticket: string): RetryDecision {
  const trailingTimeouts = countTrailingTimeouts(ticket)
  if (trailingTimeouts > AUTO_RETRY_LIMIT) {
    return { attempted: false, note: `已連續 timeout ${trailingTimeouts} 次（上限 ${AUTO_RETRY_LIMIT}），不再自動重試，` }
  }
  const runningTickets = listRunningBugTickets()
  if (runningTickets.includes(ticket)) {
    return { attempted: false, note: '偵測到這張票目前仍有背景流程在跑（不應該發生，可能是併發衝突），跳過自動重試，' }
  }
  if (runningTickets.length >= BUG_PIPELINE_CONCURRENCY_LIMIT) {
    return { attempted: false, note: `目前背景 pipeline 併發已達上限（${BUG_PIPELINE_CONCURRENCY_LIMIT}），暫不自動重試，` }
  }
  return { attempted: true, note: `已觸發第 ${trailingTimeouts} 次自動重試（resume 模式，上限 ${AUTO_RETRY_LIMIT} 次）——` }
}

/** 真正執行重試：claim 前置（tracker 設回 rerun）+ resume 模式 spawn。任何一步失敗都記 log、不拋例外。 */
function executeAutoRetry(ticket: string): void {
  try {
    execFileSync('bash', [TRACKER_SH, 'set', ticket, 'rerun'], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
  } catch (err) {
    log(`${ticket} 自動重試中止：tracker.sh set rerun 失敗: ${err}`)
    return
  }
  // 本檔是一次性 CLI 子行程（見檔頭註解）：submitCreateMr 的 in-memory 佇列
  // 在這個 process 裡永遠是空的、limiter 從 0 起算，實際只會走 started /
  // spawn_error 兩種結果——排隊語意只存在於常駐的 webhook server process。
  const spawned = submitCreateMr(ticket, { resume: true })
  if (spawned.ok) {
    log(`${ticket} 自動重試已 spawn（resume 模式，${spawned.status === 'started' ? `pid ${spawned.pid}` : `status=${spawned.status}`}）`)
  } else {
    log(`${ticket} 自動重試 spawn 失敗: ${spawned.reason}`)
  }
}

/**
 * T13 CLI 進入點：從 bash EXIT trap 呼叫（見 spawn-create-mr.ts），
 * argv = [ticket, exitCode, stdoutPath]。stderrPath 用命名慣例（T11 固定
 * `{base}.stdout.log` / `{base}.stderr.log` 成對）推回來，不用多帶一個參數。
 * 全程 best-effort：任何一步失敗只記 log，不丟例外（呼叫端的 trap 不會接
 * 任何錯誤處理）。
 */
async function main(): Promise<void> {
  // 2026-09-03 補（承 2026-09-02 熱修 183bf5a 明確留下的缺口：本檔當時未升級）：
  // 本檔固定只在 head 機器上跑（bug pipeline 的 EXIT trap 短命 CLI，spawn 端
  // 見 spawn-create-mr.ts，只在 head 常駐的 server.ts 觸發，worker 不會執行
  // 這支 CLI），跟 server.ts/worker-agent.ts 一樣在最早執行處顯式宣告角色——
  // 之後 writeAuthoritativeOutcome() 內的 monitorRoleForThisHost() 一律用宣告
  // 值，不再嗅探 process.env.CLUSTER_WORKER_NAME（head .env 殘留這個變數時不
  // 再誤判成 worker，見 env.ts declareMonitorRole 註解）。
  declareMonitorRole('mon_head')

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

  // stderrPath 用命名慣例（T11 固定 `{base}.stdout.log` / `{base}.stderr.log`
  // 成對）推回來，不用多帶一個參數。提前到這裡計算（原本在 checkPushMismatch
  // 呼叫前才算）：下面 writeAuthoritativeOutcome 也需要它（2026-09-03 根因
  // 修復，見該函式檔頭註解）。
  const stderrPath = stdoutPath.replace(/\.stdout\.log$/, '.stderr.log')

  // 【plan-db-as-truth-v3.2.md §9 Phase2】權威終態寫入：不管要不要補發 TG
  // 通知都要寫（跟下面的 NEEDS_NOTIFY 分支完全獨立），這是每一輪 run 的
  // 監控 DB 生命週期收尾，不是「需要通知」才做的事。獨立包一層 try/catch：
  // 這裡失敗不能連坐擋掉下面既有的通知邏輯（該保證從遷移前就存在）。
  try {
    await writeAuthoritativeOutcome(ticket, classification, Number(exitCodeRaw), stdoutPath, stderrPath)
  } catch (err) {
    log(`${ticket} writeAuthoritativeOutcome 例外（不影響既有通知邏輯）: ${err}`)
  }

  checkPushMismatch(ticket, classification, stdoutPath, stderrPath)

  if (!shouldNotify(classification)) return

  // 自動重試判斷＋執行也獨立包 try/catch、排在 Landon 升級通知**之前**——
  // 跟下面 Landon 那塊同一個理由：不能讓這裡任何一步的例外（ps／tracker.sh／
  // spawnCreateMr 都可能拋）連坐擋掉「timeout 一定通知到 Landon」的保證。
  // retryNote 預設空字串，即使這整塊失敗，下面的通知文字仍然完整可讀，只是
  // 少一句重試狀態說明，不影響「有沒有發出通知」這個更重要的保證。
  let retryNote = ''
  if (classification === 'timeout') {
    try {
      const decision = planAutoRetry(ticket)
      retryNote = decision.note
      if (decision.attempted) executeAutoRetry(ticket)
    } catch (err) {
      log(`${ticket} 自動重試判斷/執行例外: ${err}`)
    }
  }

  const text = buildNotifyText(ticket, classification, stdoutPath, stderrPath, retryNote)

  // timeout 分類的強制升級：故意排在 assignee 解析**之前**、獨立成自己的
  // try/catch。review 2026-08-25 發現：resolveAssigneeEmail() 呼叫的
  // getTicketNotionUrl()（candidate-tickets.ts）本身沒有 try/catch 也沒有
  // exec timeout，Notion API 逾時/5xx/回傳格式跑掉都會讓例外一路往上炸穿
  // main()——而 timeout 分類本來就常伴隨環境/網路異常，這正是這條路徑最容易
  // 斷的時候。若原本寫法（assignee 解析在前、Landon 升級在後）遇到這個例外，
  // Landon 會什麼通知都收不到，直接違背「timeout 一定要通知到 Landon」這個
  // 保證。改成 Landon 這塊完全不依賴下面 assignee 解析是否成功/是否拋例外。
  if (classification === 'timeout') {
    try {
      execFileSync('bash', [TG_NOTIFY_SH, '--email', TIMEOUT_ESCALATION_EMAIL, '--text', text], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
      log(`${ticket} timeout 升級通知已發給 Landon（${TIMEOUT_ESCALATION_EMAIL}）`)
    } catch (err) {
      log(`${ticket} timeout 升級通知（Landon）tg-notify.sh 呼叫失敗: ${err}`)
    }
  }

  // assignee 解析＋通知＋（解析/發送失敗時的）保底升級，全部收斂進
  // notifyAssigneeOrEscalate（見該函式檔頭 2026-09-04 bug 修復說明）：不管
  // 哪個分類，走到這裡最終一定會有人收到通知，不會再只印 log 就結束。
  notifyAssigneeOrEscalate(ticket, classification, text)
}

if (import.meta.main) {
  main()
    .catch(err => {
      // main() 內部各段已各自 try/catch（best-effort 紀律，見檔頭註解），這裡
      // 只是最後一道安全網，避免萬一有漏接的例外變成 unhandled rejection。
      console.error(`post-run-notify: main() 未預期例外: ${err}`)
    })
    .finally(() => {
      // B-3（review-final-A-dispatcher.md）：timeout 自動重試路徑
      // （executeAutoRetry → submitCreateMr → spawnCreateMrNow →
      // dispatchMonitorWrite）會在本 CLI 行程建立 runtime.ts 的長駐 pool 單例，
      // keep-alive 連線讓 bun 永不退出 → wrapper EXIT trap 卡死 → onExit 永不
      // 觸發 → 每次 timeout 永久洩漏一個併發名額＋active marker。這裡是本
      // 行程唯一的出口，無條件收掉那個單例（從未建立時 no-op）。
      // writeAuthoritativeOutcome 自建自關的短命 pool 不在此列（那段本來就沒問題）。
      void closeLongLivedMonitorPool().catch(() => {})
    })
}
