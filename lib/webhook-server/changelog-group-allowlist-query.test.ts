import { describe, expect, test } from 'bun:test'
import { QUERY_TIMEOUT_MS, queryChangelogGroupAllowed, type AllowlistQueryExecutor } from './changelog-group-allowlist-query.ts'

// isChangelogGroupChat 的 DB 實作：每次呼叫都真的查一次（不快取）、查詢失敗視同不允許、
// 非群組格式的 chat_id 直接 false 不打 DB。以注入的假 executor 控制回傳，不連真 DB。

type Call = { sql: string; timeout: unknown; params: unknown }

function fakeExecutor(handler: (params: unknown[]) => unknown[] | Error) {
  const calls: Call[] = []
  const executor = {
    query: async (opts: { sql: string; timeout?: number }, params: unknown[]) => {
      calls.push({ sql: opts.sql, timeout: opts.timeout, params })
      const out = handler(params)
      if (out instanceof Error) throw out
      return [out, []]
    },
  } as unknown as AllowlistQueryExecutor
  return { get: async () => executor, calls }
}

describe('queryChangelogGroupAllowed', () => {
  test('有啟用中的列 → true，查詢帶 chat_id 參數、enabled=1 條件與逾時', async () => {
    const { get, calls } = fakeExecutor(() => [{ 1: 1 }])
    expect(await queryChangelogGroupAllowed(get, '-1001234567890')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual(['-1001234567890'])
    expect(calls[0]!.sql).toContain('enabled = 1')
    expect(calls[0]!.timeout).toBe(QUERY_TIMEOUT_MS)
  })

  test('查無列（未加入或已停用）→ false', async () => {
    const { get } = fakeExecutor(() => [])
    expect(await queryChangelogGroupAllowed(get, '-1001234567890')).toBe(false)
  })

  test('每則訊息都重新查：後台改動在下一次呼叫立即生效', async () => {
    const allowed = new Set<string>()
    const { get, calls } = fakeExecutor(params => (allowed.has(String(params[0])) ? [{ 1: 1 }] : []))
    expect(await queryChangelogGroupAllowed(get, '-1009')).toBe(false)
    allowed.add('-1009') // 模擬後台新增
    expect(await queryChangelogGroupAllowed(get, '-1009')).toBe(true)
    allowed.delete('-1009') // 模擬後台刪除／停用
    expect(await queryChangelogGroupAllowed(get, '-1009')).toBe(false)
    expect(calls).toHaveLength(3)
  })

  test('DB 查詢例外 → false，不往外拋', async () => {
    const { get } = fakeExecutor(() => new Error('connect ECONNREFUSED 127.0.0.1:3306'))
    expect(await queryChangelogGroupAllowed(get, '-1001234567890')).toBe(false)
  })

  test('建 pool 失敗（例如缺 MON_DB_* 環境變數）→ false，不往外拋', async () => {
    const get = async (): Promise<AllowlistQueryExecutor> => {
      throw new Error('loadMonitorEnv: 缺少必要環境變數：MON_DB_HOST')
    }
    expect(await queryChangelogGroupAllowed(get, '-1001234567890')).toBe(false)
  })

  test('非群組格式的 chat_id（正數、非數字）→ false 且不打 DB', async () => {
    const { get, calls } = fakeExecutor(() => [{ 1: 1 }])
    expect(await queryChangelogGroupAllowed(get, '5022865804')).toBe(false)
    expect(await queryChangelogGroupAllowed(get, '-1 OR 1=1')).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
