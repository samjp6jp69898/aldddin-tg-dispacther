import { describe, expect, test } from 'bun:test'
import { AI_ANALYSIS_TO_MODE, WANTED_AI_ANALYSIS, buildFilter, candidatesFromResults } from './candidate-tickets.ts'

// 純邏輯測試，不打 Notion。真實查詢路徑（queryCandidateTicketsWithMode）走
// scripts/notion.sh，屬整合測試範圍。

function page(n: number | undefined, aiAnalysis: string | undefined) {
  return {
    properties: {
      單號: n === undefined ? {} : { unique_id: { number: n } },
      AI分析: aiAnalysis === undefined ? { select: null } : { select: { name: aiAnalysis } },
    },
  }
}

describe('AI_ANALYSIS_TO_MODE / buildFilter（plan-pipeline-modes-v1 §2.1）', () => {
  test('API filter 只過濾 當前指派 + 狀態，**不含** AI分析 子句（Notion 對不存在的 option 名會 400，AI分析 改程式端過濾）', () => {
    const f = buildFilter('uid') as any
    expect(f.and).toHaveLength(2)
    expect(f.and[0]).toEqual({ property: '當前指派', people: { contains: 'uid' } })
    expect((f.and[1].or as any[]).map(x => x.property)).toEqual(['狀態', '狀態'])
    expect(JSON.stringify(f)).not.toContain('AI分析')
  })

  test('對照表涵蓋 Notion 現存五個可認領值', () => {
    for (const v of ['一鍵分析＋修復＋開 MR', '全部重跑', '只做問題分析（不改程式）', '產出修復程式碼並開 MR', '依留言重新分析（不改程式）']) {
      expect(AI_ANALYSIS_TO_MODE[v]).toBeDefined()
    }
  })

  test('WANTED_AI_ANALYSIS（給仍用 API filter 的 ops-ui）是對照表 key 的子集，且只含 Notion 當下存在的選項', () => {
    for (const v of WANTED_AI_ANALYSIS) expect(AI_ANALYSIS_TO_MODE[v]).toBeDefined()
    expect([...WANTED_AI_ANALYSIS]).toEqual(['一鍵分析＋修復＋開 MR', '全部重跑', '只做問題分析（不改程式）', '產出修復程式碼並開 MR', '依留言重新分析（不改程式）'])
  })

  test('pipeline 自己設的終態值不在候選集合（問題分析完成，待確認 / 分析成功 / 待釐清 / 分析失敗）', () => {
    for (const v of ['問題分析完成，待確認', '分析成功', '待釐清', '分析失敗', '待規劃', '分析中', '不需分析']) {
      expect(AI_ANALYSIS_TO_MODE[v]).toBeUndefined()
    }
  })

  test('舊名（待分析／需要重跑）已改名，不在對照表', () => {
    expect(AI_ANALYSIS_TO_MODE['待分析']).toBeUndefined()
    expect(AI_ANALYSIS_TO_MODE['需要重跑']).toBeUndefined()
  })

  test('新名對到正確的 mode：一鍵分析＋修復＋開 MR / 全部重跑 → full', () => {
    expect(AI_ANALYSIS_TO_MODE['一鍵分析＋修復＋開 MR']).toBe('full')
    expect(AI_ANALYSIS_TO_MODE['全部重跑']).toBe('full')
  })
})

describe('candidatesFromResults', () => {
  test('每張單帶 ticket / aiAnalysis / mode', () => {
    const out = candidatesFromResults([page(4616, '只做問題分析（不改程式）'), page(12, '一鍵分析＋修復＋開 MR'), page(7, '產出修復程式碼並開 MR')])
    expect(out).toEqual([
      { ticket: 'FAQ-4616', aiAnalysis: '只做問題分析（不改程式）', mode: 'analysis' },
      { ticket: 'FAQ-12', aiAnalysis: '一鍵分析＋修復＋開 MR', mode: 'full' },
      { ticket: 'FAQ-7', aiAnalysis: '產出修復程式碼並開 MR', mode: 'fix' },
    ])
  })

  test('單號缺、AI分析 空、或值不在對照表 → 略過（AI分析 的過濾就在這裡，API filter 不管它）', () => {
    const out = candidatesFromResults([page(undefined, '一鍵分析＋修復＋開 MR'), page(1, undefined), page(2, '分析成功'), page(3, '全部重跑')])
    expect(out).toEqual([{ ticket: 'FAQ-3', aiAnalysis: '全部重跑', mode: 'full' }])
  })
})
