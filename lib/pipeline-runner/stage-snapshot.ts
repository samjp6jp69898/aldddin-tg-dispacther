// lib/pipeline-runner/stage-snapshot.ts — run 結束時把「這張票各 stage 做到哪、
// 產物在這台機器上」確定性寫進監控 DB 的 `ticket_stages`（migration 005）。
//
// 依據：pipeline-modes-project-docs/plan-pipeline-modes-v1.md §3
// 「由執行機在 run 結束時**確定性**寫入（不靠 manager LLM 記得呼叫）」。
// 呼叫點是 spawn-create-mr.ts 的 spawnCreateMrNow → onExit（見該處註解），
// head 本機 run 與 worker run 走同一條路徑、同一份規則。
//
// ── 判定規則與 scripts/resume-inventory.sh 同款（刻意重述，不是重新發明）──
// resume-inventory.sh 是 /create-mr Step 0.2 續跑盤點的權威定義；本檔算的是
// 同一批事實的另一種表達（把「盤點結果」寫進 DB，讓別台機器也看得到）：
//   - 產物檔存在（非空）→ 該 stage done，`finished_at` 取檔案 mtime；
//   - 三份 review 報告：全部 PASSED → review done；任一 FAILED → review failed；
//     不齊 → 不寫列（「查無此列」＝沒審完，與 resume-inventory 的 missing 同義）；
//   - `mr/<ticket>` 分支領先 origin/<base> 的 commit 數 > 0 → worktree/fixer done
//     （分支上的 commit 是「fixer 是否完成過」唯一可靠的旁證，同 resume-inventory）；
//   - `exit` 只有呼叫端傳了 run outcome 才寫（onExit 當下還不知道分類結果——
//     那是 EXIT trap 裡 post-run-notify.ts 的職責——所以正常路徑不寫這一列）。
// 沒有證據的 stage **不寫列**：DB 裡「查無此列」就是「沒做到」，不需要
// pending 狀態。唯一的例外是 `skipped`：analysis / reanalyze 模式結構上不會跑
// Step 4~6.5，那四個 stage 明確標成 skipped，讓讀取端能分辨「這個模式本來就
// 不做」與「跑到一半死了」。
//
// 非阻斷（plan-db-as-truth-v3.2 §6.7）：全程 dispatchMonitorWrite（1 秒預算、
// 逾時或失敗落 spool），`isMonitorDbEnabled()` 關閉時整支 no-op（§9.0(B)：
// flag 關閉零行為變化）。任何例外都在本檔內吞掉——run 已經結束，觀察面的寫入
// 不得反過來影響 pipeline。
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { dispatchMonitorWrite } from '../monitor-db/runtime.ts'
import type { TicketStage, TicketStageStatus } from '../monitor-db/types.ts'
import { upsertTicketStage } from '../monitor-db/writes.ts'
import { readLocalStageFiles, type LocalStageFiles } from './local-stage-files.ts'

const execFileAsync = promisify(execFile)

const ROOT = '/Users/user/aladdin'
const DEBUG_DIR = join(ROOT, 'obsidian/Debug')
/** 與 scripts/resume-inventory.sh 逐字相同的 repo 清單與順序。 */
export const BRANCH_REPOS = ['agrabah', 'abu', 'lago', 'rajah'] as const
const GIT_TIMEOUT_MS = 10_000

/** 單份 reviewer 報告的結論，語意同 resume-inventory.sh 的 `verdict()`。 */
export type ReviewVerdict = 'PASSED' | 'FAILED' | 'missing'

/** 三份 review 報告的結論（鍵＝local-stage-files.ts 的檔名，避免兩邊各取一套別名）。 */
export interface ReviewVerdicts {
  'reviewer-report.md': ReviewVerdict
  'adversarial-review.md': ReviewVerdict
  'tdd-fidelity-review.md': ReviewVerdict
}

export const REVIEW_FILES = ['reviewer-report.md', 'adversarial-review.md', 'tdd-fidelity-review.md'] as const

export interface StageRow {
  stage: TicketStage
  status: TicketStageStatus
  /** 絕對 ISO 字串（§6.5(a) 硬規則：呼叫端一律傳絕對時間）。 */
  finishedAt: string
}

