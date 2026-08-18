import { describe, expect, test } from 'bun:test'
import { classifyAiAnalysis, buildNotionCommentText, buildTelegramText, shouldUploadPlan, type DemandOutcome } from './demand-finalize.ts'

describe('classifyAiAnalysis', () => {
  test('plan/success → 分析成功', () => {
    expect(classifyAiAnalysis({ kind: 'plan', status: 'success', planPath: '/x', summary: 's' })).toBe('分析成功')
  })
  test('plan/already-satisfied → 不需分析', () => {
    expect(classifyAiAnalysis({ kind: 'plan', status: 'already-satisfied', planPath: '/x', summary: 's' })).toBe('不需分析')
  })
  test('plan/needs-clarification → 待釐清', () => {
    expect(classifyAiAnalysis({ kind: 'plan', status: 'needs-clarification', planPath: '/x', summary: 's' })).toBe('待釐清')
  })
  test('insufficient-spec → 待釐清', () => {
    expect(classifyAiAnalysis({ kind: 'insufficient-spec', missing: '缺欄位' })).toBe('待釐清')
  })
  test('cross-repo → 待釐清', () => {
    expect(classifyAiAnalysis({ kind: 'cross-repo', repos: ['abu', 'agrabah'] })).toBe('待釐清')
  })
  test('setup-failed → 分析失敗', () => {
    expect(classifyAiAnalysis({ kind: 'setup-failed', reason: 'timeout' })).toBe('分析失敗')
  })
  test('implementer-error → 分析失敗', () => {
    expect(classifyAiAnalysis({ kind: 'implementer-error', detail: 'crash' })).toBe('分析失敗')
  })
  test('unexpected-error → 分析失敗', () => {
    expect(classifyAiAnalysis({ kind: 'unexpected-error', detail: 'boom' })).toBe('分析失敗')
  })
})

describe('shouldUploadPlan', () => {
  test('只有 kind:plan 才上傳', () => {
    expect(shouldUploadPlan({ kind: 'plan', status: 'success', planPath: '/x', summary: 's' })).toBe(true)
    expect(shouldUploadPlan({ kind: 'insufficient-spec', missing: 'x' })).toBe(false)
    expect(shouldUploadPlan({ kind: 'cross-repo', repos: ['abu'] })).toBe(false)
    expect(shouldUploadPlan({ kind: 'setup-failed', reason: 'x' })).toBe(false)
    expect(shouldUploadPlan({ kind: 'implementer-error', detail: 'x' })).toBe(false)
    expect(shouldUploadPlan({ kind: 'unexpected-error', detail: 'x' })).toBe(false)
  })
})

describe('buildNotionCommentText', () => {
  test('cross-repo 留言列出全部 repo 名稱', () => {
    const text = buildNotionCommentText('ALDREQ-1', { kind: 'cross-repo', repos: ['abu', 'agrabah'] })
    expect(text).toContain('abu')
    expect(text).toContain('agrabah')
    expect(text).toContain('2 個 repo')
  })
  test('insufficient-spec 留言帶出缺什麼', () => {
    const text = buildNotionCommentText('ALDREQ-1', { kind: 'insufficient-spec', missing: '缺驗收標準' })
    expect(text).toContain('缺驗收標準')
  })
  test('plan/success 提及 plan.md 與人工複核', () => {
    const text = buildNotionCommentText('ALDREQ-1', { kind: 'plan', status: 'success', planPath: '/x', summary: 's' })
    expect(text).toContain('plan.md')
    expect(text).toContain('人工複核')
  })
})

describe('buildTelegramText', () => {
  test('plan 結果格式極簡：已完成 + Drive 連結 + Notion 連結', () => {
    const text = buildTelegramText(
      'ALDREQ-746',
      { kind: 'plan', status: 'success', planPath: '/x', summary: 's' },
      { driveLink: 'https://drive/x', notionUrl: 'https://notion/x' },
    )
    expect(text).toContain('ALDREQ-746 已完成')
    expect(text).toContain('https://drive/x')
    expect(text).toContain('https://notion/x')
    // 不應該把完整分析內容塞進 Telegram
    expect(text.length).toBeLessThan(300)
  })

  test('plan 結果缺連結時仍不拋錯，只是少列一行', () => {
    const text = buildTelegramText('ALDREQ-746', { kind: 'plan', status: 'already-satisfied', planPath: '/x', summary: 's' }, {})
    expect(text).toContain('ALDREQ-746 已完成')
  })

  test('cross-repo 維持詳細說明（無 plan.md 可連）', () => {
    const text = buildTelegramText('ALDREQ-1', { kind: 'cross-repo', repos: ['abu', 'agrabah'] }, {})
    expect(text).toContain('跨 2 個 repo')
    expect(text).toContain('不會自動分析')
  })

  test('unexpected-error 帶警示符號', () => {
    const text = buildTelegramText('ALDREQ-1', { kind: 'unexpected-error', detail: 'boom' }, {})
    expect(text).toContain('⚠️')
    expect(text).toContain('boom')
  })
})
