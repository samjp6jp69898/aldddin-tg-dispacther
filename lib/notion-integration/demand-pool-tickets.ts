import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
// 『總需求池資料庫』，與 Bug List 平行且有 relation 互連（見 tasks.json T23
// changelog）。跟 candidate-tickets.ts 的 DATA_SOURCE_ID 不是同一個 database。
const DATA_SOURCE_ID = '21d87d78-618a-8135-ad4f-000b273e1293'

// 唯一可認領判準（使用者 2026-08-17 定案，見 tasks.json T23 changelog）：
// 『技術處理人員』這個 people 欄位最貼近 Bug List 的『當前指派』（抽樣裡填的
// 人 100% 是真技術），狀態則對齊 Bug List 的『仍有問題/待處理』精神，取
// 『文件完成待處理』（下一步該輪到技術接手）與『需求仍有問題』兩個值。
//
// 注意：這個 database 的『狀態』屬性型別是 Notion 的 status 型（不是 Bug
// List 那種 select 型），filter 語法要用 { status: { equals } } 而不是
// candidate-tickets.ts 的 { select: { equals } }——已用 notion.sh
// query-datasource 實測驗證過兩者回傳格式不同，混用會讓 Notion API 直接
// 回錯誤，不是猜測。
const WANTED_STATUSES = ['文件完成待處理', '需求仍有問題']

// export 供測試直接驗證 filter 組裝邏輯，不需要真的打 Notion API
// （candidate-tickets.ts 的 buildFilter 沒有 export，因為那個檔案本身沒有
// 測試檔；這裡有測試需求，所以 export，屬於這個檔案自己的取捨）。
export function buildFilter(notionUserId: string): object {
  return {
    and: [
      { property: '技術處理人員', people: { contains: notionUserId } },
      { or: WANTED_STATUSES.map(status => ({ property: '狀態', status: { equals: status } })) },
    ],
  }
}

/**
 * 輸入 notion_user_id，查該人在需求池（總需求池資料庫）的候選單（狀態=
 * 文件完成待處理/需求仍有問題，見上方 WANTED_STATUSES 註解），回傳單號
 * 集合（如 ["ALDREQ-741"]）。全程只呼叫 scripts/notion.sh，禁止自己 fetch
 * Notion API 或讀 NOTION_TOKEN（比照 candidate-tickets.ts 的既有紀律）。
 *
 * 查無候選單回傳空陣列；scripts/notion.sh 本身失敗（非零 exit、非預期回應
 * 格式）視為真正的錯誤，直接拋出，不吞掉。
 *
 * T23 調查已記錄：『技術處理人員』在最接近可認領的狀態（文件完成待處理）
 * 常常是空的（100 筆抽樣僅 5 筆有填），所以這裡查到空清單是正常的資料
 * 現況，不代表查詢邏輯有問題。
 */
export async function queryDemandPoolTickets(notionUserId: string): Promise<string[]> {
  const filterJson = JSON.stringify(buildFilter(notionUserId))
  const { stdout: raw } = await execFileAsync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, filterJson], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results)) {
    throw new Error(`notion.sh query-datasource 回傳非預期格式: ${raw.slice(0, 500)}`)
  }
  // T31 review 發現：notion.sh query-datasource 與這裡都沒有處理分頁
  // （固定 page_size 100，不追 has_more/next_cursor）。實測今天單一技術
  // 人員最多只有 2 張候選單，離 100 很遠，但這是『靜默丟資料』風險——比起
  // 直接報錯更危險，所以在這裡明確攔一次：一旦真的撞到 has_more，寧可整個
  // 查詢失敗（使用者會看到明確錯誤、下次重試或回報），也不要悄悄回傳不完整
  // 的候選單清單。不在這裡動 notion.sh 本身（整個 aladdin 共用的腳本，改動
  // 範圍與影響超出 T31）。
  if (parsed.has_more) {
    throw new Error('notion.sh query-datasource 回傳 has_more=true（超過單頁 100 筆），目前未實作分頁，拒絕回傳不完整的候選單清單')
  }

  // 這個 database 的 unique_id 屬性名稱是『ID』（Bug List 是『單號』）——
  // 兩個 database 各自的實際欄位命名就是不同，已用 notion.sh 實測確認，
  // 不是疏漏或複製時漏改。
  return parsed.results
    .map((page: any) => page.properties?.['ID']?.unique_id?.number)
    .filter((n: unknown): n is number => typeof n === 'number')
    .map((n: number) => `ALDREQ-${n}`)
}

/**
 * 查單一需求單目前在 Notion 的頁面 URL（給 T33 claim handler 更新 AI分析
 * 欄位用，比照 candidate-tickets.ts 的 getTicketNotionUrl）。ticket 格式
 * 不是 ALDREQ-{number} 或查無此單都回傳 null，不丟例外。
 */
export function getDemandTicketNotionUrl(ticket: string): string | null {
  const match = /^ALDREQ-(\d+)$/.exec(ticket)
  if (!match) return null

  const filter = { property: 'ID', unique_id: { equals: Number(match[1]) } }
  // T34 review 發現：這裡跟這個目錄大多數 execFile 呼叫不一致，原本沒有
  // timeout（candidate-tickets.ts 的同名函式 getTicketNotionUrl 也一樣沒有，
  // 是既有缺口，但那個檔案不在本次改動範圍，這裡只修自己新增的這份）。
  // T33（claim 會呼叫它）、T34（gate 會呼叫它）都是『卡住比報錯更糟』的
  // 情境，補上跟這個目錄其他檔案一致的 30 秒上限。
  const raw = execFileSync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, JSON.stringify(filter)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) return null
  return parsed.results[0]?.url ?? null
}
