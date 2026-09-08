// lib/pipeline-runner/bug-mode.ts — Bug pipeline 的執行模式（2026-09-08，
// pipeline-modes-project-docs/plan-pipeline-modes-v1.md §2.2）。
//
// 模式決定 /create-mr 在 Step 2c 根因判定之後往哪走：
//   full      ：一鍵——分析 → 修復 → 三審 → MR（既有行為）
//   analysis  ：只做到根因分析報告就停（新出口 analysis_done）
//   fix       ：產出修復程式碼並開 MR——有既有分析產物就接續（帶新留言重跑根因），沒有就等同 full
//   reanalyze ：依補充留言重新分析，仍停在 analysis_done
//
// 值域**封閉**：這個字串會進到 `claude -p` 的 prompt 位置參數與 ps 命令列掃描
// 契約（spawn-create-mr.ts WRAPPER_SCRIPT 的 $3），任何來自網路/argv 的值都要
// 先過 isBugMode() 才准使用，比照既有 `resume` 字面值的注入防護。
// 與 `resume` 正交：resume 只影響 Step 0.2 的續跑起點，mode 影響 2c 之後的走向。

export const BUG_MODES = ['full', 'analysis', 'fix', 'reanalyze'] as const
export type BugMode = (typeof BUG_MODES)[number]
export const DEFAULT_BUG_MODE: BugMode = 'full'

export function isBugMode(v: unknown): v is BugMode {
  return typeof v === 'string' && (BUG_MODES as readonly string[]).includes(v)
}

/** 從環境變數/未知來源取模式：不合法一律退回 full（不丟例外——呼叫端多半是
 * best-effort 的 retry 鏈，見 spawn-create-mr.ts submitCreateMr）。 */
export function coerceBugMode(v: unknown): BugMode {
  return isBugMode(v) ? v : DEFAULT_BUG_MODE
}

/** TG 按鈕/回覆用的短標籤（完整的 Notion 值見 candidate-tickets.ts）。 */
export const BUG_MODE_LABEL: Readonly<Record<BugMode, string>> = Object.freeze({
  full: '一鍵分析＋修復＋開 MR',
  analysis: '只做問題分析',
  fix: '產出修復程式碼並開 MR',
  reanalyze: '依補充留言重新分析',
})
