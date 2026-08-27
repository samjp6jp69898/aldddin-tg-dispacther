import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 給「再次點擊已在跑的票」分支（claim.ts／demand-claim.ts）與 /status 指令
// 共用：查某張票目前是否有背景 pipeline 在跑、跑到哪個 stage。純讀取，不碰
// 任何鎖或狀態。

const DEFAULT_LOCK_DIR = '/tmp/bug-analysis-locks'
const DEFAULT_DEBUG_DIR = '/Users/user/aladdin/obsidian/Debug'
const DEFAULT_WORKTREE_DIR = '/Users/user/aladdin/worktrees'
const DEFAULT_DEMAND_LOG = '/Users/user/aladdin/telegram-dispatcher/logs/demand-pipeline.log'
const DEFAULT_PLAN_DIR = '/Users/user/aladdin/telegram-dispatcher/demand-plans'

export type ProgressOpts = {
  now?: number
  lockDir?: string
  debugDir?: string
  worktreeDir?: string
  demandLogPath?: string
  planDir?: string
}

/**
 * 查 /tmp/bug-analysis-locks/{ticket} 鎖目錄是否存在。Bug 票由 /create-mr
 * 自己的 Step 0.1.3、需求單由 run-demand-pipeline.ts 的 main()（見該檔案
 * claimLock/releaseLock 與檔頭註解）都在真正開始跑 pipeline 前重新拿一次
 * 鎖、跑完才在 finally 釋放——鎖存在＝背景流程正在跑，不只是 claim.ts／
 * demand-claim.ts 那一瞬間的 race 防護訊號。直接查目錄存在（比照
 * stale-lock-reaper.ts 的既有手法），不 shell out 到 bug-lock.sh。
 */
export function isTicketLocked(ticket: string, opts: Pick<ProgressOpts, 'lockDir'> = {}): boolean {
  return existsSync(join(opts.lockDir ?? DEFAULT_LOCK_DIR, ticket))
}

function minutesSince(mtimeMs: number, now: number): number {
  return Math.floor((now - mtimeMs) / 60_000)
}

const BUG_STAGE_FILES: { key: string; label: string }[] = [
  { key: 'analytics', label: 'Step1 analyst' },
  { key: 'spec', label: 'Step2 spec' },
  { key: 'grounding', label: 'Step2.5 grounding' },
  { key: 'analysis-notes', label: 'Step3 tracer' },
  { key: 'solution', label: 'Step6 之後（solution 彙整）' },
]

// 比照 pipeline-status.sh 的既有 case 表：最後完成的 stage → 下一步名稱＋
// 正常時長。
const BUG_NEXT_STEP: Record<string, string> = {
  'Step1 analyst': 'Step2 spec（數分鐘）',
  'Step2 spec': 'Step2.5 grounding（5–15 分鐘）',
  'Step2.5 grounding': 'Step3 tracer（opus 重型，正常 15–40 分鐘）',
  'Step3 tracer': 'Step4 worktree ＋ Step5 fixer（正常 10–30 分鐘）',
}

/**
 * 比照 scripts/pipeline-status.sh 的 stage 推論邏輯（Debug/{ticket}/*.md
 * 產物 mtime），改寫成 TS 直接供 TG bot 呼叫，不 shell out 跑一支互動用的
 * 唯讀 CLI 腳本。兩邊的判斷依據刻意保持一致：任何一邊改了 stage 定義都要
 * 記得同步另一邊。
 */
function describeBugProgress(ticket: string, now: number, debugDir: string, worktreeDir: string): string {
  const dir = join(debugDir, ticket)
  if (!existsSync(dir)) {
    return `${ticket} 正在執行中：Debug 目錄尚未建立（Step1 analyst 進行中或剛開始）。`
  }

  const doneLabels: string[] = []
  let latestLabel: string | null = null
  let latestMs = 0
  for (const { key, label } of BUG_STAGE_FILES) {
    const f = join(dir, `${ticket}-${key}.md`)
    if (!existsSync(f)) continue
    doneLabels.push(label)
    latestLabel = label
    latestMs = statSync(f).mtimeMs
  }
  const reviewerFile = readdirSync(dir).find(name => name.toLowerCase().includes('reviewer'))
  if (reviewerFile) {
    doneLabels.push('Step6 reviewer')
    latestLabel = 'Step6 reviewer'
    latestMs = statSync(join(dir, reviewerFile)).mtimeMs
  }

  const lines = [`${ticket} 正在執行中：${doneLabels.length > 0 ? doneLabels.join(' → ') : '(尚無產物)'}`]
  if (latestLabel && latestMs > 0) {
    const elapsed = minutesSince(latestMs, now)
    lines.push(`▶ 目前：${BUG_NEXT_STEP[latestLabel] ?? '下一步'} — 自上個產物起已 ${elapsed} 分鐘`)
    if (elapsed > 45) lines.push('⚠ 超過 45 分鐘無新產物，若對應視窗也無輸出才需要懷疑真的卡住')
  }
  lines.push(existsSync(join(worktreeDir, ticket)) ? 'worktree：已建立 → 已進 Step4+' : 'worktree：未建立（tracer 完成後才會建）')
  return lines.join('\n')
}

/**
 * 需求單沒有 Debug/*.md 產物軌跡（demand-plan-pipeline.ts 完全是另一套機
 * 制），改抓 demand-pipeline.log 裡這張單最後一行——見
 * demand-plan-pipeline.ts／run-demand-pipeline.ts 的 log() 呼叫，每個階段
 * 開始/完成都會各寫一行。
 */
function describeDemandProgress(ticket: string, now: number, demandLogPath: string, planDir: string): string {
  if (!existsSync(demandLogPath)) {
    return `${ticket} 正在執行中，但查無 demand-pipeline.log。`
  }
  const matched = readFileSync(demandLogPath, 'utf8')
    .split('\n')
    .filter(line => line.includes(`${ticket} `))
  if (matched.length === 0) {
    return `${ticket} 正在執行中，但 demand-pipeline.log 尚無這張單的紀錄。`
  }

  const last = matched[matched.length - 1]!
  const tsMatch = /^(\S+)\s(.*)$/.exec(last)
  const lines = [`${ticket} 正在執行中：${tsMatch ? tsMatch[2] : last}`]
  if (tsMatch) {
    const ms = Date.parse(tsMatch[1]!)
    if (!Number.isNaN(ms)) lines.push(`距上次進度更新 ${minutesSince(ms, now)} 分鐘`)
  }
  if (existsSync(join(planDir, `${ticket}-plan.md`))) {
    lines.push('plan.md 已產出，正在收尾（上傳 Drive／Notion／通知）')
  }
  return lines.join(' — ')
}

/**
 * 供 claim.ts／demand-claim.ts「再次點擊已在跑的票」分支、以及 /status 指
 * 令共用：依 ticket 前綴（FAQ- / ALDREQ-）分派到對應的 stage 還原邏輯。呼
 * 叫前應先用 isTicketLocked 確認鎖存在，這裡不重複檢查。
 */
export function describeTicketProgress(ticket: string, opts: ProgressOpts = {}): string {
  const now = opts.now ?? Date.now()
  if (ticket.startsWith('ALDREQ-')) {
    return describeDemandProgress(ticket, now, opts.demandLogPath ?? DEFAULT_DEMAND_LOG, opts.planDir ?? DEFAULT_PLAN_DIR)
  }
  return describeBugProgress(ticket, now, opts.debugDir ?? DEFAULT_DEBUG_DIR, opts.worktreeDir ?? DEFAULT_WORKTREE_DIR)
}
