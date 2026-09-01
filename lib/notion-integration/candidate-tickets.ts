import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b'
// 2026-08-23 review 發現：queryTicketPage 原本（getTicketNotionUrl 既有的
// execFileSync 呼叫）沒有帶 timeout，跟這個檔案的 queryCandidateTickets、
// post-run-notify.ts 其他所有 execFileSync 呼叫都刻意帶 timeout 的既有慣例
//不一致。原本只有 NEEDS_NOTIFY 那四種失敗分類會走到 getTicketNotionUrl，
// 現在 post-run-notify.ts 的 checkPushMismatch 讓 getTicketAiAnalysisStatus
// 在**每一個 success 分類**都會呼叫一次——若 notion.sh 卡住，會讓收尾流程
// 無限期不返回。補上跟其他檔案一致的 30 秒上限。
const EXEC_TIMEOUT_MS = 30_000

// 唯一可認領判準（見 tasks.json architecture_summary / changelog：使用者定案，
// 不再拿 tracker.sh row 的 pending/rerun 狀態做二次篩選）。
const WANTED_STATUSES = ['仍有問題', '待處理']

// 比照 demand-pool-tickets.ts 的 WANTED_AI_ANALYSIS：只有『待分析』（人工已
// 標記可分析）與『需要重跑』（分析過但要求重來一次）才算候選，其餘值（含
// 空值、待規劃/待釐清/分析中/分析成功/分析失敗/不需分析）一律不出現在候選
// 清單。這裡是 select 型（Bug List 的『狀態』也是 select 型，跟需求池的
// status 型不同，不要混用 { status: { equals } } 語法）。
const WANTED_AI_ANALYSIS = ['待分析', '需要重跑']

function buildFilter(notionUserId: string): object {
  return {
    and: [
      { property: '當前指派', people: { contains: notionUserId } },
      { or: WANTED_STATUSES.map(status => ({ property: '狀態', select: { equals: status } })) },
      { or: WANTED_AI_ANALYSIS.map(value => ({ property: 'AI分析', select: { equals: value } })) },
    ],
  }
}

/**
 * 輸入 notion_user_id，透過 scripts/notion.sh query-datasource 帶
 * people:{contains:<id>} filter 查該人正向候選單（狀態=仍有問題/待處理 且
 * AI分析=待分析/需要重跑，見上方 WANTED_STATUSES／WANTED_AI_ANALYSIS 註解），
 * 回傳單號集合（如 ["FAQ-4616"]）。全程只呼叫 scripts/notion.sh，禁止自己
 * fetch Notion API 或讀 NOTION_TOKEN。
 *
 * 查無候選單回傳空陣列；scripts/notion.sh 本身失敗（非零 exit、非預期回應
 * 格式）視為真正的錯誤，直接拋出，不吞掉。
 *
 * T17：改用 async execFile（原本是 execFileSync）——這是 bot.on('message')
 * 熱路徑上唯一一段會打真實網路（Notion API）的呼叫。
 *
 * 【T19 review 期間修正】原本這裡的理由寫「Bun 單執行緒，execFileSync 同步
 * 阻塞會讓整個 process 完全無法處理其他使用者的請求」——這個說法經 T19
 * review 實測推翻：Bun 1.2.9 下 execFileSync 阻塞其中一個 handler 時，
 * 同一個 Bun.serve process 內其他並發請求的 handler 仍會正常執行、正常回應
 * （用 execFileSync('sleep',['2']) 搭配時間戳實測驗證過，見 tasks.json T19
 * changelog），跟 Node.js 官方文件對 execFileSync 的行為描述不同，具體是
 * Bun runtime 內部怎麼做到的沒有深入研究。
 *
 * 但改成 async 本身仍然是對的、值得保留：(1) 不依賴特定 Bun 版本的實作細節
 * （文件上 execFileSync 就是同步阻塞，未來行為可能改變）；(2) 語意上更正確
 * ——這本來就是一段 I/O，用 async 表達比較誠實；(3) 個別使用者查詢變慢時
 * 仍然只影響自己的回覆延遲。實測（見 tasks.json T17 changelog）單次查詢
 * 耗時 400-720ms，遠低於 grammy 10 秒 timeout。
 */
export async function queryCandidateTickets(notionUserId: string): Promise<string[]> {
  const filterJson = JSON.stringify(buildFilter(notionUserId))
  const { stdout: raw } = await execFileAsync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, filterJson], {
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
 * 依單號查該 ticket 在 Notion 的完整頁面物件（含 url／properties），供
 * getTicketNotionUrl／getTicketAiAnalysisStatus 共用同一次查詢邏輯。ticket
 * 格式不是 FAQ-{number} 或查無此單都回傳 null，不丟例外。
 */
function queryTicketPage(ticket: string): { url?: string; properties?: Record<string, unknown> } | null {
  const match = /^FAQ-(\d+)$/.exec(ticket)
  if (!match) return null

  const filter = { property: '單號', unique_id: { equals: Number(match[1]) } }
  const raw = execFileSync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, JSON.stringify(filter)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: EXEC_TIMEOUT_MS,
  })

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) return null
  return parsed.results[0] ?? null
}

/**
 * 查單一 ticket 目前在 Notion 的頁面 URL（給 T7 tracker.md 技術同步用）。
 * ticket 格式不是 FAQ-{number} 或查無此單都回傳 null，不丟例外。
 */
export function getTicketNotionUrl(ticket: string): string | null {
  return queryTicketPage(ticket)?.url ?? null
}

/**
 * 查單一 ticket 目前在 Notion 的「AI分析」select 值（如「分析成功」／
 * 「分析失敗」）。給 post-run-notify.ts 偵測『pipeline 回報 success，但
 * mr-pusher 實際 push/glab mr create 全數失敗、已把這個欄位改成分析失敗』
 * 這種不一致情境用（見該檔案頭已知限制註解）。查無此單或欄位不存在都回傳
 * null，不丟例外——這是 best-effort 的補充判斷，不是唯一真相來源。
 */
export function getTicketAiAnalysisStatus(ticket: string): string | null {
  const page = queryTicketPage(ticket)
  const prop = page?.properties?.['AI分析'] as { select?: { name?: unknown } } | undefined
  const name = prop?.select?.name
  return typeof name === 'string' ? name : null
}
