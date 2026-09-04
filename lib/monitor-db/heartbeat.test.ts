import { afterEach, describe, expect, test } from 'bun:test'
import type { ResultSetHeader } from 'mysql2/promise'
import * as W from './writes.ts'
import type { MonitorDbExecutor } from './writes.ts'
import type { SpoolWriterHandle } from './spool/writer.ts'
import { getDeclaredMonitorRole } from './env.ts'
import { beatOnce, startMonitorHeartbeat } from './heartbeat.ts'

const prevFlag = process.env.MON_DB_ENABLED

afterEach(() => {
  if (prevFlag === undefined) delete process.env.MON_DB_ENABLED
  else process.env.MON_DB_ENABLED = prevFlag
})

function header(affectedRows: number, info = ''): ResultSetHeader {
  return { affectedRows, fieldCount: 0, insertId: 0, info, serverStatus: 0, warningStatus: 0 } as unknown as ResultSetHeader
}

/** 記憶體版 monitor_heartbeat，照 writes.ts 的守衛語意（WHERE ts < ?）模擬。 */
class DupEntryError extends Error {
  code = 'ER_DUP_ENTRY'
}

class FakeHeartbeatDb implements MonitorDbExecutor {
  rows = new Map<string, { ts: string; spool_depth: number | null; spool_oldest_ts: string | null }>()
  calls: Array<{ sql: string; params: unknown[] }> = []
  failAll = false

  async execute<T = ResultSetHeader>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    this.calls.push({ sql, params })
    if (this.failAll) throw new Error('DB 不可達（測試注入）')

    if (sql === W.HEARTBEAT_UPDATE_SQL) {
      const [ts, depth, oldest, host, writer, guardTs] = params as [string, number | null, string | null, string, string, string]
      const key = `${host}|${writer}`
      const cur = this.rows.get(key)
      if (!cur) return [header(0, 'Rows matched: 0  Changed: 0  Warnings: 0') as unknown as T, []]
      if (!(cur.ts < guardTs)) return [header(0, 'Rows matched: 0  Changed: 0  Warnings: 0') as unknown as T, []]
      this.rows.set(key, { ts, spool_depth: depth, spool_oldest_ts: oldest })
      return [header(1, 'Rows matched: 1  Changed: 1  Warnings: 0') as unknown as T, []]
    }

    if (sql === W.HEARTBEAT_INSERT_SQL) {
      const [host, writer, ts, depth, oldest] = params as [string, string, string, number | null, string | null]
      // PK 是 (host, writer)：已存在就跟真的 MySQL 一樣噴 ER_DUP_ENTRY，
      // 讓 writes.ts 走「再 UPDATE 一次」的分支（守衛擋下就是 guarded）。
      if (this.rows.has(`${host}|${writer}`)) throw new DupEntryError('duplicate')
      this.rows.set(`${host}|${writer}`, { ts, spool_depth: depth, spool_oldest_ts: oldest })
      return [header(1) as unknown as T, []]
    }

    throw new Error(`FakeHeartbeatDb: 未預期的 SQL：${sql}`)
  }
}

function fakeSpool(sink: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }>, throws = false): SpoolWriterHandle {
  return {
    append: e => {
      if (throws) throw new Error('spool 不可用（測試注入）')
      sink.push({ run_id: e.run_id, fn: e.fn, args: e.args, ts: e.ts })
    },
    appendBatch: () => {},
    filePath: () => '/dev/null',
    close: () => {},
  }
}

