import { readFileSync } from 'node:fs'

const TECH_USERS_CSV = '/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv'

export type TechUser = {
  notion_user_id: string
  notion_user_name: string
  email: string
}

// 用 header 對應欄位名，不假設欄位順序固定死（tech-users.csv 目前欄位順序是
// notion_user_name,notion_user_id,email,pushed_repos,tg_chat_id，但不依賴這個順序）。
function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return []
  const header = lines[0]!.split(',').map(h => h.trim())
  return lines.slice(1).map(line => {
    const cols = line.split(',')
    const row: Record<string, string> = {}
    header.forEach((key, i) => {
      row[key] = (cols[i] ?? '').trim()
    })
    return row
  })
}

let cache: Record<string, string>[] | null = null

function loadRows(): Record<string, string>[] {
  // 每個 webhook request 都可能觸發，但 CSV 是本機檔案且不常變動——process
  // 存活期間快取一次即可，避免每次白名單檢查都重新讀檔/解析。
  if (cache === null) {
    cache = parseCsv(readFileSync(TECH_USERS_CSV, 'utf8'))
  }
  return cache
}

/**
 * 輸入 Telegram chat_id，反查 tech-users.csv 的 tg_chat_id 欄位。
 * 找不到（欄位為空或無此 chat_id）回傳 null，不丟例外。
 */
export function resolveTechUserByChatId(chatId: string): TechUser | null {
  const row = loadRows().find(r => r.tg_chat_id === chatId && chatId !== '')
  if (!row) return null
  return {
    notion_user_id: row.notion_user_id ?? '',
    notion_user_name: row.notion_user_name ?? '',
    email: row.email ?? '',
  }
}
