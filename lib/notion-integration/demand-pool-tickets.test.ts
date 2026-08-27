import { describe, expect, test } from 'bun:test'
import { buildFilter, buildInAnalysisFilter, queryDemandPoolTickets, queryDemandTicketsInAnalysis } from './demand-pool-tickets.ts'

// 見 obsidian/commands/create-mr/references/tech-users.csv：KHH Evelyn Lin
// 的真實 notion_user_id，用真的值而非隨便編一個——T23 調查（2026-08-17）
// 實測過這個帳號在需求池狀態=文件完成待處理下有真實候選單（ALDREQ-741、
// ALDREQ-733），用來驗證 filter 邏輯真的能查到東西，不是查詢語法本身有
// 問題但剛好回傳空清單掩蓋掉。
const REAL_TECH_NOTION_USER_ID = '9208f5e1-d4ab-4a54-9ce6-80d62b174e93'

describe('buildFilter — 純邏輯，不打真實 API', () => {
  test('組出 and(技術處理人員 contains, or(狀態 status.equals 文件完成待處理/需求仍有問題), or(AI分析 select.equals 待分析/需要重跑))', () => {
    const filter = buildFilter('some-notion-user-id') as any

    expect(filter.and).toHaveLength(3)
    expect(filter.and[0]).toEqual({
      property: '技術處理人員',
      people: { contains: 'some-notion-user-id' },
    })
    expect(filter.and[1].or).toEqual([
      { property: '狀態', status: { equals: '文件完成待處理' } },
      { property: '狀態', status: { equals: '需求仍有問題' } },
    ])
    expect(filter.and[2].or).toEqual([
      { property: 'AI分析', select: { equals: '待分析' } },
      { property: 'AI分析', select: { equals: '需要重跑' } },
    ])
  })

  test('狀態 filter 用 status 型別（不是 select）——這個 database 的「狀態」屬性是 Notion status 型，跟 Bug List 的 select 型不同，混用會讓 Notion API 直接回錯誤', () => {
    const filter = buildFilter('x') as any
    const statusFilters = filter.and[1].or as any[]
    statusFilters.forEach(f => {
      expect(f.property).toBe('狀態')
      expect(f).toHaveProperty('status')
      expect(f).not.toHaveProperty('select')
    })
  })

  test('AI分析 filter 用 select 型別（跟 Bug List 共用同一組選項，不是 status 型）', () => {
    const filter = buildFilter('x') as any
    const aiFilters = filter.and[2].or as any[]
    aiFilters.forEach(f => {
      expect(f.property).toBe('AI分析')
      expect(f).toHaveProperty('select')
      expect(f).not.toHaveProperty('status')
    })
  })
})

describe('buildInAnalysisFilter — /status 指令用，純邏輯，不打真實 API', () => {
  test('組出 and(技術處理人員 contains, AI分析 select.equals 分析中)——不套用候選單的狀態/AI分析清單過濾，因為已認領的單 AI分析 就是分析中，不在候選清單範圍內', () => {
    const filter = buildInAnalysisFilter('some-notion-user-id') as any

    expect(filter.and).toHaveLength(2)
    expect(filter.and[0]).toEqual({
      property: '技術處理人員',
      people: { contains: 'some-notion-user-id' },
    })
    expect(filter.and[1]).toEqual({
      property: 'AI分析',
      select: { equals: '分析中' },
    })
  })
})

describe('queryDemandTicketsInAnalysis — 真實唯讀查詢 Notion（比照 queryDemandPoolTickets 的既有慣例，刻意不 mock）', () => {
  test('查無 AI分析=分析中 的 notion_user_id（不存在的假 UUID）：回傳空陣列而非拋例外', async () => {
    const tickets = await queryDemandTicketsInAnalysis('00000000-0000-0000-0000-000000000000')
    expect(tickets).toEqual([])
  })

  test('回傳值（若有）皆為合法 ALDREQ-{number} 格式', async () => {
    const tickets = await queryDemandTicketsInAnalysis(REAL_TECH_NOTION_USER_ID)
    expect(Array.isArray(tickets)).toBe(true)
    tickets.forEach(t => expect(t).toMatch(/^ALDREQ-\d+$/))
  })
})

describe('queryDemandPoolTickets — 真實唯讀查詢 Notion（比照 whitelist.test.ts 對 Bug List 的既有慣例，刻意不 mock）', () => {
  test('已知在「技術處理人員」有填、狀態符合條件的真實技術帳號：查到的每一筆都是合法 ALDREQ-{number} 格式', async () => {
    const tickets = await queryDemandPoolTickets(REAL_TECH_NOTION_USER_ID)
    expect(Array.isArray(tickets)).toBe(true)
    tickets.forEach(t => expect(t).toMatch(/^ALDREQ-\d+$/))
    // 不斷言確切張數/單號——T23 調查當下抽樣到的候選單（ALDREQ-741/733）
    // 可能隨時間被處理完畢而從候選清單消失，斷言具體單號會讓測試隨資料
    // 現況漂移而變脆弱；只鎖住「格式正確」這個結構性事實。
  })

  test('查無候選單的 notion_user_id（不存在的假 UUID）：回傳空陣列而非拋例外', async () => {
    const tickets = await queryDemandPoolTickets('00000000-0000-0000-0000-000000000000')
    expect(tickets).toEqual([])
  })
})