export interface ComputeStageSnapshotOpts {
  /** 執行模式；analysis / reanalyze 會讓 Step 4~6.5 四個 stage 標成 skipped。 */
  mode: string
  /** 這次快照的時刻（無檔可依的 stage 用它當 finished_at）。 */
  now: string
  /** run 的分類結果；有值才寫 `exit` 這一列。 */
  outcome?: string | null
}

/** 只用檔名對應的單檔 stage（review / worktree / fixer / exit 另有規則）。 */
const FILE_STAGES: ReadonlyArray<[TicketStage, string]> = [
  ['analytics', 'analytics.md'],
  ['spec', 'spec.md'],
  ['grounding', 'grounding.md'],
  ['analysis-notes', 'analysis-notes.md'],
  ['final-review', 'final-adversarial-review.md'],
  ['solution', 'solution.md'],
]

/** analysis / reanalyze 模式結構上不會跑到的四個 stage（plan §1 的模式行為定義）。 */
const SKIPPED_IN_ANALYSIS_MODE: readonly TicketStage[] = ['worktree', 'fixer', 'review', 'final-review']

/** run outcome → `exit` 這一列的 status。未知值一律當 done（run 有走到出口）。 */
const FAILED_OUTCOMES = new Set(['failed', 'timeout', 'spawn_error', 'cli_failure', 'infra_failure', 'unknown_failure'])
const SKIPPED_OUTCOMES = new Set(['cancelled', 'skipped', 'skipped_locked', 'skipped_expired'])

function outcomeToStatus(outcome: string): TicketStageStatus {
  if (FAILED_OUTCOMES.has(outcome)) return 'failed'
  if (SKIPPED_OUTCOMES.has(outcome)) return 'skipped'
  return 'done'
}

/**
 * 純函式：把三類既有事實（產物檔 mtime、三份 review 結論、各 repo 分支 commit 數）
 * 算成要寫進 `ticket_stages` 的列。沒有任何 I/O，測試直接餵資料。
 */
export function computeStageSnapshot(
  files: LocalStageFiles,
  verdicts: ReviewVerdicts,
  branchCommits: Record<string, number>,
  opts: ComputeStageSnapshotOpts,
): StageRow[] {
  const rows: StageRow[] = []
  const analysisOnly = opts.mode === 'analysis' || opts.mode === 'reanalyze'

  for (const [stage, file] of FILE_STAGES) {
    const mtime = files.debugFiles[file] ?? null
    if (mtime) rows.push({ stage, status: 'done', finishedAt: mtime })
  }

  // review：三份齊全才算一輪（同 tg-monitor computeBugStages 的組裝規則）；
  // 任一 FAILED → failed（這一輪被打回），全 PASSED → done。
  const reviewMtimes = REVIEW_FILES.map(f => files.debugFiles[f] ?? null)
  const values = REVIEW_FILES.map(f => verdicts[f])
  if (values.some(v => v === 'FAILED')) {
    rows.push({ stage: 'review', status: 'failed', finishedAt: latestOr(reviewMtimes, opts.now) })
  } else if (values.every(v => v === 'PASSED')) {
    rows.push({ stage: 'review', status: 'done', finishedAt: latestOr(reviewMtimes, opts.now) })
  }

  // worktree / fixer：`mr/<ticket>` 分支上有領先基準分支的 commit ＝ 環境建過、
  // fixer 也 commit 過（同 resume-inventory.sh 的 HAS_COMMITS 判定）。沒有檔案
  // 可取 mtime，用這次快照的時刻。
  if (Object.values(branchCommits).some(n => n > 0)) {
    rows.push({ stage: 'worktree', status: 'done', finishedAt: opts.now })
    rows.push({ stage: 'fixer', status: 'done', finishedAt: opts.now })
  }

  if (analysisOnly) {
    const written = new Set(rows.map(r => r.stage))
    for (const stage of SKIPPED_IN_ANALYSIS_MODE) {
      if (!written.has(stage)) rows.push({ stage, status: 'skipped', finishedAt: opts.now })
    }
  }

  if (opts.outcome) {
    rows.push({ stage: 'exit', status: outcomeToStatus(opts.outcome), finishedAt: opts.now })
  }

  return rows
}

