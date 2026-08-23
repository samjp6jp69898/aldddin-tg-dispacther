import { describe, expect, mock, test } from 'bun:test'
import { checkPushMismatch, shouldNotify } from './post-run-notify.ts'

describe('shouldNotify — T13 補發通知範圍（2026-08-14 使用者定案，見 tasks.json changelog）', () => {
  test('create-mr 自己已通知/已留言過的三類，不重複發', () => {
    expect(shouldNotify('success')).toBe(false)
    expect(shouldNotify('needs_qa_clarification')).toBe(false)
    expect(shouldNotify('failed')).toBe(false)
  })

  test('create-mr 完全沒機會通知的四類，補發', () => {
    expect(shouldNotify('skipped')).toBe(true)
    expect(shouldNotify('unknown_failure')).toBe(true)
    expect(shouldNotify('infra_failure')).toBe(true)
    expect(shouldNotify('cli_failure')).toBe(true)
  })
})

describe('checkPushMismatch — 2026-08-23：pipeline 回報 success 但 Notion AI分析=分析失敗 時通知 Landon', () => {
  test('classification 不是 success → 完全不查 Notion、不通知（例如 failed 自己就會走既有的補發判準)', () => {
    const getAiAnalysisStatus = mock((_t: string) => '分析失敗')
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-1', 'failed', 'out.log', 'err.log', { getAiAnalysisStatus, notify })
    expect(getAiAnalysisStatus).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  test('success 且 Notion AI分析=分析成功（一致）→ 不通知', () => {
    const getAiAnalysisStatus = mock((_t: string) => '分析成功')
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-1', 'success', 'out.log', 'err.log', { getAiAnalysisStatus, notify })
    expect(notify).not.toHaveBeenCalled()
  })

  test('success 但 Notion AI分析=分析失敗（不一致）→ 通知 Landon，內容含 ticket 與 log 路徑', () => {
    const getAiAnalysisStatus = mock((_t: string) => '分析失敗')
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-9999', 'success', '/tmp/x.stdout.log', '/tmp/x.stderr.log', { getAiAnalysisStatus, notify })
    expect(notify).toHaveBeenCalledTimes(1)
    const text = notify.mock.calls[0]![0]
    expect(text).toContain('FAQ-9999')
    expect(text).toContain('/tmp/x.stdout.log')
    expect(text).toContain('/tmp/x.stderr.log')
  })

  test('查詢 Notion 本身丟例外 → 只吞掉，不讓例外炸穿（best-effort，不阻斷 trap 裡的其他收尾）', () => {
    const getAiAnalysisStatus = mock((_t: string) => {
      throw new Error('Notion API 掛了')
    })
    const notify = mock((_t: string) => true)
    expect(() => checkPushMismatch('FAQ-1', 'success', 'out.log', 'err.log', { getAiAnalysisStatus, notify })).not.toThrow()
    expect(notify).not.toHaveBeenCalled()
  })

  test('查無 AI分析（null）→ 不通知（沒有明確不一致證據就不誤報）', () => {
    const getAiAnalysisStatus = mock((_t: string) => null)
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-1', 'success', 'out.log', 'err.log', { getAiAnalysisStatus, notify })
    expect(notify).not.toHaveBeenCalled()
  })
})
