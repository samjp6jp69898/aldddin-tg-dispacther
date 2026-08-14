import { describe, expect, test } from 'bun:test'
import { shouldNotify } from './post-run-notify.ts'

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
