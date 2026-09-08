import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as bugList from '../notion-integration/candidate-tickets.ts'
import * as demandPool from '../notion-integration/demand-pool-tickets.ts'

// ops-ui 的 Notion 讀取面（2026-09-08）：跟 candidate-tickets.ts／
// demand-pool-tickets.ts 一樣只走 scripts/notion.sh query-datasource（不自己
// fetch Notion API、不讀 NOTION_TOKEN），差別在：
//   - 回的是整列（單號／標題／嚴重性／狀態／AI分析／指派／Notion 連結），
//     不只單號——UI 要把這些欄位擺在表格上並直接連到 Notion 頁面。
//   - 候選單查「全隊」而不是「某個人」（UI 讓大家看得到彼此手上的待處理
//     單；能不能按「啟動」由 assignees 是否含本人決定，見 index.ts）。
//   - 帶 15 秒的記憶體快取：多位同事同時開著頁面輪詢，不該每個人每 15 秒
//     各打一次 Notion；快取 key 是 data source + filter JSON。
// 「可認領」的判準常數（WANTED_STATUSES／WANTED_AI_ANALYSIS）直接 import
// 既有模組的 export，不複製一份——TG bot 與 UI 對「什麼叫待處理」永遠同一套。

const execFileAsync = promisify(execFile)
const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
const EXEC_TIMEOUT_MS = 30_000
const CACHE_TTL_MS = 15_000

export type TicketKind = 'bug' | 'demand'

export type TicketRow = {
  ticket: string
  kind: TicketKind
  title: string
  /** Bug 的『嚴重性』／需求單的『優先級』。 */
  priority: string | null
  status: string | null
  aiAnalysis: string | null
  assignees: { id: string; name: string }[]
  url: string
  lastEditedAt: string | null
}

export function kindOf(ticket: string): TicketKind | null {
  if (/^FAQ-\d+$/.test(ticket)) return 'bug'
  if (/^ALDREQ-\d+$/.test(ticket)) return 'demand'
  return null
}

type NotionPage = { url?: string; last_edited_time?: string; properties?: Record<string, any> }

function richText(prop: any): string {
  const arr = prop?.title ?? prop?.rich_text
  if (!Array.isArray(arr)) return ''
  return arr.map((t: any) => (typeof t?.plain_text === 'string' ? t.plain_text : '')).join('')
}
function selectName(prop: any): string | null {
  const name = prop?.select?.name ?? prop?.status?.name
  return typeof name === 'string' ? name : null
}
function people(prop: any): { id: string; name: string }[] {
  if (!Array.isArray(prop?.people)) return []
  return prop.people
    .filter((p: any) => typeof p?.id === 'string')
    .map((p: any) => ({ id: p.id, name: typeof p.name === 'string' ? p.name : '' }))
}
function uniqueNumber(prop: any): number | null {
  const n = prop?.unique_id?.number
  return typeof n === 'number' ? n : null
}

/** Bug List 頁面 → TicketRow；缺單號（不是這個 database 的頁面）回 null。 */
export function parseBugPage(page: NotionPage): TicketRow | null {
  const p = page.properties ?? {}
  const n = uniqueNumber(p['單號'])
  if (n === null) return null
  return {
    ticket: `FAQ-${n}`,
    kind: 'bug',
    title: richText(p['問題摘要']),
    priority: selectName(p['嚴重性']),
    status: selectName(p['狀態']),
    aiAnalysis: selectName(p['AI分析']),
    assignees: people(p['當前指派']),
    url: typeof page.url === 'string' ? page.url : '',
    lastEditedAt: typeof page.last_edited_time === 'string' ? page.last_edited_time : null,
  }
}

/** 總需求池頁面 → TicketRow；缺 ID 回 null。 */
export function parseDemandPage(page: NotionPage): TicketRow | null {
  const p = page.properties ?? {}
  const n = uniqueNumber(p['ID'])
  if (n === null) return null
  return {
    ticket: `ALDREQ-${n}`,
    kind: 'demand',
    title: richText(p['標題']),
    priority: selectName(p['優先級']),
    status: selectName(p['狀態']),
    aiAnalysis: selectName(p['AI分析']),
    assignees: people(p['技術處理人員']),
    url: typeof page.url === 'string' ? page.url : '',
    lastEditedAt: typeof page.last_edited_time === 'string' ? page.last_edited_time : null,
  }
}

export function bugCandidateFilter(): object {
  return {
    and: [
      { or: bugList.WANTED_STATUSES.map(status => ({ property: '狀態', select: { equals: status } })) },
      { or: bugList.WANTED_AI_ANALYSIS.map(value => ({ property: 'AI分析', select: { equals: value } })) },
    ],
  }
}

