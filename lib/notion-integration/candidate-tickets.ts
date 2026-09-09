import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { BugMode } from '../pipeline-runner/bug-mode.ts'

const execFileAsync = promisify(execFile)

const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
export const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b'
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
export const WANTED_STATUSES = ['仍有問題', '待處理']

// Bug List「AI分析」值 → pipeline 執行模式（2026-09-08 起，見
// pipeline-modes-project-docs/plan-pipeline-modes-v1.md §2.1 對照表）。只有
// 出現在這張表的值才算候選；其餘（空值、待規劃/待釐清/分析中/分析成功/
// 分析失敗/不需分析/問題分析完成，待確認）一律不出現在候選清單。
//
// Notion 已於 2026-09-08 完成改名（舊名『待分析』『需要重跑』已不存在）。
// ⚠ 需求池（demand-pool-tickets.ts）是另一顆 DB，它的『待分析』『需要重跑』
// 不在本次改名範圍，不要動。
export const AI_ANALYSIS_TO_MODE: Readonly<Record<string, BugMode>> = Object.freeze({
  '一鍵分析＋修復＋開 MR': 'full',
  全部重跑: 'full',
  '只做問題分析（不改程式）': 'analysis',
  '產出修復程式碼並開 MR': 'fix',
  '依補充留言重新分析（仍不改程式）': 'reanalyze',
})

// 2026-09-08 實測：Notion `select.equals` filter 帶**目前不存在**的 option 名稱
// 會整個請求 400（`select option "…" not found for property "AI分析"`），所以
// AI分析 的值域過濾**不能**放進 API filter——否則新舊名並存的過渡期、或任何
// 一次 Notion 改名都會讓候選查詢直接炸掉。本檔的 buildFilter 只在 API 端過濾
// 「當前指派 + 狀態」，AI分析 改由 candidatesFromResults 用上面的對照表在程式
// 端過濾（每人名下 仍有問題/待處理 的票數量有限，多拉幾列成本可忽略）。
//
// Notion 已於 2026-09-08 完成改名；本清單＝Notion 現存五個可認領選項，供
// ops-ui/notion-tickets.ts 的 API filter 使用，Notion 選項再變動時必須同批
// 更新（API 對不存在的名稱回 400）。
export const WANTED_AI_ANALYSIS: readonly string[] = [
  '一鍵分析＋修復＋開 MR',
  '全部重跑',
  '只做問題分析（不改程式）',
  '產出修復程式碼並開 MR',
  '依補充留言重新分析（仍不改程式）',
]

export type CandidateTicket = { ticket: string; aiAnalysis: string; mode: BugMode }

/** API 端 filter：只過濾 當前指派 + 狀態（select 型；Bug List 的『狀態』也是
 * select 型，跟需求池的 status 型不同，不要混用 { status: { equals } } 語法）。
 * AI分析 的過濾在 candidatesFromResults，理由見上方 WANTED_AI_ANALYSIS 註解。 */
export function buildFilter(notionUserId: string): object {
  return {
    and: [
      { property: '當前指派', people: { contains: notionUserId } },
      { or: WANTED_STATUSES.map(status => ({ property: '狀態', select: { equals: status } })) },
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
  return (await queryCandidateTicketsWithMode(notionUserId)).map(c => c.ticket)
}

/**
 * 同 queryCandidateTickets，但每張單附上 Notion 當下的「AI分析」值與對應的
 * pipeline 模式（2026-09-08）。claim.ts 認領時用這個決定 spawn 帶哪個 mode；
 * ticket-list.ts 用它在按鈕上標示會做到哪一步。
 */
export async function queryCandidateTicketsWithMode(notionUserId: string): Promise<CandidateTicket[]> {
  const filterJson = JSON.stringify(buildFilter(notionUserId))
  const { stdout: raw } = await execFileAsync('bash', [NOTION_SH, 'query-datasource', DATA_SOURCE_ID, filterJson], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results)) {
    throw new Error(`notion.sh query-datasource 回傳非預期格式: ${raw.slice(0, 500)}`)
  }
  return candidatesFromResults(parsed.results)
}

/** 純函式（可測）：query-datasource 的 results → 候選單。單號缺失、或 AI分析
 * 值不在對照表（理論上 filter 已擋掉，這裡是防禦）一律略過。 */
export function candidatesFromResults(results: unknown[]): CandidateTicket[] {
  const out: CandidateTicket[] = []
  for (const page of results as any[]) {
    const n = page?.properties?.['單號']?.unique_id?.number
    const aiAnalysis = page?.properties?.['AI分析']?.select?.name
    if (typeof n !== 'number' || typeof aiAnalysis !== 'string') continue
    const mode = AI_ANALYSIS_TO_MODE[aiAnalysis]
    if (!mode) continue
    out.push({ ticket: `FAQ-${n}`, aiAnalysis, mode })
  }
  return out
}

/**
 * 依單號查該 ticket 在 Notion 的完整頁面物件（含 url／properties），供
 * getTicketNotionUrl／getTicketAiAnalysisStatus 共用同一次查詢邏輯。ticket
 * 格式不是 FAQ-{number} 或查無此單都回傳 null，不丟例外。
 */
function queryTicketPage(ticket: string): { url?: string; id?: string; properties?: Record<string, unknown> } | null {
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

/**
 * 查單一 ticket 目前在 Notion 的 page id（UUID 格式，即 update-prop 需要的
 * `<page_id>`）。給 post-run-notify.ts 在 CLI 崩潰分類（NEEDS_NOTIFY：
 * skipped/timeout/infra_failure/cli_failure/unknown_failure/session_limit）
 * 時呼叫 `notion.sh update-prop` 寫入 AI分析=分析失敗用（2026-09-09，tracker.md
 * 退役後 CLI 崩潰也要留下 Notion 記錄，見該檔案 main() 呼叫處）。查無此單或
 * 欄位不存在都回傳 null，不丟例外，同一套 best-effort 慣例。
 */
export function getTicketPageId(ticket: string): string | null {
  return queryTicketPage(ticket)?.id ?? null
}
