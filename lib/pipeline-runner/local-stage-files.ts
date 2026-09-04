// lib/pipeline-runner/local-stage-files.ts — worker 端「這張 bug 票的階段
// 產物檔存不存在＋mtime」原始資料（2026-09-04 新增，worker-agent.ts 的
// GET /jobs/:ticket/stage-files 用）。
//
// 背景：tg-monitor/lib/ingest.ts 的 computeBugStages() 靠 obsidian/Debug/
// {ticket}/{ticket}-*.md 與 worktrees/<ticket>/bootstrap.log 的 mtime 判斷
// 「這步做到哪」——worker 執行時這兩批檔案只落在 worker 本地檔案系統，head
// 直接掃本機路徑一律 pending（觀察 2026-09-04）。
//
// 這裡不把 computeBugStages 整段邏輯搬過來（那份組裝規則——review 三檔案
// 全到齊才算一輪、started_at 沿用前一階段 finished_at、reused 語意等——是
// tg-monitor 專屬的呈現邏輯，跟本檔「純讀檔案系統」的職責不同）：worker 只
// 負責回報「這幾個固定檔名存不存在＋mtime」的原始事實，由 head 端
// computeBugStages() 用同一份組裝規則、只是資料來源換成這裡回傳的值
// （見 tg-monitor/lib/ingest.ts computeBugStages 新增的 remoteFiles 參數）。
//
// 檔名清單**逐字比照** tg-monitor/lib/ingest.ts computeBugStages 目前讀取的
// 9 個檔名（reviewFiles 3 個 + 其餘 6 個）——改動任一邊都要同步，否則兩邊
// 的階段檢核表會不一致。

import { statSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_DIR = '/Users/user/aladdin/obsidian/Debug'
const WORKTREES_DIR = '/Users/user/aladdin/worktrees'

/** 逐字比照 tg-monitor/lib/ingest.ts computeBugStages 用到的檔名集合。 */
export const BUG_STAGE_DEBUG_FILES = [
  'analytics.md',
  'spec.md',
  'grounding.md',
  'analysis-notes.md',
  'reviewer-report.md',
  'adversarial-review.md',
  'tdd-fidelity-review.md',
  'final-adversarial-review.md',
  'solution.md',
] as const

function fileMtimeIso(p: string): string | null {
  try {
    return statSync(p).mtime.toISOString()
  } catch {
    return null
  }
}

export type LocalStageFiles = {
  debugFiles: Record<string, string | null>
  worktreeBootstrapLog: string | null
}

export function readLocalStageFiles(ticket: string): LocalStageFiles {
  const dir = join(DEBUG_DIR, ticket)
  const debugFiles: Record<string, string | null> = {}
  for (const f of BUG_STAGE_DEBUG_FILES) {
    debugFiles[f] = fileMtimeIso(join(dir, `${ticket}-${f}`))
  }
  return {
    debugFiles,
    worktreeBootstrapLog: fileMtimeIso(join(WORKTREES_DIR, ticket, 'bootstrap.log')),
  }
}
