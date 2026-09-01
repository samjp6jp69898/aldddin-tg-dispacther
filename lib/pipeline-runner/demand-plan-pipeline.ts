import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execClaudeWithStdin } from './claude-exec.ts'
import { cleanupWorktreesForTicket } from './cleanup-worktree.ts'
import { buildDraftPrompt, buildReviewPrompt, buildSynthesizePrompt, buildClassifyPrompt, REVIEW_LENSES } from './demand-plan-prompts.ts'
import type { DemandOutcome } from './demand-finalize.ts'

const execFileAsync = promisify(execFile)
const ROOT = '/Users/user/aladdin'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
// plan.md 故意不寫在 worktrees/{ticket}/ 底下：runDemandPlanPipeline 的
// finally 區塊跑完會呼叫 cleanupWorktreesForTicket 整個刪掉那個目錄（見該
// 函式註解），若 plan.md 放在裡面，finalize() 稍後要上傳 Drive 時檔案早就
//被自己刪掉了——這是實作過程中發現的真實坑，不是預防性猜測，獨立一個目錄
// 存放，生命週期不跟 worktree 綁在一起。
const PLAN_DIR = '/Users/user/aladdin/telegram-dispatcher/demand-plans'
const MAIN_REPOS = ['agrabah', 'abu', 'lago', 'rajah'] as const

// 唯讀分析用的工具白名單：明確不含 Edit/Write/MultiEdit/NotebookEdit，這是
// CLI 層級的硬限制（不是靠 prompt 拜託），跟 T34/T36 gate 的 --tools ""
// 同一類防禦，差別是這裡的 agent 真的需要 Bash（跑 *-lookup skill 腳本、
// grep、唯讀 DB 查詢）跟 Read/Grep/Glob 才能做調查，不能整組清空。
// **已知殘留風險**（記錄不吞掉）：Bash 本身沒有更細的白名單，理論上 agent
// 仍可能透過 shell 指令（如 `echo > file`）繞過拿掉 Edit/Write 工具的保護，
// 這裡用兩層防禦處理：(1) prompt 明確指示唯讀、不要碰任何 repo 檔案 (2)
// runDemandPlanPipeline 結束後對 3 個「沒有拿到隔離 worktree」的主 repo
// 跑 git status --short 健檢，一旦有非預期變更立刻記進 log 並在結果裡標記
// 需要人工介入（見 checkMainReposUntouched）。
const READONLY_TOOLS = 'Bash,Read,Grep,Glob'
const AGENT_TIMEOUT_MS = 15 * 60 * 1000 // draft/review/synthesize 各自單輪對話（含多次工具呼叫），15 分鐘足夠，遠低於整條 pipeline 的外層 timeout
const CLASSIFY_TIMEOUT_MS = 60_000 // 零工具、純文字分類，比照 T34/T36 gate 的既有時間量級

function log(msg: string): void {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(join(LOG_DIR, 'demand-pipeline.log'), `${new Date().toISOString()} ${msg}\n`)
}

/**
 * 建立一個輕量、唯讀分析用的 git worktree——跟 setup-worktree.sh 的差別：
 * 不跑 bootstrap.sh（不含 code generation、不含 DB migrate、不 symlink
 * node_modules），純粹 `git worktree add`，因為這個 pipeline 不需要真的
 * 啟動任何服務，只需要一份跟 origin/main 一致、可以安全讀寫（其實只讀）的
 * 檔案系統起點。分支名故意跟 setup-worktree.sh 的 mr/{ticket} 不同（改用
 * plan/{ticket}），避免跟真的要拿去開 MR 的分支語意混在一起。
 *
 * 不在這裡呼叫 cleanupWorktreesForTicket——那個函式一次會清掉 MAIN_REPOS
 * 全部 4 個 repo 底下這個 ticket 的殘留 worktree，若跨 repo 需求在迴圈裡
 * 對每個 repo 各自呼叫一次這個函式，後面的呼叫會把前面 repo 剛建好的
 * worktree 也一併清掉；清理改成由呼叫端（createLightweightWorktrees）在
 * 迴圈開始前只做一次。
 */
