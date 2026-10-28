/**
 * changelog-group-allowlist-query.ts — isChangelogGroupChat 的查詢本體（拿到 executor 之後的一切）。
 *
 * 跟 changelog-group-allowlist.ts 拆開，是因為路由測試（changelog-bot-routing.test.ts）會
 * mock.module 掉 changelog-group-allowlist.ts，而 bun 的 mock.module 是整個測試行程共用——
 * 查詢邏輯放在沒被 mock 的這支，全量 `bun test` 時它的測試才不會拿到 mock 版。
 */
import type { Pool } from 'mysql2/promise'

/** 只用到 mysql2 Pool 的 query（帶 timeout 選項），測試以假物件注入。 */
export type AllowlistQueryExecutor = Pick<Pool, 'query'>

/** 單次查詢逾時：群組觸發不該因為 DB 卡住而讓 handler 一直掛著。 */
export const QUERY_TIMEOUT_MS = 1000

/** 群組 chat_id 一律是負數（supergroup 形如 -100xxxxxxxxxx）。 */
const GROUP_CHAT_ID_RE = /^-\d{1,20}$/

/**
 * 查 changelog_allowed_groups 是否有這個群組且啟用中。任何失敗（取不到 executor、
 * DB 斷線、逾時）一律回 false 並記 log，不往外拋。
 */
export async function queryChangelogGroupAllowed(getExecutor: () => Promise<AllowlistQueryExecutor>, chatId: string): Promise<boolean> {
  if (!GROUP_CHAT_ID_RE.test(chatId)) return false
  try {
    const db = await getExecutor()
    const [rows] = await db.query(
      { sql: 'SELECT 1 FROM changelog_allowed_groups WHERE chat_id = ? AND enabled = 1 LIMIT 1', timeout: QUERY_TIMEOUT_MS },
      [chatId],
    )
    return Array.isArray(rows) && rows.length > 0
  } catch (err) {
    console.error(`changelog: 查詢允許群組失敗，視同不允許（chat_id=${chatId}）：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
