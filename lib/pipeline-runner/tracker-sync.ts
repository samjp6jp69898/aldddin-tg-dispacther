import { execFileSync } from 'node:child_process'
import { getTicketNotionUrl } from '../notion-integration/candidate-tickets.ts'

const TRACKER_SH = '/Users/user/aladdin/scripts/tracker.sh'

/**
 * /create-mr 觸發前的純技術同步（見 tasks.json T7）：確保 tracker.md 有這張
 * 單、且狀態是 pending，滿足 /create-mr 既有 Step 0 的 tracker 存在性檢查
 * （該檢查是共用 create-mr.md 的既有邏輯，不能改也不該改）。
 *
 * dispatcher 自己完全不讀 tracker 狀態、不用它做任何認領判斷——唯一判準永遠
 * 是 T6 的 Notion 查詢。這裡失敗（拿不到 Notion URL 或 tracker.sh 本身出錯）
 * 不拋出：這只是滿足既有 pipeline 內部依賴的技術前提，不該讓認領本身的成功
 * 回覆卡住；失敗時 /create-mr Step 0 頂多 SKIPPED，屬已知風險（見 risk_notes）。
 */
export function ensureTrackerPending(ticket: string): void {
  const url = getTicketNotionUrl(ticket)
  if (!url) return

  try {
    execFileSync('bash', [TRACKER_SH, 'ensure-pending', ticket, url], { encoding: 'utf8' })
  } catch {
    // 同上：純技術同步失敗不阻斷認領流程。
  }
}