describe('beatOnce', () => {
  test('flag 關閉 → 完全不寫、不取 pool、不碰 spool', async () => {
    delete process.env.MON_DB_ENABLED
    const db = new FakeHeartbeatDb()
    const spooled: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }> = []
    let poolAsked = 0

    const r = await beatOnce({
      writer: 'server',
      getExecutor: async () => {
        poolAsked++
        return db
      },
      getSpool: () => fakeSpool(spooled),
    })

    expect(r).toBe('disabled')
    expect(poolAsked).toBe(0)
    expect(db.calls).toHaveLength(0)
    expect(spooled).toHaveLength(0)
  })

  test('flag=1：第一拍走 UPDATE（matched=0）→ INSERT 建列；第二拍時間更新（守衛 ts < ?）', async () => {
    process.env.MON_DB_ENABLED = '1'
    const db = new FakeHeartbeatDb()
    let clock = Date.parse('2026-09-02T00:00:00.000Z')
    const deps = { writer: 'server' as const, getExecutor: async () => db, now: () => clock }

    expect(await beatOnce(deps)).toBe('written')
    expect(db.calls.map(c => c.sql)).toEqual([W.HEARTBEAT_UPDATE_SQL, W.HEARTBEAT_INSERT_SQL])
    const row = [...db.rows.entries()][0]!
    expect(row[0].endsWith('|server')).toBe(true)
    expect(row[1].ts).toBe('2026-09-02 00:00:00.000')
    // spool_depth / spool_oldest_ts 未注入 spoolStats 時一律 NULL（見模組註解）。
    expect(row[1].spool_depth).toBeNull()
    expect(row[1].spool_oldest_ts).toBeNull()

    clock += 60_000
    expect(await beatOnce(deps)).toBe('written')
    expect([...db.rows.values()][0]!.ts).toBe('2026-09-02 00:01:00.000')
  })

  test('重放舊心跳不會把時間推回過去（守衛 WHERE ts < ? 由 writes.ts 落地）', async () => {
    process.env.MON_DB_ENABLED = '1'
    const db = new FakeHeartbeatDb()
    let clock = Date.parse('2026-09-02T00:05:00.000Z')
    const deps = { writer: 'server' as const, getExecutor: async () => db, now: () => clock }
    await beatOnce(deps)

    clock = Date.parse('2026-09-02T00:00:00.000Z') // 舊時戳（模擬重放）
    await beatOnce(deps)

    expect([...db.rows.values()][0]!.ts).toBe('2026-09-02 00:05:00.000')
  })

  test('DB 不可用 → 落 spool（run_id=null、fn=upsertMonitorHeartbeat、ts 是寫入當下的絕對 ISO）', async () => {
    process.env.MON_DB_ENABLED = '1'
    const spooled: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }> = []

    const r = await beatOnce({
      writer: 'worker-agent',
      getExecutor: async () => null,
      getSpool: () => fakeSpool(spooled),
      now: () => Date.parse('2026-09-02T03:04:05.678Z'),
    })

    expect(r).toBe('spooled')
    expect(spooled).toHaveLength(1)
    expect(spooled[0]).toMatchObject({ run_id: null, fn: 'upsertMonitorHeartbeat', ts: '2026-09-02T03:04:05.678Z' })
    expect(spooled[0]!.args[0]).toMatchObject({ writer: 'worker-agent', ts: '2026-09-02T03:04:05.678Z' })
  })

  test('DB 寫入拋例外 → 一樣落 spool，且不外拋', async () => {
    process.env.MON_DB_ENABLED = '1'
    const db = new FakeHeartbeatDb()
    db.failAll = true
    const spooled: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }> = []

    const r = await beatOnce({ writer: 'log-intake', getExecutor: async () => db, getSpool: () => fakeSpool(spooled) })

    expect(r).toBe('spooled')
    expect(spooled[0]).toMatchObject({ fn: 'upsertMonitorHeartbeat', run_id: null })
  })

  test('DB 與 spool 都不可用 → 回 lost，仍然不外拋（心跳絕不影響宿主行程）', async () => {
    process.env.MON_DB_ENABLED = '1'
    const r = await beatOnce({ writer: 'server', getExecutor: async () => null, getSpool: () => fakeSpool([], true) })
    expect(r).toBe('lost')
  })

  test('取得 pool 本身拋例外 → 走 spool，不外拋', async () => {
    process.env.MON_DB_ENABLED = '1'
    const spooled: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }> = []
    const r = await beatOnce({
      writer: 'server',
      getExecutor: async () => {
        throw new Error('createPool 失敗（測試注入）')
      },
      getSpool: () => fakeSpool(spooled),
    })
    expect(r).toBe('spooled')
  })

  test('spoolStats 有注入時寫入兩個觀察欄；其本身拋例外則退回 NULL', async () => {
    process.env.MON_DB_ENABLED = '1'
    const db = new FakeHeartbeatDb()
    await beatOnce({
      writer: 'server',
      getExecutor: async () => db,
      spoolStats: () => ({ depth: 7, oldestTs: '2026-09-01T00:00:00.000Z' }),
    })
    expect([...db.rows.values()][0]).toMatchObject({ spool_depth: 7, spool_oldest_ts: '2026-09-01 00:00:00.000' })

    const db2 = new FakeHeartbeatDb()
    await beatOnce({
      writer: 'server',
      getExecutor: async () => db2,
      spoolStats: () => {
        throw new Error('boom')
      },
    })
    expect([...db2.rows.values()][0]).toMatchObject({ spool_depth: null, spool_oldest_ts: null })
  })
})

