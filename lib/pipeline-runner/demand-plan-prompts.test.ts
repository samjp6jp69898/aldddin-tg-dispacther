import { describe, expect, test } from 'bun:test'
import { buildDraftPrompt, buildReviewPrompt, buildSynthesizePrompt, buildClassifyPrompt, REVIEW_LENSES } from './demand-plan-prompts.ts'

describe('REVIEW_LENSES', () => {
  test('固定三個角度：coding convention / 安全性 / 可行性-對衝性', () => {
    expect(REVIEW_LENSES.map(l => l.lens)).toEqual(['convention', 'security', 'conflict'])
  })
})

describe('buildDraftPrompt', () => {
  test('帶入 ticket、規格、留言、repo、worktree 路徑', () => {
    const prompt = buildDraftPrompt('ALDREQ-746', '規格內容', ['小明：留言'], 'abu', '/wt/ALDREQ-746/abu')
    expect(prompt).toContain('ALDREQ-746')
    expect(prompt).toContain('規格內容')
    expect(prompt).toContain('小明：留言')
    expect(prompt).toContain('abu')
    expect(prompt).toContain('/wt/ALDREQ-746/abu')
  })

  test('明確禁止 Edit/Write，強調唯讀', () => {
    const prompt = buildDraftPrompt('ALDREQ-1', '規格', [], 'abu', '/wt/abu')
    expect(prompt).toContain('唯讀')
    expect(prompt).toContain('不要用 Edit/Write')
  })

  test('包含範圍窮盡紀律的關鍵字', () => {
    const prompt = buildDraftPrompt('ALDREQ-1', '規格', [], 'abu', '/wt/abu')
    expect(prompt).toContain('換一個不同的搜尋角度重新驗證一次')
    expect(prompt).toContain('先搜尋鄰近既有慣例')
  })
})

describe('buildReviewPrompt', () => {
  const drafts = [
    { label: 'Draft A', text: 'draft A 內容' },
    { label: 'Draft B', text: 'draft B 內容' },
  ]

  test('三個角度各自帶入正確的審查重點，且都看得到兩份 draft', () => {
    for (const lens of ['convention', 'security', 'conflict'] as const) {
      const prompt = buildReviewPrompt(lens, 'ALDREQ-1', '規格', drafts)
      expect(prompt).toContain('draft A 內容')
      expect(prompt).toContain('draft B 內容')
    }
  })

  test('conflict 角度要求明確給出合併結論，不能只列差異', () => {
    const prompt = buildReviewPrompt('conflict', 'ALDREQ-1', '規格', drafts)
    expect(prompt).toContain('應該採用哪份/怎麼合併')
  })

  test('未知 lens 拋出例外', () => {
    // @ts-expect-error 刻意測試非法輸入
    expect(() => buildReviewPrompt('typo', 'ALDREQ-1', '規格', drafts)).toThrow()
  })
})

describe('buildSynthesizePrompt', () => {
  test('帶入兩份 draft 與三個角度的 review 結論', () => {
    const prompt = buildSynthesizePrompt(
      'ALDREQ-746',
      '規格',
      [{ label: 'Draft A', text: 'A 的內容' }],
      [{ label: 'Coding Convention', text: 'PASS' }],
    )
    expect(prompt).toContain('A 的內容')
    expect(prompt).toContain('PASS')
    expect(prompt).toContain('ALDREQ-746-plan.md')
  })

  test('輸出格式範本包含固定七個章節', () => {
    const prompt = buildSynthesizePrompt('ALDREQ-1', '規格', [], [])
    for (const section of ['需求摘要', '逐項變更清單', '驗證依據', '候選範圍清單', '判斷決策記錄', 'Review 結果', '整體信心評分']) {
      expect(prompt).toContain(section)
    }
  })
})

describe('buildClassifyPrompt', () => {
  test('帶入 ticket 與計畫全文，要求嚴格 JSON 輸出', () => {
    const prompt = buildClassifyPrompt('ALDREQ-746', '# 計畫內容\n...')
    expect(prompt).toContain('ALDREQ-746')
    expect(prompt).toContain('# 計畫內容')
    expect(prompt).toContain('"status"')
    expect(prompt).toContain('already-satisfied')
    expect(prompt).toContain('needs-clarification')
  })
})
