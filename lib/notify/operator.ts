import { execFileSync } from 'node:child_process'

const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'
const EXEC_TIMEOUT_MS = 10_000

// 維運對象（Landon）的 Telegram chat_id，直接寫死、不透過 tech-users.csv
// 查——這是給「人」的維運告警，不是給某張 ticket 的技術指派（後者走
// email/notion_user_id 查表，見 candidate-tickets.ts／post-run-notify.ts
// 既有的 resolveAssigneeEmail）。原本只在 health-monitor.ts 內部定義，2026-
// 08-23 起集中成單一來源，讓 health-monitor.ts／post-run-notify.ts／
// stale-lock-reaper.ts 三處維運告警共用同一個值，不再各自各寫一份會漂移的
// 字面常數。沿用既有慣例，見 cron/bug-report-run.sh 同一套維運告警慣例。
export const OPERATOR_CHAT_ID = '5022865804'

/**
 * best-effort 通知維運者（Landon）。任何失敗（tg-notify.sh 逾時/非零 exit）
 * 都不拋例外，回傳 false 讓呼叫端自行決定要不要記 log——通知本來就不該
 * 阻斷任何正在進行的收尾/回收流程。
 */
export function notifyOperator(text: string): boolean {
  try {
    execFileSync('bash', [TG_NOTIFY_SH, '--chat-id', OPERATOR_CHAT_ID, '--text', text], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
