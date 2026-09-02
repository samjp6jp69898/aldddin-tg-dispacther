import { describe, expect, test } from 'bun:test'
import { createRunIdLookup, RUN_ID_LOOKUP_SQL } from './run-id-lookup.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

function fakeExecutor(rowsByKey: Map<string, { run_id: string }>, opts: { throwOnQuery?: boolean } = {}): MonitorDbExecutor {
  return {
    async execute<T>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
      if (opts.throwOnQuery) throw new Error('boom')
      expect(sql).toBe(RUN_ID_LOOKUP_SQL)
      const [host, path] = params as [string, string]
      const row = rowsByKey.get(`${host}::${path}`)
      return [(row ? [row] : []) as unknown as T, []]
    },
  }
}

describe('createRunIdLookup', () => {
  test('查到列時回傳 run_id', async () => {
    const rows = new Map([['head::/logs/a.log', { run_id: 'run-abc' }]])
    const lookup = createRunIdLookup(fakeExecutor(rows))
    expect(await lookup('head', '/logs/a.log')).toBe('run-abc')
  })

  test('對不到留空（回 null），不用檔名時戳猜', async () => {
    const rows = new Map<string, { run_id: string }>()
    const lookup = createRunIdLookup(fakeExecutor(rows))
    expect(await lookup('head', '/logs/unknown.log')).toBeNull()
  })

  test('查詢本身拋例外也回 null（best-effort 補充欄，不影響呼叫端）', async () => {
    const lookup = createRunIdLookup(fakeExecutor(new Map(), { throwOnQuery: true }))
    expect(await lookup('head', '/logs/a.log')).toBeNull()
  })

  test('SQL 依 (host, stdout_path) 查詢，不同 host 對不到不同 host 的列', async () => {
    const rows = new Map([['worker-1::/logs/a.log', { run_id: 'run-worker' }]])
    const lookup = createRunIdLookup(fakeExecutor(rows))
    expect(await lookup('head', '/logs/a.log')).toBeNull()
    expect(await lookup('worker-1', '/logs/a.log')).toBe('run-worker')
  })
})
