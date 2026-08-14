import { execFileSync } from 'node:child_process'

const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b'

// 唯一可認領判準（見 tasks.json architecture_summary / changelog：使用者定案，
// 不再拿 tracker.sh row 的 pending/rerun 狀態做二次篩選）。
const WANTED_STATUSES = ['仍有問題', '待處理']

function buildFilter(notionUserId: string): object {
  return {
    and: [
      { property: '當前指派', people: { contains: notionUserId } },
      { or: WANTED_STATUSES.map(status => ({ property: '狀態', select: { equals: status } })) },
    ],
  }
}

/**
 * 輸入 notion_user_id，透過 scripts/notion.sh query-datasource 帶
 * people:{contains:<id>} filter 查該人正向候選單（狀態=仍有問題/待處理），
 * 回傳單號集合（如 ["FAQ-4616"]）。全程只呼叫 scripts/notion.sh，禁止自己
 * fetch Notion API 或讀 NOTION_TOKEN。
 *
 * 查無候選單回傳空陣列；scripts/notion.sh 本身失敗（非零 exit、非預期回應
 * 格式）視為真正的錯誤，直接拋出，不吞掉。
 */
export function queryCandidateTickets(notionUserId: string): string[] {
  const filterJson = JSON.stringify(buildFilter(notionUserId))
  const raw = execFileSync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, filterJson], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results)) {
    throw new Error(`notion.sh query-datasource 回傳非預期格式: ${raw.slice(0, 500)}`)
  }

  return parsed.results
    .map((page: any) => page.properties?.['單號']?.unique_id?.number)
    .filter((n: unknown): n is number => typeof n === 'number')
    .map((n: number) => `FAQ-${n}`)
}

/**
 * 查單一 ticket 目前在 Notion 的頁面 URL（給 T7 tracker.md 技術同步用）。
 * ticket 格式不是 FAQ-{number} 或查無此單都回傳 null，不丟例外。
 */
export function getTicketNotionUrl(ticket: string): string | null {
  const match = /^FAQ-(\d+)$/.exec(ticket)
  if (!match) return null

  const filter = { property: '單號', unique_id: { equals: Number(match[1]) } }
  const raw = execFileSync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, JSON.stringify(filter)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) return null
  return parsed.results[0]?.url ?? null
}
