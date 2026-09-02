import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markPipelineActive, clearPipelineActive, getPipelineActiveSince, readRunIdFromActiveMarker } from './active-pipeline-marker.ts'

const SOME_UUID = '11111111-2222-3333-4444-555555555555'

describe('active-pipeline-marker — 2026-08-23 review 修正：讓 stale-lock-reaper 只回收 dispatcher 自己觸發的鎖', () => {
  test('沒有標記過的 ticket → getPipelineActiveSince 回傳 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    expect(getPipelineActiveSince('FAQ-1', dir)).toBeNull()
  })

  test('markPipelineActive 後 → getPipelineActiveSince 回傳合理的 epoch ms（接近呼叫當下）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    const before = Date.now()
    markPipelineActive('FAQ-2', { dir })
    const after = Date.now()
    const since = getPipelineActiveSince('FAQ-2', dir)
    expect(since).not.toBeNull()
    expect(since!).toBeGreaterThanOrEqual(before)
    expect(since!).toBeLessThanOrEqual(after)
  })

  test('clearPipelineActive 後 → getPipelineActiveSince 回傳 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('FAQ-3', { dir })
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
    markPipelineActive('FAQ-6', { dir })
    expect(getPipelineActiveSince('ALDREQ-1', dir)).toBeNull()
    clearPipelineActive('ALDREQ-1', dir) // no-op
    expect(getPipelineActiveSince('FAQ-6', dir)).not.toBeNull()
  })
})

describe('active-pipeline-marker — v3.2 §6.4(4) R2：JSON 格式 {startedAt, runId, kind} 與 readRunIdFromActiveMarker', () => {
  test('帶 runId/kind 時寫成 JSON；getPipelineActiveSince 仍能正確解出 startedAt（新格式相容）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    const before = Date.now()
    markPipelineActive('FAQ-10', { dir, runId: SOME_UUID, kind: 'bug' })
    const after = Date.now()
    const since = getPipelineActiveSince('FAQ-10', dir)
    expect(since).not.toBeNull()
    expect(since!).toBeGreaterThanOrEqual(before)
    expect(since!).toBeLessThanOrEqual(after)
  })

  test('readRunIdFromActiveMarker：kind 相符且 runId 合法 UUID → 回傳該 runId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('FAQ-11', { dir, runId: SOME_UUID, kind: 'bug' })
    expect(readRunIdFromActiveMarker('bug', 'FAQ-11', dir)).toBe(SOME_UUID)
  })

  test('readRunIdFromActiveMarker：kind 不符 → 回傳 null（不信任跨 kind 的標記）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('ALDREQ-12', { dir, runId: SOME_UUID, kind: 'demand' })
    expect(readRunIdFromActiveMarker('bug', 'ALDREQ-12', dir)).toBeNull()
  })

  test('readRunIdFromActiveMarker：沒有標記過 → 回傳 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    expect(readRunIdFromActiveMarker('bug', 'FAQ-13', dir)).toBeNull()
  })

  test('readRunIdFromActiveMarker：舊格式（純 ISO 字串，沒有 runId）→ 回傳 null，不拋例外', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('FAQ-14', { dir }) // 沒帶 runId/kind → 退回舊格式
    expect(readRunIdFromActiveMarker('bug', 'FAQ-14', dir)).toBeNull()
    // 舊格式下 getPipelineActiveSince 仍要正確工作（相容性沒有被破壞）。
    expect(getPipelineActiveSince('FAQ-14', dir)).not.toBeNull()
  })

  test('readRunIdFromActiveMarker：runId 不是合法 UUID 格式（標記檔被竄改）→ 回傳 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'FAQ-15'), JSON.stringify({ startedAt: new Date().toISOString(), runId: 'not-a-uuid', kind: 'bug' }))
    expect(readRunIdFromActiveMarker('bug', 'FAQ-15', dir)).toBeNull()
  })

  test('markPipelineActive 沒帶 runId（只帶 kind）→ 退回舊格式純 ISO 字串（兩者缺一都不算新格式）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-test-'))
    markPipelineActive('FAQ-16', { dir, kind: 'bug' })
    expect(readRunIdFromActiveMarker('bug', 'FAQ-16', dir)).toBeNull()
    expect(getPipelineActiveSince('FAQ-16', dir)).not.toBeNull()
  })
})