async function createLightweightWorktree(ticket: string, repo: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const repoRoot = join(ROOT, repo)
  const wtPath = join(ROOT, 'worktrees', ticket, repo)
  const branch = `plan/${ticket}`

  try {
    // 分支可能是上一次執行留下的（cleanupWorktreesForTicket 只刪 worktree
    // 目錄，不刪分支）——先嘗試刪掉同名舊分支（分支沒有任何 worktree 綁定
    // 的情況下才刪得掉，刪不掉就順著往下用 -B 強制覆蓋，兩者其中一個必然
    // 成功，因為呼叫端已經先移除了唯一可能綁定這個分支的 worktree）。
    try {
      execFileSync('git', ['-C', repoRoot, 'branch', '-D', branch], { encoding: 'utf8', timeout: 10_000 })
    } catch {
      // 分支不存在是正常情況，忽略
    }
    mkdirSync(join(ROOT, 'worktrees', ticket), { recursive: true })
    // 2026-09-01：建 worktree 前先拉新 origin/main——這條 pipeline 不經過
    // fresh-pull.sh，本機 origin/main 的新鮮度只能靠這裡保證，否則 plan 會
    // 基於過期的程式碼分析。fetch 失敗直接視為建立失敗（回傳 reason）。
    await execFileAsync('git', ['-C', repoRoot, 'fetch', 'origin', 'main', '--quiet'], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', wtPath, '-B', branch, 'origin/main'], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { ok: true, path: wtPath }
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message ?? err).slice(0, 500) }
  }
}

/**
 * 2026-08-21 使用者定案新增：cross-repo 需求單也要能自動執行，不再卡在
 * repo-scope-gate。這個函式對 repo-scope-gate 判斷到的全部 repo 各自建立
 * 一個輕量 worktree，全部放在同一個 worktrees/{ticket}/ 目錄下（單一 repo
 * 的情況等同舊行為，只是清單長度是 1）。cleanupWorktreesForTicket 只在最
 * 前面呼叫一次（見 createLightweightWorktree 的註解，原因同上）；只要其中
 * 一個 repo 建立失敗就整批清掉、不留半套 worktree 讓後續步驟誤用不完整的
 * 起點。
 */
async function createLightweightWorktrees(ticket: string, repos: string[]): Promise<{ ok: true; paths: Record<string, string> } | { ok: false; reason: string }> {
  cleanupWorktreesForTicket(ticket)

  const paths: Record<string, string> = {}
  for (const repo of repos) {
    const result = await createLightweightWorktree(ticket, repo)
    if (!result.ok) {
      cleanupWorktreesForTicket(ticket)
      return { ok: false, reason: `${repo}: ${result.reason}` }
    }
    paths[repo] = result.path
  }
  return { ok: true, paths }
}

/** 唯讀自由文字 agent 呼叫（draft/review/synthesize 共用）：固定工具白名單＋bypassPermissions（headless 無人核准）＋清 CLAUDE_EFFORT。 */
async function runFreeformAgent(prompt: string, cwd: string, trace: { ticket: string; stage: string }): Promise<string> {
  const env = { ...process.env }
  delete env.CLAUDE_EFFORT

  const stdout = await execClaudeWithStdin(['-p', '--model', 'sonnet', '--tools', READONLY_TOOLS, '--permission-mode', 'bypassPermissions', '--output-format', 'json'], prompt, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    timeout: AGENT_TIMEOUT_MS,
    env,
    trace,
  })

  const events = JSON.parse(stdout)
  const resultEvent = Array.isArray(events) ? events.find((e: any) => e?.type === 'result') : null
  const text = typeof resultEvent?.result === 'string' ? resultEvent.result : ''
  if (!text) throw new Error(`agent 沒有回傳可用的 result 文字: ${stdout.slice(0, 500)}`)
  return text
}