describe('startMonitorHeartbeat', () => {
  test('flag 關閉 → 不建 timer、不打第一拍', () => {
    delete process.env.MON_DB_ENABLED
    const realSetInterval = globalThis.setInterval
    let intervals = 0
    let poolAsked = 0
    // @ts-expect-error 測試用替身
    globalThis.setInterval = (...args: Parameters<typeof setInterval>) => {
      intervals++
      const t = realSetInterval(...args)
      clearInterval(t)
      return t
    }
    try {
      startMonitorHeartbeat({
        writer: 'server',
        getExecutor: async () => {
          poolAsked++
          return null
        },
      }).stop()
    } finally {
      globalThis.setInterval = realSetInterval
    }
    expect(intervals).toBe(0)
    expect(poolAsked).toBe(0)
  })

  test('flag=1 → 立刻打第一拍（§6.8(1) 啟動自檢）並註冊一個 timer', async () => {
    process.env.MON_DB_ENABLED = '1'
    const db = new FakeHeartbeatDb()
    const realSetInterval = globalThis.setInterval
    let intervals = 0
    // @ts-expect-error 測試用替身
    globalThis.setInterval = (...args: Parameters<typeof setInterval>) => {
      intervals++
      const t = realSetInterval(...args)
      clearInterval(t)
      return t
    }
    let handle: ReturnType<typeof startMonitorHeartbeat>
    try {
      handle = startMonitorHeartbeat({ writer: 'server', getExecutor: async () => db })
    } finally {
      globalThis.setInterval = realSetInterval
    }
    // 顯式 await 第一拍（handle.firstBeat），不靠等待時間。
    expect(await handle.firstBeat).toBe('written')
    handle.stop()

    expect(intervals).toBe(1)
    expect(db.calls.length).toBeGreaterThan(0)
  })
})

// 對抗性審查 B1：§6.7 的 1000ms deadline。沒有這一層時，tunnel 半開造成的
// 「query 永不 resolve」會讓 heartbeat.ts 的 catch 永遠不執行——這一拍既不
// WARN 也不落 spool，就是靜默失敗本身。
describe('beatOnce — 查詢逾時（B1 修復）', () => {
  test('pool 的 execute 永不 resolve → 走逾時路徑，落 spool，且在預算內返回', async () => {
    process.env.MON_DB_ENABLED = '1'
    const hangingPool: MonitorDbExecutor = { execute: () => new Promise(() => {}) }
    const spooled: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }> = []

    const r = await beatOnce({
      writer: 'server',
      getExecutor: async () => hangingPool,
      getSpool: () => fakeSpool(spooled),
      queryBudgetMs: 1,
    })

    expect(r).toBe('spooled')
    expect(spooled).toHaveLength(1)
    expect(spooled[0]).toMatchObject({ fn: 'upsertMonitorHeartbeat', run_id: null })
  })
})

// 總指揮 2026-09-02 裁定（依據 af 的 3782873）：角色宣告是**進入點**的責任。
// 9551686 曾在 startMonitorHeartbeat 內對 log-intake 做「未宣告才補宣告」的
// 時序性 fail-safe，已移除——長期保留會遮蔽「進入點忘了宣告」的缺陷，改為
// fail-loud（沒宣告就讓 MON_HOST 維持嗅探值，由 doctor／覆核抓出來）。
describe('startMonitorHeartbeat — 不再代為宣告角色（fail-loud）', () => {
  test('writer=log-intake 且 flag=1 時，不呼叫 declareMonitorRole（宣告狀態前後不變）', async () => {
    process.env.MON_DB_ENABLED = '1'
    const before = getDeclaredMonitorRole()
    const spooled: Array<{ run_id: string | null; fn: string; args: unknown[]; ts: string }> = []

    const handle = startMonitorHeartbeat({
      writer: 'log-intake',
      getExecutor: async () => null,
      getSpool: () => fakeSpool(spooled),
    })
    await handle.firstBeat
    handle.stop()

    expect(getDeclaredMonitorRole()).toBe(before)
  })
})
