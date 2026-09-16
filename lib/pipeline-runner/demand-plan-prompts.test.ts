import { describe, expect, test } from 'bun:test'
import { buildDraftPrompt, buildReviewPrompt, buildSynthesizePrompt, buildClassifyPrompt, REVIEW_LENSES } from './demand-plan-prompts.ts'

describe('REVIEW_LENSES', () => {
  test('固定三個角度：coding convention / 安全性 / 可行性-對衝性', () => {
    expect(REVIEW_LENSES.map(l => l.lens)).toEqual(['convention', 'security', 'conflict'])
  })
})

describe('buildDraftPrompt', () => {
  test('帶入 ticket、規格、留言、repo、worktree 路徑', () => {
    const prompt = buildDraftPrompt('ALDREQ-746', '規格內容', ['小明：留言'], ['abu'], '/wt/ALDREQ-746')
    expect(prompt).toContain('ALDREQ-746')
    expect(prompt).toContain('規格內容')
    expect(prompt).toContain('小明：留言')
    expect(prompt).toContain('abu')
    expect(prompt).toContain('/wt/ALDREQ-746/abu')
  })

  test('多個 repo：每個 repo 各自列出對應的 worktree 子路徑', () => {
    const prompt = buildDraftPrompt('ALDREQ-765', '規格內容', [], ['agrabah', 'abu', 'rajah'], '/wt/ALDREQ-765')
    expect(prompt).toContain('/wt/ALDREQ-765/agrabah')
    expect(prompt).toContain('/wt/ALDREQ-765/abu')
    expect(prompt).toContain('/wt/ALDREQ-765/rajah')
    expect(prompt).toContain('3 個 repo')
  })

  test('明確禁止 Edit/Write，強調唯讀', () => {
    const prompt = buildDraftPrompt('ALDREQ-1', '規格', [], ['abu'], '/wt')
    expect(prompt).toContain('唯讀')
    expect(prompt).toContain('不要用 Edit/Write')
  })

  test('包含範圍窮盡紀律的關鍵字', () => {
    const prompt = buildDraftPrompt('ALDREQ-1', '規格', [], ['abu'], '/wt')
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
      const prompt = buildReviewPrompt(lens, 'ALDREQ-1', '規格', [], drafts)
      expect(prompt).toContain('draft A 內容')
      expect(prompt).toContain('draft B 內容')
    }
  })

  test('conflict 角度要求明確給出合併結論，不能只列差異', () => {
    const prompt = buildReviewPrompt('conflict', 'ALDREQ-1', '規格', [], drafts)
    expect(prompt).toContain('應該採用哪份/怎麼合併')
  })

  test('未知 lens 拋出例外', () => {
    // @ts-expect-error 刻意測試非法輸入
    expect(() => buildReviewPrompt('typo', 'ALDREQ-1', '規格', [], drafts)).toThrow()
  })
})

describe('buildSynthesizePrompt', () => {
  test('帶入兩份 draft 與三個角度的 review 結論', () => {
    const prompt = buildSynthesizePrompt(
      'ALDREQ-746',
      '規格',
      [],
      [{ label: 'Draft A', text: 'A 的內容' }],
      [{ label: 'Coding Convention', text: 'PASS' }],
    )
    expect(prompt).toContain('A 的內容')
    expect(prompt).toContain('PASS')
    expect(prompt).toContain('ALDREQ-746-plan.md')
  })

  test('輸出格式範本包含固定七個章節', () => {
    const prompt = buildSynthesizePrompt('ALDREQ-1', '規格', [], [], [])
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

// 2026-09-16：ALDREQ-865 重跑後發現的第二層缺口。修好 fetchComments 之後，
// 留言附件只進得了 draft prompt，review 與 synthesize 兩階段仍看不到附件
// 原文——實證就在那次重跑產出的 plan.md 裡：synthesize 自己寫下「endpoint
// host 驗證機制在原始草稿的外部附件中如何具體實作，本次彙整環境無法交叉
// 核對」，只能靠 draft 的轉述。附件往往就是整張單最權威的規格來源，審查與
// 彙整階段沒有理由拿不到。
describe('留言與附件要一路帶到 review / synthesize（不是只有 draft 看得到）', () => {
  const drafts = [{ label: 'Draft A', text: 'draft A 內容' }]
  const reviews = [{ label: 'Coding Convention', text: 'PASS' }]
  const comments = ['Anthone：\n[附件 web_push_ios_pwa_webclip.md]\n必須解析 URL host 再比對，不可用字串前綴\n[附件結束 web_push_ios_pwa_webclip.md]']

  test('review prompt 帶入留言與附件全文', () => {
    const prompt = buildReviewPrompt('security', 'ALDREQ-865', '規格', comments, drafts)
    expect(prompt).toContain('web_push_ios_pwa_webclip.md')
    expect(prompt).toContain('必須解析 URL host 再比對')
  })

  test('synthesize prompt 帶入留言與附件全文', () => {
    const prompt = buildSynthesizePrompt('ALDREQ-865', '規格', comments, drafts, reviews)
    expect(prompt).toContain('web_push_ios_pwa_webclip.md')
    expect(prompt).toContain('必須解析 URL host 再比對')
  })

  test('沒有留言時兩者都明確標註「（沒有留言）」，不是留白讓模型腦補', () => {
    expect(buildReviewPrompt('security', 'ALDREQ-1', '規格', [], drafts)).toContain('（沒有留言）')
    expect(buildSynthesizePrompt('ALDREQ-1', '規格', [], drafts, reviews)).toContain('（沒有留言）')
  })
})