/** 零工具、只回嚴格 JSON 的分類呼叫——比照 T34/T36 gate 既有模式，見 demand-plan-prompts.ts 檔頭註解。 */
async function classifyPlanResult(ticket: string, planContent: string): Promise<'success' | 'already-satisfied' | 'needs-clarification'> {
  const env = { ...process.env }
  delete env.CLAUDE_EFFORT
  const prompt = buildClassifyPrompt(ticket, planContent)

  const stdout = await execClaudeWithStdin(['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--output-format', 'json'], prompt, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: CLASSIFY_TIMEOUT_MS,
    env,
    trace: { ticket, stage: 'classify' },
  })

  const events = JSON.parse(stdout)
  const resultEvent = Array.isArray(events) ? events.find((e: any) => e?.type === 'result') : null
  if (!resultEvent || typeof resultEvent.result !== 'string') {
    throw new Error(`classify: claude -p 輸出找不到 type=result 事件: ${stdout.slice(0, 500)}`)
  }
  const raw = resultEvent.result.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`classify: 輸出不是合法 JSON: ${raw.slice(0, 500)}`)
  }
  const status = (parsed as any)?.status
  if (status !== 'success' && status !== 'already-satisfied' && status !== 'needs-clarification') {
    throw new Error(`classify: status 欄位不是合法值: ${raw.slice(0, 500)}`)
  }
  return status
}

/**
 * 防禦深度第二層（見 READONLY_TOOLS 註解）：agent 的 cwd 雖然是目標 repo
 * 的隔離 worktree，但那是完全獨立的目錄，不代表目標 repo 的「主 repo checkout」
 * 本身安全——Bash 沒有路徑限制，理論上仍可能被誘導 `cd` 回
 * `/Users/user/aladdin/{repo}` 寫入。四個主 repo（含目標 repo 自己的主
 * checkout）全部檢查，一個都不排除。髒了不嘗試自動處理（自動
 * revert/clean 對開發者正在進行中的工作是更危險的操作），只大聲記錄，讓
 * finalize 的『分析失敗』分支明確帶出這個訊號。
 *
 * 真實跑過 ALDREQ-746 才發現的真實 bug（不是預防性猜測，見 changelog）：
 * 第一版只檢查「跑完當下髒不髒」，結果 lago 裡本來就殘留兩份跟這個 pipeline
 * 完全無關的舊壓力測試暫存檔（`pk-gaming/_test_tmp_stress-likes_*.ts`，
 * mtime 是一週前），被誤判成「這次執行造成的變更」。改成 before/after 快照
 * 比對——只有這次執行前後 git status 字串真的變了，才算數，開發者既有的
 * 未 commit 工作不會被誤傷。
 */
function snapshotMainRepos(): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {}
  for (const repo of MAIN_REPOS) {
    try {
      snapshot[repo] = execFileSync('git', ['-C', join(ROOT, repo), 'status', '--short'], { encoding: 'utf8', timeout: 15_000 })
    } catch (err) {
      log(`安全健檢：git status 讀取 ${repo} 失敗（快照記為 null，不當作髒）: ${err}`)
      snapshot[repo] = null
    }
  }
  return snapshot
}

function diffMainReposSnapshot(before: Record<string, string | null>, after: Record<string, string | null>): string[] {
  const changed: string[] = []
  for (const repo of MAIN_REPOS) {
    // null 代表快照當下讀取失敗（見 snapshotMainRepos），任一邊是 null 就
    // 沒有可信的比較基準，不判定為髒（寧可漏報一次真的很倒楣的 race，也不
    // 要對『單純讀不到』這種情況大驚小怪）。
    if (before[repo] === null || after[repo] === null) continue
    if (before[repo] !== after[repo]) changed.push(repo)
  }
  return changed
}