function latestOr(values: Array<string | null>, fallback: string): string {
  const present = values.filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (present.length === 0) return fallback
  return present.reduce((a, b) => (a >= b ? a : b))
}

/**
 * 讀三份 reviewer 報告檔尾最後一個行首 `REVIEW_RESULT:`（reviewer 定義檔規定的
 * 固定契約行）。檔案缺、讀不到、或值不在 {PASSED, FAILED} → missing，語意與
 * resume-inventory.sh 的 `verdict()` 逐條相同。
 */
export function readReviewVerdicts(ticket: string, dir: string = DEBUG_DIR): ReviewVerdicts {
  const out = {} as ReviewVerdicts
  for (const f of REVIEW_FILES) {
    out[f] = readVerdictFile(join(dir, ticket, `${ticket}-${f}`))
  }
  return out
}

function readVerdictFile(path: string): ReviewVerdict {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return 'missing'
  }
  let verdict: ReviewVerdict = 'missing'
  for (const line of text.split('\n')) {
    const m = /^REVIEW_RESULT:\s*(\S+)/.exec(line)
    if (!m) continue
    verdict = m[1] === 'PASSED' || m[1] === 'FAILED' ? m[1] : 'missing'
  }
  return verdict
}

/**
 * 各主 repo `mr/<ticket>` 分支領先 `origin/<base>` 的 commit 數。分支不存在、
 * repo 不存在、git 失敗一律算 0（同 resume-inventory.sh：`|| echo 0`）。
 */
export async function readBranchCommits(ticket: string, base = 'main', root = ROOT): Promise<Record<string, number>> {
  const entries = await Promise.all(
    BRANCH_REPOS.map(async repo => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', join(root, repo), 'rev-list', '--count', `origin/${base}..mr/${ticket}`], {
          encoding: 'utf8',
          timeout: GIT_TIMEOUT_MS,
        })
        const n = Number.parseInt(stdout.trim(), 10)
        return [repo, Number.isFinite(n) ? n : 0] as const
      } catch {
        return [repo, 0] as const
      }
    }),
  )
  return Object.fromEntries(entries)
}

export interface SnapshotTicketStagesOpts {
  runId: string
  mode: string
  /** worktree/fixer 判定用的基準分支（同 resume-inventory.sh 的第二參數）。 */
  baseBranch?: string
  /** 有值才寫 `exit` 那一列；正常的 onExit 路徑不知道分類結果，不傳。 */
  outcome?: string | null
}

/**
 * run 結束時的 stage 快照：讀本機三類事實 → computeStageSnapshot → 對每一列
 * `dispatchMonitorWrite('upsertTicketStage', …)`。
 *
 * `host` 不是參數：`ticket_stages.host` 一律由 writes.ts 取 env.ts 的 MON_HOST
 * （【G:MJ-E1】呼叫端不得宣稱自己是誰），呼叫端傳進來的 host 只會製造「值與
 * 實際寫入者不一致」的機會。
 *
 * 全程非阻斷：回傳的 Promise 只是為了讓測試能確定性地等它跑完，production
 * 呼叫點不接住它（同 dispatchMonitorWrite 的慣例）。
 */
export async function snapshotTicketStages(ticket: string, opts: SnapshotTicketStagesOpts): Promise<void> {
  try {
    const now = new Date().toISOString()
    const files = readLocalStageFiles(ticket)
    const verdicts = readReviewVerdicts(ticket)
    const branchCommits = await readBranchCommits(ticket, opts.baseBranch ?? 'main')
    const rows = computeStageSnapshot(files, verdicts, branchCommits, { mode: opts.mode, now, outcome: opts.outcome })
    await Promise.all(
      rows.map(row => {
        const input = { ticket, stage: row.stage, status: row.status, finishedAt: row.finishedAt, runId: opts.runId, mode: opts.mode }
        return dispatchMonitorWrite('upsertTicketStage', input, pool => upsertTicketStage(pool, input))
      }),
    )
  } catch (err) {
    // run 已經結束，觀察面的寫入不得反過來影響任何東西（§6.7 非阻斷）。
    console.error(`stage-snapshot: ${ticket} 快照失敗（不影響 pipeline）: ${err}`)
  }
}
