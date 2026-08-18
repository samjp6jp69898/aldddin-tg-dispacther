import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchDemandTicketContent, checkSpecSufficiencyFromContent } from './spec-sufficiency-gate.ts'
import { detectRepoScope } from './repo-scope-gate.ts'
import { buildDemandImplementerPrompt } from './demand-implementer-prompt.ts'
import { execClaudeWithStdin } from './claude-exec.ts'

const execFileAsync = promisify(execFile)
const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const SETUP_WORKTREE_SH = '/Users/user/aladdin/scripts/setup-worktree.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const DEMAND_LOG = join(LOG_DIR, 'demand-pipeline.log')
const SETUP_TIMEOUT_MS = 20 * 60 * 1000 // bootstrap 含 DB migrate，比照 setup-worktree.sh 本身可能耗時的既有認知，給充足時間
const IMPLEMENTER_TIMEOUT_MS = 30 * 60 * 1000 // 已排除跨 repo 案例（複雜度最高、T35 回溯測試裡耗時最久的那組），單一 repo 給 30 分鐘

/**
 * T36：需求 pipeline 整合進 dispatcher，唯一的 CLI 進入點（`bun
 * run-demand-pipeline.ts <ticket> <assigneeEmail>`），由
 * spawn-demand-pipeline.ts fire-and-forget spawn。主要的收尾保證是這支
 * Bun 腳本自己的 try/finally（涵蓋正常結束、任何步驟拋例外的情況）；review
 * 發現這個保證有一個真實缺口：如果這支腳本本身被外部機制強制終止
 * （SIGKILL 不可被 try/finally 攔截），finally 就沒機會執行、鎖永遠不會
 * 釋放——已在 spawn-demand-pipeline.ts 補上跟 Bug pipeline 同款的外層
 * `timeout` + bash EXIT trap 當最後一道安全網（見該檔案 WRAPPER_SCRIPT
 * 註解），這裡的 try/finally 仍是主要路徑、正常情況下就會執行完畢。
 *
 * 流程：(1) 抓需求單內容 (2) T34 gate：規格不足 → 通知＋結束 (3) T36 範圍
 * 偵測（使用者 2026-08-17 定案）：跨 ≥2 個 repo → 通知『需人工複核』＋結束，
 * 不自動實作（T35 回溯測試證實跨 repo 需求範圍窮盡性不可靠，見 tasks.json
 * T35 changelog）(4) 單一 repo：setup-worktree.sh 建環境 → 組 T35 prompt →
 * 呼叫實作 agent（給真實工具權限，跟 T34/範圍偵測那種純分類呼叫不同，這裡
 * 需要它真的能讀寫檔案）(5) 完成後通知，**不清理 worktree**——不像 Bug
 * pipeline 有 push+MR 當作最終交付，這裡的交付物就是 worktree 裡的
 * uncommitted 改動本身，人工複核完才決定要不要用，太早清掉等於把唯一的
 * 產出丟了。
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

async function setupWorktree(ticket: string, repo: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // T16 既有防護：DISPATCHER_TRIGGERED=1 強制真隔離，避免跟同時可能在跑的
    // Bug pipeline 撞到共用主 repo bootstrap（見 spawn-create-mr.ts 對這個
    // 環境變數的既有註解，這裡沿用同一套機制，不重新發明）。
    const { stdout } = await execFileAsync('bash', [SETUP_WORKTREE_SH, ticket, repo], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: SETUP_TIMEOUT_MS,
      env: { ...process.env, DISPATCHER_TRIGGERED: '1' },
    })
    const lastLine = stdout.trim().split('\n').pop() ?? ''
    if (lastLine.startsWith('SETUP_OK')) return { ok: true }
    return { ok: false, reason: lastLine || '未知錯誤（setup-worktree.sh 沒有輸出可辨識的結尾行）' }
  } catch (err) {
    // review 發現：execFileAsync 逾時/非零 exit 時，真正的 SETUP_FAIL 原因在
    // err.stdout（已實測驗證），不在 err.message——原本只塞 String(err) 只
    //會給使用者看到「Command failed: bash .../setup-worktree.sh ...」這種
    // 沒有實質資訊、還洩漏內部腳本路徑的文字。優先取 err.stdout 的最後一行。
    const stdout = typeof (err as any)?.stdout === 'string' ? (err as any).stdout : ''
    const lastLine = stdout.trim().split('\n').pop() ?? ''
    if (lastLine) return { ok: false, reason: lastLine.slice(0, 500) }
    return { ok: false, reason: `執行失敗或逾時（${SETUP_TIMEOUT_MS / 60000} 分鐘）` }
  }
}

async function runImplementer(ticket: string, prompt: string, cwd: string, stdoutPath: string, stderrPath: string): Promise<{ ok: boolean; summary: string }> {
  mkdirSync(LOG_DIR, { recursive: true })
  const env = { ...process.env }
  delete env.CLAUDE_EFFORT

  try {
    // 跟 T34/repo-scope-gate 的純分類呼叫不同，這裡是真的要它讀寫檔案，
    // 給真實工具權限（不能用 --tools ""）。--permission-mode
    // bypassPermissions 的必要性理由同 spawn-create-mr.ts：headless 環境沒
    // 人能回應權限對話框；prompt 裡嵌入外部 Notion 內容存在 prompt
    // injection 風險，跟 create-mr 面對真實 bug report 文字內容時承擔的是
    // 同一類、已被既有 pipeline 接受的風險，不是 T36 新引入的風險類別。
    // prompt 走 stdin（見 claude-exec.ts），argv 不含 prompt 內容。
    const stdout = await execClaudeWithStdin(['-p', '--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--output-format', 'json'], prompt, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: IMPLEMENTER_TIMEOUT_MS,
      env,
    })
    appendFileSync(stdoutPath, stdout)
    const events = JSON.parse(stdout)
    const resultEvent = Array.isArray(events) ? events.find((e: any) => e?.type === 'result') : null
    const summary = typeof resultEvent?.result === 'string' ? resultEvent.result : '（無法解析出結果摘要，請直接看 log）'
    return { ok: true, summary }
  } catch (err) {
    // review 發現：argv 已經不含 prompt 了（走 stdin），但 err.message 仍可能
    // 帶 CLI 絕對路徑等內部細節，不直接把 String(err) 塞進最終給使用者的
    // Telegram 訊息——用 err.killed/err.signal 明確分辨『逾時被殺』給乾淨
    // 文案，其他情況才附上截斷過的錯誤字串（技術 log 檔案本身仍完整記錄
    // 原始錯誤，供人工深入排查）。
    appendFileSync(stderrPath, String(err))
    const isTimeout = (err as any)?.killed === true || (err as any)?.signal === 'SIGTERM'
    const summary = isTimeout
      ? `實作 agent 逾時被中止（${IMPLEMENTER_TIMEOUT_MS / 60000} 分鐘），詳情請看 ${stderrPath}`
      : `實作 agent 執行失敗，詳情請看 ${stderrPath}（錯誤摘要：${String((err as any)?.message ?? err).slice(0, 200)}）`
    return { ok: false, summary }
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
      notify(ticket, assigneeEmail, `${ticket} 規格不足，無法自動實作：\n${sufficiency.missing}\n\n請在 Notion 補充規格後重新認領。`)
      return
    }

    const repos = await detectRepoScope(ticket, bodyText, comments)
    log(`${ticket} 範圍偵測結果：${repos.join(', ')}`)

    if (repos.length >= 2) {
      // 使用者 2026-08-17 定案：跨 ≥2 個 repo 的需求不自動實作，T35 回溯
      // 測試證實這種需求的範圍窮盡性不可靠（複雜樣本漏了 2 個獨立呼叫點），
      // 標記需人工複核而非直接視為完成。
      notify(ticket, assigneeEmail, `${ticket} 判斷會跨 ${repos.length} 個 repo（${repos.join('、')}），目前的自動化 pipeline 對跨 repo 需求的範圍判斷還不夠可靠，需要你自己動手處理，不會自動實作。`)
      return
    }

    const repo = repos[0]!
    const worktreePath = `/Users/user/aladdin/worktrees/${ticket}/${repo}`

    const setupResult = await setupWorktree(ticket, repo)
    if (!setupResult.ok) {
      log(`${ticket} worktree 建置失敗：${setupResult.reason}`)
      notify(ticket, assigneeEmail, `${ticket} 環境建置失敗，無法自動實作：${setupResult.reason}\n請聯絡維運人員或自行處理。`)
      return
    }

    const prompt = buildDemandImplementerPrompt(ticket, bodyText, comments, { repos: [repo], worktreePaths: { [repo]: worktreePath } })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const stdoutPath = join(LOG_DIR, `${ticket}.${timestamp}.demand-implementer.stdout.log`)
    const stderrPath = join(LOG_DIR, `${ticket}.${timestamp}.demand-implementer.stderr.log`)

    const result = await runImplementer(ticket, prompt, worktreePath, stdoutPath, stderrPath)
    log(`${ticket} 實作 agent 執行結束，ok=${result.ok}`)

    notify(
      ticket,
      assigneeEmail,
      `${ticket} 需求實作 agent 已跑完（${result.ok ? '有產出' : '執行異常'}）。\n\n這是輔助草稿，不是自動完成——請務必人工複核後才能用：\n工作目錄：${worktreePath}\nlog：${stdoutPath}\n\n摘要：\n${result.summary.slice(0, 1000)}`,
    )
  } catch (err) {
    log(`${ticket} pipeline 未預期例外：${err}`)
    notify(ticket, assigneeEmail, `⚠️ ${ticket} 需求 pipeline 執行時發生未預期錯誤，請人工檢查：${String(err).slice(0, 300)}`)
  } finally {
    releaseLock(ticket)
  }
}

if (import.meta.main) {
  main()
}
