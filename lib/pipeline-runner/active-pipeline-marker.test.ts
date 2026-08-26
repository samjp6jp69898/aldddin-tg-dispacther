import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markPipelineActive, clearPipelineActive, getPipelineActiveSince } from './active-pipeline-marker.ts'

describe('active-pipeline-marker — 2026-08-23 review 修正：讓 stale-lock-reaper 只回收 dispatcher 自己觸發的鎖', () => {
  test('沒有標記過的 ticket → getPipelineActiveSince 回傳 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    expect(getPipelineActiveSince('FAQ-1', dir)).toBeNull()
  })

  test('markPipelineActive 後 → getPipelineActiveSince 回傳合理的 epoch ms（接近呼叫當下）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    const before = Date.now()
    markPipelineActive('FAQ-2', dir)
    const after = Date.now()
    const since = getPipelineActiveSince('FAQ-2', dir)
    expect(since).not.toBeNull()
    expect(since!).toBeGreaterThanOrEqual(before)
    expect(since!).toBeLessThanOrEqual(after)
  })

  test('clearPipelineActive 後 → getPipelineActiveSince 回傳 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('FAQ-3', dir)
    expect(getPipelineActiveSince('FAQ-3', dir)).not.toBeNull()
    clearPipelineActive('FAQ-3', dir)
    expect(getPipelineActiveSince('FAQ-3', dir)).toBeNull()
  })

  test('clearPipelineActive 對沒標記過的 ticket 是 no-op，不丟例外', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    expect(() => clearPipelineActive('FAQ-4', dir)).not.toThrow()
  })

  test('標記檔內容不是合法時間字串 → getPipelineActiveSince 回傳 null（不當成當下時間）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    writeFileSync(join(dir, 'FAQ-5'), 'garbage')
    expect(getPipelineActiveSince('FAQ-5', dir)).toBeNull()
  })

  test('不同 ticket 的標記互不影響', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('FAQ-6', dir)
    expect(getPipelineActiveSince('ALDREQ-1', dir)).toBeNull()
    clearPipelineActive('ALDREQ-1', dir) // no-op
    expect(getPipelineActiveSince('FAQ-6', dir)).not.toBeNull()
  })
})
