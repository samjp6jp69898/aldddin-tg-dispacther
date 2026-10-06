import { describe, expect, test } from 'bun:test'
import { classifyPipelineResult, extractFailureReason } from './classify-result.ts'

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

  // 2026-09-08 新增（pipeline-modes Phase 2）：「只做問題分析」模式的暫停
  // 出口，見 plan-pipeline-modes-v1.md §2.4。含 markdown 加粗/反引號變體
  // 各一，比照上方檔頭「FAQ-4616」註解說明的容忍規則。
  test('analysis_done：純文字、加粗、反引號三種寫法都要命中', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: analysis_done' }))).toBe('analysis_done')
    expect(classifyPipelineResult(0, fakeStdout({ result: '- **Pipeline status**: analysis_done' }))).toBe('analysis_done')
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status: `analysis_done`' }))).toBe('analysis_done')
  })

  // 2026-09-30（FAQ-5161 真實誤判案例）：manager 把完成報告排成 markdown 表格。
  test('表格列寫法「| Pipeline status | analysis_done |」也要命中', () => {
    const table = ['| 項目 | 內容 |', '|---|---|', '| Pipeline status | analysis_done |', '| Failure reason | N/A |'].join('\n')
    expect(classifyPipelineResult(0, fakeStdout({ result: table }))).toBe('analysis_done')
    expect(classifyPipelineResult(0, fakeStdout({ result: '| **Pipeline status** | `failed` |' }))).toBe('failed')
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

describe('extractFailureReason（2026-09-09，tracker.md 退役後續：保留失敗原因進 DB）', () => {
  test('failed 出口的「- Failure reason:」一行 → 抓出原始值', () => {
    const result = ['- Pipeline status: failed', '- Failure reason: step5 fixer 超過重試上限'].join('\n')
    expect(extractFailureReason(fakeStdout({ result }))).toBe('step5 fixer 超過重試上限')
  })

  test('容忍 markdown 裝飾（粗體標籤、反引號包值），比照 pipeline_status 同一套規則', () => {
    const result = '- **Failure reason**: `Step 1 無法產出 analytics.md`'
    expect(extractFailureReason(fakeStdout({ result }))).toBe('Step 1 無法產出 analytics.md')
  })

  test('表格列寫法「| Failure reason | 原因 |」→ 抓值且去掉尾端 |', () => {
    const result = ['| Pipeline status | failed |', '| Failure reason | step5 fixer 超過重試上限 |'].join('\n')
    expect(extractFailureReason(fakeStdout({ result }))).toBe('step5 fixer 超過重試上限')
    expect(extractFailureReason(fakeStdout({ result: '| Failure reason | N/A |' }))).toBeNull()
  })

  test('非 failed 出口的模板保留字 N/A → null，不硬填假值', () => {
    const result = ['- Pipeline status: success', '- Failure reason: N/A'].join('\n')
    expect(extractFailureReason(fakeStdout({ result }))).toBeNull()
  })

  test('完全沒有這一行（早退分支的 SKIPPED 訊息）→ null', () => {
    expect(extractFailureReason(fakeStdout({ result: 'SKIPPED: FAQ-1234 not claimable' }))).toBeNull()
  })

  test('值裡巧合出現 "success" 字樣不該被別的判斷誤用；只回傳原始字串本身', () => {
    const result = ['- Pipeline status: failed', '- Failure reason: 上一次 attempt 回報 success 但 lint 沒過'].join('\n')
    expect(extractFailureReason(fakeStdout({ result }))).toBe('上一次 attempt 回報 success 但 lint 沒過')
  })

  test('超過 500 字元截斷（runs.failure_reason 是 VARCHAR(500)）', () => {
    const longReason = 'x'.repeat(600)
    const result = `- Failure reason: ${longReason}`
    const extracted = extractFailureReason(fakeStdout({ result }))
    expect(extracted).not.toBeNull()
    expect(extracted!.length).toBeLessThanOrEqual(500)
    expect(extracted!.endsWith('...')).toBe(true)
  })
})

describe('全形冒號與機器可讀行 — FAQ-5362（2026-10-05）真實誤判案例', () => {
  // FAQ-5362 實際輸出的報告節錄：標籤加粗、冒號是全形「：」且在粗體內。
  const faq5362Report = [
    '## FAQ-5362 /create-mr Pipeline 完成',
    '- **Pipeline status：** success',
    '- **Failure reason：** N/A',
    '- **Mode：** full',
  ].join('\n')

  test('「- **Pipeline status：** success」→ success（原本落到 unknown_failure）', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: faq5362Report }))).toBe('success')
  })

  test('全形冒號搭配各種裝飾都要命中', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '- Pipeline status： analysis_done' }))).toBe('analysis_done')
    expect(classifyPipelineResult(0, fakeStdout({ result: '- **Pipeline status**： `failed`' }))).toBe('failed')
    expect(classifyPipelineResult(0, fakeStdout({ result: '| Pipeline status ： needs_qa_clarification |' }))).toBe('needs_qa_clarification')
  })

  test('PIPELINE_RESULT= 機器可讀行 → 直接採用，不依賴人類可讀行', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '完成了。\nPIPELINE_RESULT=success' }))).toBe('success')
    expect(classifyPipelineResult(0, fakeStdout({ result: 'PIPELINE_RESULT=needs_qa_clarification' }))).toBe('needs_qa_clarification')
    expect(classifyPipelineResult(0, fakeStdout({ result: 'PIPELINE_RESULT=failed  ' }))).toBe('failed')
  })

  test('機器行與人類可讀行不一致時以機器行為準', () => {
    const result = ['- Pipeline status: success', 'PIPELINE_RESULT=failed'].join('\n')
    expect(classifyPipelineResult(0, fakeStdout({ result }))).toBe('failed')
  })

  test('機器行值不是已知狀態 → unknown_failure（不誤判成功）', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: 'PIPELINE_RESULT=weird' }))).toBe('unknown_failure')
  })

  test('PIPELINE_RESULT 出現在行中間（例如引用說明文字）不算數', () => {
    expect(classifyPipelineResult(0, fakeStdout({ result: '報告尾端會輸出 PIPELINE_RESULT=success 這一行' }))).toBe('unknown_failure')
  })

  test('extractFailureReason：全形冒號 + 粗體收尾也能抓值，N/A 仍回 null', () => {
    expect(extractFailureReason(fakeStdout({ result: '- **Failure reason：** step5 fixer 超過重試上限' }))).toBe('step5 fixer 超過重試上限')
    expect(extractFailureReason(fakeStdout({ result: faq5362Report }))).toBeNull()
  })

  test('真實 FAQ-5362 stdout 形狀（JSONL，最後一行 result event）→ success', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: faq5362Report }),
    ].join('\n')
    expect(classifyPipelineResult(0, jsonl)).toBe('success')
  })
})
