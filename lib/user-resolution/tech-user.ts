import { blindIndex } from '../crypto/field-crypto.ts'
import { getLongLivedMonitorPool } from '../monitor-db/runtime.ts'

// 必須與 lib/registry/tech-users-sync.ts、deploy/monitor-db/backfill/backfill-rosters.ts
// 的同名常數逐字相同（HKDF info，改動會讓既有密文的等值查詢失效）。刻意在此
// 重新宣告而不 cross-import（同一份「不耦合到別的模組所有權」慣例，見
// tech-users-sync.ts 檔頭關於 backfill-rosters.ts 的說明）。
const TECH_USER_BIDX_SCOPE = 'tech_users.tg_chat_id'

export type TechUser = {
  notion_user_id: string
  notion_user_name: string
  email: string
}

type TechUserDbRow = { email: string; notion_user_name: string; notion_user_id: string }

function toTechUser(row: TechUserDbRow): TechUser {
  return {
    notion_user_id: row.notion_user_id ?? '',
    notion_user_name: row.notion_user_name ?? '',
    email: row.email ?? '',
  }
}

/**
 * 兩支查詢共用的 fail-closed 外殼。
 *
 * 池建立失敗與查詢本身失敗（連線中途斷線、逾時等）是兩種不同的故障模式，但
 * 對白名單來說都算「DB 不可用」，必須同樣 fail closed 回 null——不包
 * try/catch 的話例外會一路丟出去，穿過 whitelist.ts 自己 try/catch 範圍之外
 * 的呼叫點，最後變成整個 webhook request 500（而不是優雅地判定為找不到）。
 */
async function queryTechUser(label: string, sql: string, params: unknown[]): Promise<TechUser | null> {
  const executor = await getLongLivedMonitorPool()
  if (!executor) {
    console.error(`${label}: monitor DB 不可用，本次名冊查詢視為找不到（fail closed）`)
    return null
  }
  try {
    const [rows] = await executor.execute<TechUserDbRow[]>(sql, params)
    const row = (rows as TechUserDbRow[])[0]
    return row ? toTechUser(row) : null
  } catch (err) {
    console.error(`${label}: 查詢失敗，本次名冊查詢視為找不到（fail closed）: ${err}`)
    return null
  }
}

/**
 * 輸入 Telegram chat_id，反查授權技術人員。
 *
 * 查 `tech_users` 表的 `tg_chat_id_bidx` 盲索引比對——不需要解密，bot 收到的
 * chat_id 本來就是明碼，算一次 `blindIndex()` 拿去跟 DB 存的雜湊比對即可，
 * 明碼完全不需要離開這個函式。DB 不可用時視為找不到（fail closed，符合白
 * 名單既有「找不到就擋」語意）。
 *
 * 2026-09-15 一度誤判 bidx 資料本身有舊金鑰不一致的問題而整個回退成讀 CSV
 * （事後查證是驗證腳本自己拿 MySQL `HEX()` 的大寫輸出去跟 Node
 * `Buffer.toString('hex')` 的小寫輸出直接字串比較，忽略大小寫造成的誤判，
 * 不是真的資料問題）——`lib/registry/tech-users-sync.ts` 的
 * `runRepairBidx()` 對全部既有連接列重算比對過，結果 0 筆需要修正，確認
 * 這條查詢路徑本來就是對的。
 */
export async function resolveTechUserByChatId(chatId: string): Promise<TechUser | null> {
  if (!chatId) return null

  const bidx = blindIndex(TECH_USER_BIDX_SCOPE, chatId)
  if (!bidx) return null

  return queryTechUser(
    'resolveTechUserByChatId',
    'SELECT email, notion_user_name, notion_user_id FROM tech_users WHERE tg_chat_id_bidx = ? LIMIT 1',
    [bidx],
  )
}

/**
 * 輸入 email，反查名冊。給 spawn-create-mr.ts CLI 的 `--triggered-by-email`
 * 與 cluster-head 的派工 API 用：非 Telegram 觸發的重跑也能把「發起人」回填
 * 成原認領人。找不到回傳 null，不丟例外。
 *
 * 2026-09-16（Phase 6：tech-users.csv 退役）：改查 `tech_users` 表。原本讀
 * CSV 的實作連同整份 CSV 一起刪除——名冊只剩 DB 一個來源，不再有「旗標關就
 * 退回讀檔」的第二條路（`MON_DB_ENABLED` 對名冊查詢已無意義，見
 * tech-users-sync.ts 檔頭）。
 *
 * 大小寫不敏感沿用自 CSV 版本的行為：`tech_users.email` 的 collation 是
 * utf8mb4_0900_ai_ci，等值比較本來就忽略大小寫，不需要也不該包 LOWER()
 * （那會讓主鍵索引用不上）。
 */
export async function resolveTechUserByEmail(email: string): Promise<TechUser | null> {
  const needle = email.trim()
  if (needle === '') return null

  return queryTechUser(
    'resolveTechUserByEmail',
    'SELECT email, notion_user_name, notion_user_id FROM tech_users WHERE email = ? LIMIT 1',
    [needle],
  )
}
