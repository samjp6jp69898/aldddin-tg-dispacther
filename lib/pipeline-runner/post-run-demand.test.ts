import { describe, expect, test } from 'bun:test'
import { classifyTrapExitCode } from './post-run-demand.ts'

describe('classifyTrapExitCode（trap 側 exit code 分類，比照 classify-result.ts:83-84 的既有慣例）', () => {
  test('exitCode 0 → null（finalize() 是權威來源，trap 不補寫）', () => {
    expect(classifyTrapExitCode(0)).toBeNull()
  })
  test('exitCode 124（GNU timeout 逾時砍掉）→ timeout', () => {
    expect(classifyTrapExitCode(124)).toBe('timeout')
  })
  test('其餘非 0（如 1、143）→ infra_failure', () => {
    expect(classifyTrapExitCode(1)).toBe('infra_failure')
    expect(classifyTrapExitCode(143)).toBe('infra_failure')
  })
})
