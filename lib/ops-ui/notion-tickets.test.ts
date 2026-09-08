import { afterEach, describe, expect, test } from 'bun:test'
import {
  __setNotionQueryForTest,
  bugCandidateFilter,
  demandCandidateFilter,
  invalidateNotionCache,
  kindOf,
  listBugCandidates,
  lookupTickets,
  parseBugPage,
  parseDemandPage,
} from './notion-tickets.ts'

const BUG_PAGE = {
  url: 'https://app.notion.com/p/6T-abc',
  last_edited_time: '2026-09-08T09:03:00.000Z',
  properties: {
    單號: { type: 'unique_id', unique_id: { prefix: 'FAQ', number: 4905 } },
    問題摘要: { type: 'title', title: [{ plain_text: '登入後' }, { plain_text: '白畫面' }] },
    嚴重性: { type: 'select', select: { name: 'P2較高' } },
    狀態: { type: 'select', select: { name: '待處理' } },
    AI分析: { type: 'select', select: { name: '待分析' } },
    當前指派: { type: 'people', people: [{ id: 'u1', name: 'Ting-xuan TPE' }, { id: 'u2' }] },
  },
}
const DEMAND_PAGE = {
  url: 'https://app.notion.com/p/6T-def',
  properties: {
    ID: { type: 'unique_id', unique_id: { prefix: 'ALDREQ', number: 843 } },
    標題: { type: 'title', title: [{ plain_text: '新增提現限額' }] },
    優先級: { type: 'select', select: null },
    狀態: { type: 'status', status: { name: '文件完成待處理' } },
    AI分析: { type: 'select', select: { name: '需要重跑' } },
    技術處理人員: { type: 'people', people: [] },
  },
}

afterEach(() => __setNotionQueryForTest(null))

describe('parse*Page', () => {
  test('Bug List 頁面 → TicketRow（title 串接、people 缺名字給空字串）', () => {
    expect(parseBugPage(BUG_PAGE)).toEqual({
      ticket: 'FAQ-4905',
      kind: 'bug',
      title: '登入後白畫面',
      priority: 'P2較高',
      status: '待處理',
      aiAnalysis: '待分析',
      assignees: [
        { id: 'u1', name: 'Ting-xuan TPE' },
        { id: 'u2', name: '' },
      ],
      url: 'https://app.notion.com/p/6T-abc',
      lastEditedAt: '2026-09-08T09:03:00.000Z',
    })
  })
  test('需求池頁面 → TicketRow（status 型狀態、空 select → null）', () => {
    const row = parseDemandPage(DEMAND_PAGE)!
    expect(row.ticket).toBe('ALDREQ-843')
    expect(row.status).toBe('文件完成待處理')
    expect(row.priority).toBeNull()
    expect(row.aiAnalysis).toBe('需要重跑')
    expect(row.assignees).toEqual([])
    expect(row.lastEditedAt).toBeNull()
  })
  test('缺單號的頁面回 null', () => {
    expect(parseBugPage({ properties: {} })).toBeNull()
    expect(parseDemandPage({})).toBeNull()
  })
})

describe('filters / kindOf', () => {
  test('候選單 filter 只含狀態與 AI分析 兩層 or，不含 people 條件（全隊）', () => {
    const f = bugCandidateFilter() as any
    expect(f.and).toHaveLength(2)
    expect(JSON.stringify(f)).not.toContain('people')
    const d = demandCandidateFilter() as any
    expect(JSON.stringify(d)).toContain('"status":{"equals"')
  })
  test('kindOf', () => {
    expect(kindOf('FAQ-1')).toBe('bug')
    expect(kindOf('ALDREQ-22')).toBe('demand')
    expect(kindOf('FAQ-')).toBeNull()
    expect(kindOf('../x')).toBeNull()
  })
})

describe('快取與批次查詢', () => {
  test('15 秒內同一查詢只打一次 notion.sh', async () => {
    let calls = 0
    __setNotionQueryForTest(async () => {
      calls++
      return [BUG_PAGE]
    })
    await listBugCandidates()
    await listBugCandidates()
    expect(calls).toBe(1)
    invalidateNotionCache()
    await listBugCandidates()
    expect(calls).toBe(2)
  })
  test('查詢失敗不留在快取，下一次重打', async () => {
    let calls = 0
    __setNotionQueryForTest(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return []
    })
    await expect(listBugCandidates()).rejects.toThrow('boom')
    expect(await listBugCandidates()).toEqual([])
    expect(calls).toBe(2)
  })
  test('lookupTickets 依 kind 分組、多張用 or、單張直接條件、壞單號略過', async () => {
    const seen: { dsId: string; filter: any }[] = []
    __setNotionQueryForTest(async (dsId, filter) => {
      seen.push({ dsId, filter })
      return dsId.startsWith('21c') ? [BUG_PAGE] : [DEMAND_PAGE]
    })
    const map = await lookupTickets(['FAQ-4905', 'FAQ-1', 'ALDREQ-843', 'bogus'])
    expect([...map.keys()].sort()).toEqual(['ALDREQ-843', 'FAQ-4905'])
    expect(seen).toHaveLength(2)
    const bugCall = seen.find(s => s.dsId.startsWith('21c'))!
    expect(bugCall.filter.or).toHaveLength(2)
    expect(bugCall.filter.or[0]).toEqual({ property: '單號', unique_id: { equals: 1 } })
    const demandCall = seen.find(s => !s.dsId.startsWith('21c'))!
    expect(demandCall.filter).toEqual({ property: 'ID', unique_id: { equals: 843 } })
  })
})