/**
 * T36 第二次重新設計的主流程：draft ×2（平行）→ review ×3（平行，各自看
 * 兩份 draft）→ synthesize ×1 → 寫 plan.md → classify ×1（嚴格 JSON）。
 * 不管哪一步失敗都拋出例外，交給呼叫端（run-demand-pipeline.ts）分類成
 * implementer-error（技術性失敗），不在這裡吞掉細節。
 *
 * 2026-08-21 使用者定案：repo 參數改成陣列——跨 repo 需求單不再被
 * repo-scope-gate 擋下，一樣走這條 pipeline，只是目標 repo 從一個變多個，
 * 每個都各自一份輕量 worktree（見 createLightweightWorktrees）。所有 agent
 * 的 cwd 都指到這些 worktree 的共同父目錄（worktreeRoot），讓 draft/review
 * 都能跨目標 repo 讀取，不是只有 draft 才看得到其他 repo。
 */
export async function runDemandPlanPipeline(ticket: string, specText: string, comments: string[], repos: string[]): Promise<DemandOutcome> {
  const beforeSnapshot = snapshotMainRepos()

  const setup = await createLightweightWorktrees(ticket, repos)
  if (!setup.ok) {
    return { kind: 'setup-failed', reason: setup.reason }
  }
  const worktreeRoot = join(ROOT, 'worktrees', ticket)

  try {
    log(`${ticket} plan pipeline：draft 階段開始（2 個 agent 平行，目標 repo=${repos.join(', ')}）`)
    const draftTexts = await Promise.all(
      [0, 1].map(i => runFreeformAgent(buildDraftPrompt(ticket, specText, comments, repos, worktreeRoot), worktreeRoot, { ticket, stage: `draft-${String.fromCharCode(65 + i)}` })),
    )
    const drafts = draftTexts.map((text, i) => ({ label: `Draft ${String.fromCharCode(65 + i)}`, text }))
    log(`${ticket} plan pipeline：draft 階段完成`)

    log(`${ticket} plan pipeline：review 階段開始（3 個角度平行）`)
    const reviewTexts = await Promise.all(
      REVIEW_LENSES.map(({ lens }) => runFreeformAgent(buildReviewPrompt(lens, ticket, specText, drafts), worktreeRoot, { ticket, stage: `review-${lens}` })),
    )
    const reviews = REVIEW_LENSES.map(({ label }, i) => ({ label, text: reviewTexts[i]! }))
    log(`${ticket} plan pipeline：review 階段完成`)

    log(`${ticket} plan pipeline：synthesize 階段開始`)
    const planContent = await runFreeformAgent(buildSynthesizePrompt(ticket, specText, drafts, reviews), worktreeRoot, { ticket, stage: 'synthesize' })
    log(`${ticket} plan pipeline：synthesize 階段完成`)

    const planPath = join(PLAN_DIR, `${ticket}-plan.md`)
    mkdirSync(PLAN_DIR, { recursive: true })
    writeFileSync(planPath, planContent, 'utf8')

    const changedRepos = diffMainReposSnapshot(beforeSnapshot, snapshotMainRepos())
    if (changedRepos.length > 0) {
      log(`${ticket} plan pipeline：安全健檢發現這次執行期間主 repo 狀態改變（${changedRepos.join(', ')}），需要人工檢查`)
      return { kind: 'implementer-error', detail: `安全健檢發現這次執行期間，不應該被動到的主 repo 狀態改變了（${changedRepos.join(', ')}），請人工檢查 git status，不信任這次的 plan.md` }
    }

    const status = await classifyPlanResult(ticket, planContent)
    log(`${ticket} plan pipeline：分類結果=${status}`)
    return { kind: 'plan', status, planPath, summary: planContent.slice(0, 2000) }
  } finally {
    // 這個 pipeline 的交付物是 plan.md（已上傳 Drive），worktree 本身只是
    // 分析過程的暫存空間，跑完不管成功失敗都清掉，避免像舊版一樣留著佔
    // 空間、跟其他 ticket 混淆（比照 T28 對 Bug pipeline 的既有原則：清
    // worktree 目錄、保留分支）。
    cleanupWorktreesForTicket(ticket)
  }
}
