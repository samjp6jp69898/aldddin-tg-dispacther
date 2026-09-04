import { afterEach, describe, expect, test } from 'bun:test'
import { runIdForTrace } from './claude-exec.ts'

// MJ-12（trace 帶 runId）與 §9.0(B)（flag=0 行為逐位元組不變）的交界測試。
// `MON_RUN_ID` 由 spawn 端無條件設定（spawn-create-mr.ts / spawn-demand-pipeline.ts
// 都在 flag 之外鑄 run_id），所以「flag 關閉時不得寫這個欄位」是可證偽的關卡。

const prevFlag = process.env.MON_DB_ENABLED
const prevRunId = process.env.MON_RUN_ID

function restore(key: 'MON_DB_ENABLED' | 'MON_RUN_ID', value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore('MON_DB_ENABLED', prevFlag)
  restore('MON_RUN_ID', prevRunId)
})

describe('runIdForTrace', () => {
  test('MON_DB_ENABLED 未設 → undefined（JSON.stringify 直接略過該鍵，trace 檔逐位元組同形）', () => {
    delete process.env.MON_DB_ENABLED
    process.env.MON_RUN_ID = '11111111-1111-1111-1111-111111111111'
    expect(runIdForTrace()).toBeUndefined()
    expect(JSON.stringify({ ticket: 'FAQ-1', runId: runIdForTrace() })).toBe('{"ticket":"FAQ-1"}')
  })

  test('MON_DB_ENABLED=0 / 空字串 → 一律視為關閉（MAJOR-D2）', () => {
    process.env.MON_RUN_ID = '11111111-1111-1111-1111-111111111111'
    process.env.MON_DB_ENABLED = '0'
    expect(runIdForTrace()).toBeUndefined()
    process.env.MON_DB_ENABLED = ''
    expect(runIdForTrace()).toBeUndefined()
  })

  test('MON_DB_ENABLED=1 → 帶入 MON_RUN_ID', () => {
    process.env.MON_DB_ENABLED = '1'
    process.env.MON_RUN_ID = '22222222-2222-2222-2222-222222222222'
    expect(runIdForTrace()).toBe('22222222-2222-2222-2222-222222222222')
  })

  test('MON_DB_ENABLED=1 但 MON_RUN_ID 為空 → null（欄位存在、值為 null，collector 走 (host, ticket) 對位）', () => {
    process.env.MON_DB_ENABLED = '1'
    process.env.MON_RUN_ID = '   '
    expect(runIdForTrace()).toBeNull()
    delete process.env.MON_RUN_ID
    expect(runIdForTrace()).toBeNull()
  })
})
