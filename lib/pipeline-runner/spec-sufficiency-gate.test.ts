import { describe, expect, test } from 'bun:test'
import { extractBlockText, buildPrompt } from './spec-sufficiency-gate.ts'

describe('extractBlockText — 純邏輯，不打真實 API', () => {
  test('一般文字 block（paragraph/heading）：從 rich_text 陣列串出 plain_text', () => {
    const block = { type: 'paragraph', paragraph: { rich_text: [{ plain_text: '第一段 ' }, { plain_text: '第二段' }] } }
    expect(extractBlockText(block)).toBe('第一段 第二段')
  })

  test('沒有 rich_text 的 block type（例如 image）：回傳空字串，不丟例外', () => {
    const block = { type: 'image', image: { type: 'file', file: { url: 'x' } } }
    expect(extractBlockText(block)).toBe('')
  })

  // T34 review 實測發現的真實邊界情況（見 tasks.json T34 changelog）：
  // ALDREQ-656 曾被誤判「規格不足」，因為表格內容完全沒被讀到——table_row
  // 用 cells（陣列的陣列）存內容，不是 rich_text，是這個測試要釘住的行為。
  test('table_row：從 cells（陣列的陣列）串出內容，用 | 分隔各欄位', () => {
    const block = {
      type: 'table_row',
      table_row: {
        cells: [
          [{ plain_text: 'FF需求' }],
          [],
          [{ plain_text: '合營代理佣金' }],
          [{ plain_text: '欄位說明內容' }],
        ],
      },
    }
    expect(extractBlockText(block)).toBe('FF需求 |  | 合營代理佣金 | 欄位說明內容')
  })

  test('table_row 但 cells 不是陣列（防禦性）：回傳空字串不丟例外', () => {
    const block = { type: 'table_row', table_row: {} }
    expect(extractBlockText(block)).toBe('')
  })
})

describe('buildPrompt — 純邏輯，不打真實 API', () => {
  test('內文與留言都有內容時，正確帶入 prompt', () => {
    const prompt = buildPrompt('ALDREQ-741', '這是規格內容', ['小明：這是留言'])
    expect(prompt).toContain('ALDREQ-741')
    expect(prompt).toContain('這是規格內容')
    expect(prompt).toContain('小明：這是留言')
  })

  test('內文與留言都是空的時候，明確標註「空的」/「沒有留言」，不是留白讓模型自己腦補', () => {
    const prompt = buildPrompt('ALDREQ-999', '', [])
    expect(prompt).toContain('（頁面內文是空的）')
    expect(prompt).toContain('（沒有留言）')
  })
})
