import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// worker 端「這張單／這台機器目前有沒有 pipeline 活動」的真相來源。
//
// 對抗性 review（2026-08-31 C-1）發現的根本問題：worker-agent 若只看自己
// in-memory queue，會對「不是它 spawn 的 run」完全失明——post-run-notify 的
// timeout 自動重試（在 EXIT trap 的一次性 CLI 子行程裡 submitCreateMr）、
// stale-lock-reaper 的回收重跑、人工終端/批次觸發，全都不在 queue 裡。
// 失明的後果是三連鎖：/capacity 少算（超賣）、POST /jobs 誤接單（新 run 的
// EXIT trap 會 release 掉存活 run 的鎖並清它的 worktree——repo 反覆記載的
// 災難模式）、job-done 誤回報（head 清登記，單子回到可認領池 → 兩台雙跑）。
//
// 修法：活動判定改成三個來源的**聯集**，任一來源看得到就算活著：
//   1. in-memory queue 的 running 集合（涵蓋「剛 spawn、wrapper 還沒進 ps /
//      鎖還沒拿」的最早期，以及 ps 掃描失敗時的退路）
//   2. /tmp/bug-analysis-locks 鎖目錄（涵蓋所有已跑到拿鎖的 run，不分來源；
//      注意 kill -9 後的殘鎖最長要等 stale-lock-reaper 130 分鐘回收，這段
//      期間 capacity 偏保守——寧可少接單，不可超賣）
//   3. ps 掃 pipeline wrapper 行程（涵蓋 out-of-band spawn 後、拿鎖前的
//      冷啟動視窗 1–3 分鐘——比照 post-run-notify.ts parseRunningBugTickets
//      的既有手法與行程指紋）
//
// 純函式 + 依賴注入，方便測試；production 接線在 worker-agent.ts。

const DEFAULT_LOCK_DIR = '/tmp/bug-analysis-locks'
const PS_TIMEOUT_MS = 10_000

// 行程指紋比照既有掃描（post-run-notify.ts 的 RUN_CREATE_MR_PROC_RE 與
// tg-monitor ingest 的同款契約）：wrapper 一律是
//   bash -c <script> run-create-mr <ticket> <stdoutPath> [resume]
//   bash -c <script> run-demand-pipeline <ticket> <assigneeEmail>
// script 本文內出現的 run-demand-pipeline.ts 後面接 `.`，不會誤中 `\s+` 的
// 位置參數樣式。
const BUG_PROC_RE = /\brun-create-mr\s+(FAQ-\d+)\s+\S+/
const DEMAND_PROC_RE = /\brun-demand-pipeline\s+(ALDREQ-\d+)\s+\S+/

/** 從 `ps -axo pid=,command=` 輸出解析出目前有 wrapper 行程在跑的 ticket。 */
export function parsePipelineWrapperTickets(psOutput: string): string[] {
  const tickets: string[] = []
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[2]!
    if (!cmd.startsWith('bash -c ')) continue
    const bug = BUG_PROC_RE.exec(cmd)
    if (bug) {
      tickets.push(bug[1]!)
      continue
    }
    const demand = DEMAND_PROC_RE.exec(cmd)
    if (demand) tickets.push(demand[1]!)
  }
  return tickets
}

export type LocalActivity = {
  /** 該 kind 目前活動中的 ticket 聯集（queue running ∪ 鎖目錄 ∪ ps wrapper）。 */
  activeTickets: (kind: 'bug' | 'demand') => Set<string>
  /** 單張票是否有任何本機活動（依前綴自動判 kind）。 */
  isActive: (ticket: string) => boolean
}

export function createLocalActivity(deps: {
  queueRunning: { bug: () => string[]; demand: () => string[] }
  lockDir?: string
  /** 測試注入用：回傳 ps 輸出字串；失敗丟例外（實作會當成「掃不到」退回
   * 其他兩個來源，不讓 ps 故障癱瘓接單）。 */
  psOutput?: () => string
}): LocalActivity {
  const lockDir = deps.lockDir ?? DEFAULT_LOCK_DIR
  const psOutput =
    deps.psOutput ?? (() => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }))

  function lockTickets(): string[] {
    try {
      if (!existsSync(lockDir)) return []
      return readdirSync(lockDir).filter(name => /^(FAQ|ALDREQ)-\d+$/.test(name) && existsSync(join(lockDir, name)))
    } catch {
      return []
    }
  }

  function psTickets(): string[] {
    try {
      return parsePipelineWrapperTickets(psOutput())
    } catch {
      return []
    }
  }

  function allActive(): Set<string> {
    return new Set([...deps.queueRunning.bug(), ...deps.queueRunning.demand(), ...lockTickets(), ...psTickets()])
  }

  return {
    activeTickets(kind) {
      const prefix = kind === 'bug' ? 'FAQ-' : 'ALDREQ-'
      return new Set([...allActive()].filter(t => t.startsWith(prefix)))
    },
    isActive(ticket) {
      return allActive().has(ticket)
    },
  }
}
