import { describe, expect, test } from 'bun:test'
import {
  classifyAiAnalysis,
  buildNotionCommentText,
  buildTelegramText,
  shouldUploadPlan,
  demandOutcomeToRunsOutcome,
  type DemandOutcome,
} from './demand-finalize.ts'

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

describe('demandOutcomeToRunsOutcome（監控 DB 化：runs.outcome 結構化值域）', () => {
  test('plan/success → success', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'plan', status: 'success', planPath: '/x', summary: 's' })).toBe('success')
  })
  test('plan/already-satisfied → already_satisfied', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'plan', status: 'already-satisfied', planPath: '/x', summary: 's' })).toBe('already_satisfied')
  })
  test('plan/needs-clarification → needs_clarification', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'plan', status: 'needs-clarification', planPath: '/x', summary: 's' })).toBe('needs_clarification')
  })
  test('insufficient-spec → insufficient_spec', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'insufficient-spec', missing: 'x' })).toBe('insufficient_spec')
  })
  test('setup-failed → setup_failed', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'setup-failed', reason: 'x' })).toBe('setup_failed')
  })
  test('implementer-error → implementer_error', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'implementer-error', detail: 'x' })).toBe('implementer_error')
  })
  test('unexpected-error → unexpected_error', () => {
    expect(demandOutcomeToRunsOutcome({ kind: 'unexpected-error', detail: 'x' })).toBe('unexpected_error')
  })
  test('值域彼此互異（不允許兩個 DemandOutcome 分支對映到同一個 runs.outcome 字串）', () => {
    const outcomes: DemandOutcome[] = [
      { kind: 'plan', status: 'success', planPath: '/x', summary: 's' },
      { kind: 'plan', status: 'already-satisfied', planPath: '/x', summary: 's' },
      { kind: 'plan', status: 'needs-clarification', planPath: '/x', summary: 's' },
      { kind: 'insufficient-spec', missing: 'x' },
      { kind: 'setup-failed', reason: 'x' },
      { kind: 'implementer-error', detail: 'x' },
      { kind: 'unexpected-error', detail: 'x' },
    ]
    const mapped = outcomes.map(demandOutcomeToRunsOutcome)
    expect(new Set(mapped).size).toBe(mapped.length)
  })
})

describe('shouldUploadPlan', () => {
  test('只有 kind:plan 才上傳', () => {
    expect(shouldUploadPlan({ kind: 'plan', status: 'success', planPath: '/x', summary: 's' })).toBe(true)
    expect(shouldUploadPlan({ kind: 'insufficient-spec', missing: 'x' })).toBe(false)
    expect(shouldUploadPlan({ kind: 'setup-failed', reason: 'x' })).toBe(false)
    expect(shouldUploadPlan({ kind: 'implementer-error', detail: 'x' })).toBe(false)
    expect(shouldUploadPlan({ kind: 'unexpected-error', detail: 'x' })).toBe(false)
  })
})

describe('buildNotionCommentText', () => {
  test('insufficient-spec 留言帶出缺什麼', () => {
    const text = buildNotionCommentText('ALDREQ-1', { kind: 'insufficient-spec', missing: '缺驗收標準' })
    expect(text).toContain('缺驗收標準')
  })
  test('plan/success 提及 plan.md 與人工複核', () => {
    const text = buildNotionCommentText('ALDREQ-1', { kind: 'plan', status: 'success', planPath: '/x', summary: 's' })
    expect(text).toContain('plan.md')
    expect(text).toContain('人工複核')
  })

  // 2026-09-16 使用者要求：head/worker 本機的執行錯誤（本機路徑、指令行、
  // stack）不得出現在 Notion 留言——同事只需要知道「環境內部錯誤、本次結果
  // 無效、維運排除後會重跑」。完整錯誤照舊走 Telegram（buildTelegramText）
  // 通知維運者本人。實例：ALDREQ-881 曾把整段 claude-p-rate-watch.sh 指令行
  // 與 Error: Command failed 貼上 Notion。
  test('技術性失敗（setup/implementer/unexpected）留言不得洩漏本機錯誤細節', () => {
    const detail = 'Error: Command failed: /Users/user/aladdin/scripts/claude-p-rate-watch.sh -p --model sonnet\nError: Input must be provided either through stdin'
    const outcomes = [
      { kind: 'setup-failed', reason: detail },
      { kind: 'implementer-error', detail },
      { kind: 'unexpected-error', detail },
    ] as const
    for (const outcome of outcomes) {
      const text = buildNotionCommentText('ALDREQ-881', outcome)
      expect(text).toContain('ALDREQ-881')
      expect(text).not.toContain('/Users/user')
      expect(text).not.toContain('Command failed')
      expect(text).not.toContain('claude-p-rate-watch')
    }
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

  test('unexpected-error 帶警示符號', () => {
    const text = buildTelegramText('ALDREQ-1', { kind: 'unexpected-error', detail: 'boom' }, {})
    expect(text).toContain('⚠️')
    expect(text).toContain('boom')
  })
})
