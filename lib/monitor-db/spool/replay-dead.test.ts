import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpoolEntry } from './types.ts'
import { replayDeadFile } from './replay-dead.ts'

function tmpDeadFile(entries: Array<SpoolEntry & { dead_reason?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'spool-dead-test-'))
  const path = join(dir, 'server.100.1000.dead.jsonl')
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return path
}

describe('replayDeadFile', () => {
  test('檔案不存在 → 回傳全零結果，不拋例外', async () => {
    const result = await replayDeadFile('/tmp/does-not-exist-dead-file.jsonl', { applyEntry: async () => ({ ok: true }) })
    expect(result).toEqual({ succeeded: 0, remaining: 0, failures: [] })
  })

  test('全部成功 → 全部從檔案移除，檔案本身被刪除', async () => {
    const path = tmpDeadFile([
      { seq: 1, ts: 't1', host: 'h', run_id: 'r1', fn: 'f', args: [] },
      { seq: 2, ts: 't2', host: 'h', run_id: 'r2', fn: 'f', args: [] },
    ])
    const result = await replayDeadFile(path, { applyEntry: async () => ({ ok: true }) })
    expect(result).toEqual({ succeeded: 2, remaining: 0, failures: [] })
    expect(existsSync(path)).toBe(false)
  })

  test('部分失敗 → 成功的移除、失敗的保留並記錄原因，檔案仍存在（可重跑）', async () => {
    const path = tmpDeadFile([
      { seq: 1, ts: 't1', host: 'h', run_id: 'r1', fn: 'ok', args: [] },
      { seq: 2, ts: 't2', host: 'h', run_id: 'r2', fn: 'still-broken', args: [] },
    ])
    const result = await replayDeadFile(path, {
      applyEntry: async e => (e.fn === 'ok' ? { ok: true } : { ok: false, reason: 'still-broken-reason' }),
    })
    expect(result.succeeded).toBe(1)
    expect(result.remaining).toBe(1)
    expect(result.failures).toEqual([{ seq: 2, reason: 'still-broken-reason' }])
    expect(existsSync(path)).toBe(true)
    const remainingLine = readFileSync(path, 'utf8').trim()
    const parsed = JSON.parse(remainingLine)
    expect(parsed.run_id).toBe('r2')
    expect(parsed.dead_reason).toBe('still-broken-reason')
  })

  test('冪等可重跑：對同一份殘餘檔再跑一次，結果與檔案狀態一致（不會憑空多出或少掉條目）', async () => {
    const path = tmpDeadFile([{ seq: 1, ts: 't1', host: 'h', run_id: 'r1', fn: 'still-broken', args: [] }])
    let attempt = 0
    const applyEntry = async () => {
      attempt += 1
      return attempt < 3 ? { ok: false, reason: `try-${attempt}` } : { ok: true }
    }
    const first = await replayDeadFile(path, { applyEntry })
    expect(first.remaining).toBe(1)
    const second = await replayDeadFile(path, { applyEntry })
    expect(second.remaining).toBe(1)
    const third = await replayDeadFile(path, { applyEntry })
    expect(third.succeeded).toBe(1)
    expect(third.remaining).toBe(0)
    expect(existsSync(path)).toBe(false)
  })

  test('壞行（無法解析的 JSON）原樣保留，不憑空丟資料', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-dead-badline-'))
    const path = join(dir, 'server.100.1000.dead.jsonl')
    writeFileSync(path, `${JSON.stringify({ seq: 1, ts: 't', host: 'h', run_id: 'r1', fn: 'ok', args: [] })}\nnot-json\n`)
    const result = await replayDeadFile(path, { applyEntry: async () => ({ ok: true }) })
    expect(result.succeeded).toBe(1)
    expect(result.remaining).toBe(1)
    expect(readFileSync(path, 'utf8').trim()).toBe('not-json')
  })
})
