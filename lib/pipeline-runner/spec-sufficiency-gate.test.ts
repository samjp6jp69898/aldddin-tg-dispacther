import { describe, expect, test } from 'bun:test'
import { extractBlockText, buildPrompt, formatResolvedComments } from './spec-sufficiency-gate.ts'

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

// 2026-09-16 實測回報的真實缺口（ALDREQ-865）：同事在 Notion 留言只貼了一份
// 附件（web_push_ios_pwa_webclip.md）、沒有打任何字，舊版 fetchComments 只讀
// rich_text，那則留言變成空字串後被「結尾是『：』就丟掉」的過濾器整則刪掉，
// 連「有這份文件」都沒進到 gate／repo-scope／draft 三段 prompt，分析自然沒
// 納入考量。以下測試釘住新的解析行為。
describe('formatResolvedComments — 純邏輯，不打真實 API', () => {
  test('一般文字留言：維持原本「作者：內容」格式', () => {
    const lines = formatResolvedComments([{ author: '小明', text: '這是留言', attachments: [] }])
    expect(lines).toEqual(['小明：這是留言'])
  })

  test('ALDREQ-865 形狀：留言沒有文字、只有一份文字附件 → 不可被丟掉，附件內容要內嵌', () => {
    const lines = formatResolvedComments([
      {
        author: 'Anthone Hung KHH',
        text: '',
        attachments: [{ name: 'web_push_ios_pwa_webclip.md', kind: 'text', content: '# WebClip 推播規格\n步驟一：...' }],
      },
    ])
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('Anthone Hung KHH')
    expect(lines[0]).toContain('web_push_ios_pwa_webclip.md')
    expect(lines[0]).toContain('# WebClip 推播規格')
    expect(lines[0]).toContain('步驟一：...')
  })

  test('文字與附件同時存在：兩者都要出現在同一則裡', () => {
    const lines = formatResolvedComments([
      { author: '小華', text: '規格如附件', attachments: [{ name: 'spec.md', kind: 'text', content: '內容 A' }] },
    ])
    expect(lines[0]).toContain('小華：規格如附件')
    expect(lines[0]).toContain('spec.md')
    expect(lines[0]).toContain('內容 A')
  })

  test('非文字附件（圖片/PDF）：讀不到內容也要標註檔名，讓判斷者知道有這份文件存在', () => {
    const lines = formatResolvedComments([
      { author: '小美', text: '', attachments: [{ name: '流程圖.png', kind: 'binary', note: '非文字檔，未載入內容' }] },
    ])
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('流程圖.png')
    expect(lines[0]).toContain('未載入內容')
  })

  test('附件下載失敗：如實標註失敗原因，不可靜默當成沒有附件', () => {
    const lines = formatResolvedComments([
      { author: '小王', text: '', attachments: [{ name: 'spec.md', kind: 'text', note: '下載失敗：HTTP 403' }] },
    ])
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('spec.md')
    expect(lines[0]).toContain('下載失敗：HTTP 403')
  })

  test('真正完全空的留言（沒文字也沒附件）：照舊濾掉，不要餵沒有資訊量的空行給模型', () => {
    expect(formatResolvedComments([{ author: '小明', text: '', attachments: [] }])).toEqual([])
  })

  test('多則留言：保持原順序，空的那則被濾掉不影響其他則', () => {
    const lines = formatResolvedComments([
      { author: 'A', text: '第一則', attachments: [] },
      { author: 'B', text: '', attachments: [] },
      { author: 'C', text: '', attachments: [{ name: 'c.md', kind: 'text', content: 'C 的文件' }] },
    ])
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('A：第一則')
    expect(lines[1]).toContain('C 的文件')
  })

  test('作者欄缺失（防禦性）：用「未知使用者」補，不丟例外', () => {
    const lines = formatResolvedComments([{ text: '匿名留言' }])
    expect(lines).toEqual(['未知使用者：匿名留言'])
  })
})
