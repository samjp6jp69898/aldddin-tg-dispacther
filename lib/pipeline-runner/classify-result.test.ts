import { describe, expect, test } from 'bun:test'
import { classifyPipelineResult } from './classify-result.ts'

function fakeStdout(opts: { subtype?: string; is_error?: boolean; result: string }): string {
  const resultEvent = {
    type: 'result',
    subtype: opts.subtype ?? 'success',
    is_error: opts.is_error ?? false,
    result: opts.result,
  }
  return JSON.stringify([
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } },
    resultEvent,
  ])
}

describe('classifyPipelineResult — 七種分類（T12 acceptance criteria）', () => {
  test('timeout：exit code 124（GNU timeout 逾時被殺）', () => {
    expect(classifyPipelineResult(124, '')).toBe('timeout')
  })

  test('infra_failure：exit code 非 0 且非 124', () => {
    expect(classifyPipelineResult(1, 'bash: claude: command not found')).toBe('infra_failure')
  })

  test('cli_failure：is_error=true 或 subtype 非 success', () => {
    expect(classifyPipelineResult(0, fakeStdout({ is_error: true, subtype: 'error_max_turns', result: '' }))).toBe('cli_failure')
    expect(classifyPipelineResult(0, fakeStdout({ subtype: 'error_during_execution', result: '' }))).toBe('cli_failure')
  })

  test('cli_failure：stdout 不是合法 JSON，或陣列裡找不到 type=result', () => {
    expect(classifyPipelineResult(0, 'garbage not json')).toBe('cli_failure')
    expect(classifyPipelineResult(0, JSON.stringify([{ type: 'system' }]))).toBe('cli_failure')
  })

  test('skipped：真正的早退（Step 0.1/0.5，.result 就是那一整行）', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: 'SKIPPED: FAQ-1234 not claimable' }))).toBe('skipped')
    expect(classifyPipelineResult(0, fakeStdout({ result: 'SKIPPED: already locked' }))).toBe('skipped')
    expect(classifyPipelineResult(0, fakeStdout({ result: 'SKIPPED: 當前指派不在 tech 名單' }))).toBe('skipped')
  })

  test('success：含 already_fixed / i18n_manual_handoff 子情況', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: success' }))).toBe('success')
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: already_fixed' }))).toBe('success')
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: i18n_manual_handoff' }))).toBe('success')
  })

  test('needs_qa_clarification', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: needs_qa_clarification' }))).toBe('needs_qa_clarification')
  })

  test('failed', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: failed' }))).toBe('failed')
  })

  test('unknown_failure：皆未命中', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '完全不含任何已知標記的意外輸出' }))).toBe('unknown_failure')
  })
})

describe('classifyPipelineResult — session_limit（2026-09-04 新增，低信心度 stdout 字串特徵比對）', () => {
  test('exit code 非 0 且 stdout 含已知額度用盡字串 → session_limit（優先於 infra_failure）', () => {
    expect(classifyPipelineResult(1, "Error: You've hit your session limit · resets 2am (Europe/Zurich)")).toBe('session_limit')
    expect(classifyPipelineResult(1, 'Claude usage limit reached. Resets at 2pm')).toBe('session_limit')
  })

  test('exit code 0、stdout 不是合法 JSON 但含已知字串 → session_limit（優先於 cli_failure）', () => {
    expect(classifyPipelineResult(0, "5-hour limit reached - resets 3pm (UTC)")).toBe('session_limit')
  })

  test('is_error=true 且 result 文字含已知字串 → session_limit（優先於 cli_failure）', () => {
    expect(classifyPipelineResult(0, fakeStdout({ is_error: true, subtype: 'error_during_execution', result: "You've hit your weekly limit · resets Oct 9, 10am" }))).toBe('session_limit')
    expect(classifyPipelineResult(0, fakeStdout({ is_error: true, subtype: 'error_during_execution', result: 'Credit balance is too low' }))).toBe('session_limit')
  })

  test('不該誤判：一般 rate limit（429）／暫時限流字樣不算額度用盡，仍走既有分類', () => {
    expect(classifyPipelineResult(1, 'Server is temporarily limiting requests')).toBe('infra_failure')
    expect(classifyPipelineResult(0, fakeStdout({ is_error: true, subtype: 'error_during_execution', result: 'Request rejected (429)' }))).toBe('cli_failure')
  })

  test('exitCode===124（timeout）不受 session_limit 偵測影響，仍固定回傳 timeout', () => {
    expect(classifyPipelineResult(124, "You've hit your session limit")).toBe('timeout')
  })
})

describe('classifyPipelineResult — 兩個獨立 review agent 都抓到的真實 bug 回歸測試', () => {
  test('完整報告裡的「chat_id 同步: SKIPPED」不該蓋掉真正的 Pipeline status', () => {
    const fullReportSuccess = [
      '## FAQ-1234 /create-mr Pipeline Complete',
      '- Pipeline status: success',
      '- MR(s): https://gitlab.example.com/mr/1',
      '- Notion AI分析: 分析成功',
      '- TG 通知: sent；chat_id 同步: SKIPPED',
      '- Worktree: /tmp/xxx',
    ].join('\n')
    expect(classifyPipelineResult(0, fakeStdout({ result: fullReportSuccess }))).toBe('success')

    const fullReportFailed = ['- Pipeline status: failed', '- TG 通知: sent；chat_id 同步: SKIPPED'].join('\n')
    expect(classifyPipelineResult(0, fakeStdout({ result: fullReportFailed }))).toBe('failed')

    const fullReportNeedsQa = ['- Pipeline status: needs_qa_clarification', '- TG 通知: sent；chat_id 同步: SKIPPED'].join('\n')
    expect(classifyPipelineResult(0, fakeStdout({ result: fullReportNeedsQa }))).toBe('needs_qa_clarification')
  })

  test('failure_reason 自由文字裡巧合提到 "success" 字樣不該誤判（錨定抓值天然免疫）', () => {
    const result = [
      '- Pipeline status: failed',
      '- failure_reason: 上一次 attempt 回報 Pipeline status: success 但 lint 沒過，本次重跑失敗',
    ].join('\n')
    expect(classifyPipelineResult(0, fakeStdout({ result }))).toBe('failed')
  })
})