export function demandCandidateFilter(): object {
  return {
    and: [
      { or: demandPool.WANTED_STATUSES.map(status => ({ property: '狀態', status: { equals: status } })) },
      { or: demandPool.WANTED_AI_ANALYSIS.map(value => ({ property: 'AI分析', select: { equals: value } })) },
    ],
  }
}

// ---- 查詢 + 快取 ------------------------------------------------------------

type QueryFn = (dsId: string, filter: object) => Promise<NotionPage[]>

async function realQuery(dsId: string, filter: object): Promise<NotionPage[]> {
  const { stdout: raw } = await execFileAsync('bash', [NOTION_SH, 'query-datasource', dsId, JSON.stringify(filter)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: EXEC_TIMEOUT_MS,
  })
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results)) {
    throw new Error(`notion.sh query-datasource 回傳非預期格式: ${raw.slice(0, 500)}`)
  }
  return parsed.results
}

let queryOverride: QueryFn | null = null
const cache = new Map<string, { at: number; promise: Promise<NotionPage[]> }>()

/** 測試用：注入假的 query 並清掉快取。傳 null 恢復真實 notion.sh。 */
export function __setNotionQueryForTest(fn: QueryFn | null): void {
  queryOverride = fn
  cache.clear()
}

/** 認領成功後呼叫：下一次輪詢就看到最新 Notion 欄位，不等快取自然過期。 */
export function invalidateNotionCache(): void {
  cache.clear()
}

function cachedQuery(dsId: string, filter: object, now = Date.now()): Promise<NotionPage[]> {
  const key = `${dsId}:${JSON.stringify(filter)}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise
  const promise = (queryOverride ?? realQuery)(dsId, filter)
  cache.set(key, { at: now, promise })
  // 失敗不留在快取裡，下一次輪詢重新打（否則一次 Notion 逾時會讓 15 秒內
  // 所有人都看到同一個錯誤）。
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

export async function listBugCandidates(): Promise<TicketRow[]> {
  const pages = await cachedQuery(bugList.DATA_SOURCE_ID, bugCandidateFilter())
  return pages.map(parseBugPage).filter((r): r is TicketRow => r !== null)
}

export async function listDemandCandidates(): Promise<TicketRow[]> {
  const pages = await cachedQuery(demandPool.DATA_SOURCE_ID, demandCandidateFilter())
  return pages.map(parseDemandPage).filter((r): r is TicketRow => r !== null)
}

const OR_CHUNK = 100 // Notion compound filter 單層 or 上限

/** 依單號批次查頁面（進行中／處理過分頁要顯示標題、Notion 連結與 AI分析
 * 現值）。格式不對的單號直接略過；查無的單號不在回傳 map 裡。 */
export async function lookupTickets(tickets: string[]): Promise<Map<string, TicketRow>> {
  const out = new Map<string, TicketRow>()
  const bugNums = new Set<number>()
  const demandNums = new Set<number>()
  for (const t of tickets) {
    const m = /^(FAQ|ALDREQ)-(\d+)$/.exec(t)
    if (!m) continue
    ;(m[1] === 'FAQ' ? bugNums : demandNums).add(Number(m[2]))
  }
  const chunks = (nums: Set<number>): number[][] => {
    const arr = [...nums].sort((a, b) => a - b)
    const res: number[][] = []
    for (let i = 0; i < arr.length; i += OR_CHUNK) res.push(arr.slice(i, i + OR_CHUNK))
    return res
  }
  const jobs: Promise<void>[] = []
  for (const chunk of chunks(bugNums)) {
    const conds = chunk.map(n => ({ property: '單號', unique_id: { equals: n } }))
    const filter = conds.length === 1 ? conds[0]! : { or: conds }
    jobs.push(
      cachedQuery(bugList.DATA_SOURCE_ID, filter).then(pages => {
        for (const page of pages) {
          const row = parseBugPage(page)
          if (row) out.set(row.ticket, row)
        }
      }),
    )
  }
  for (const chunk of chunks(demandNums)) {
    const conds = chunk.map(n => ({ property: 'ID', unique_id: { equals: n } }))
    const filter = conds.length === 1 ? conds[0]! : { or: conds }
    jobs.push(
      cachedQuery(demandPool.DATA_SOURCE_ID, filter).then(pages => {
        for (const page of pages) {
          const row = parseDemandPage(page)
          if (row) out.set(row.ticket, row)
        }
      }),
    )
  }
  await Promise.all(jobs)
  return out
}
