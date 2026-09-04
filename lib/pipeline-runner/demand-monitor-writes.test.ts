// lib/pipeline-runner/demand-monitor-writes.test.ts
//
// 結構性單元測試（不打真實 DB，不 sleep 等成功；FakeRunsDb + 假 spool
// writer 注入）。涵蓋：
//   - run_id 鑄造／繼承讀取
//   - tryWriteOrSpool 的核心邏輯：成功不落 spool／同步失敗落 spool／
//     逾時落 spool（用小 budgetMs 讓逾時測試維持在毫秒級，不是「用等待
//     解決正確性問題」——這裡測的正是一個真實存在的逾時競態功能本身，
//     不是拿 sleep 去湊出某個非時間性條件）
//   - flag 關閉（MON_DB_ENABLED 未設）時，短命行程公開函式必須零副作用
//     （不丟例外、呼叫端可放心 await）
import { describe, expect, spyOn, test, afterEach } from 'bun:test'
import { FakeRunsDb } from '../monitor-db/test-support/fake-runs-db.ts'
import { W1_SQL } from '../monitor-db/writes.ts'
import { mintRunId, readInheritedRunId, tryWriteOrSpool, writeDemandOutcomeAuthoritative } from './demand-monitor-writes.ts'
import { __resetDeclaredMonitorRoleForTest, getDeclaredMonitorRole } from '../monitor-db/env.ts'
import type { SpoolEntry } from '../monitor-db/spool/types.ts'

const ORIGINAL_MON_RUN_ID = process.env.MON_RUN_ID
const ORIGINAL_MON_DB_ENABLED = process.env.MON_DB_ENABLED

afterEach(() => {
  if (ORIGINAL_MON_RUN_ID === undefined) delete process.env.MON_RUN_ID
  else process.env.MON_RUN_ID = ORIGINAL_MON_RUN_ID
  if (ORIGINAL_MON_DB_ENABLED === undefined) delete process.env.MON_DB_ENABLED
  else process.env.MON_DB_ENABLED = ORIGINAL_MON_DB_ENABLED
})

function fakeSpool() {
  const appended: Array<Omit<SpoolEntry, 'seq'>> = []
  return {
    handle: {
      append: (entry: Omit<SpoolEntry, 'seq'>) => {
        appended.push(entry)
      },
      appendBatch: (entries: Array<Omit<SpoolEntry, 'seq'>>) => {
        appended.push(...entries)
      },
      filePath: () => '/tmp/fake-spool.jsonl',
      close: () => {},
    },
    appended,
  }
}

describe('mintRunId／readInheritedRunId', () => {
  test('mintRunId 回傳合法 UUID v4 格式，且每次呼叫不同', () => {
    const a = mintRunId()
    const b = mintRunId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(a).not.toBe(b)
  })

  test('MON_RUN_ID 未設定 → null', () => {
    delete process.env.MON_RUN_ID
    expect(readInheritedRunId()).toBeNull()
  })

  test('MON_RUN_ID 為空字串／純空白 → null', () => {
    process.env.MON_RUN_ID = '   '
    expect(readInheritedRunId()).toBeNull()
  })

  test('MON_RUN_ID 有值 → 回傳去除頭尾空白後的值', () => {
    process.env.MON_RUN_ID = '  run-abc-123  '
    expect(readInheritedRunId()).toBe('run-abc-123')
  })
})

describe('tryWriteOrSpool（核心邏輯，注入 FakeRunsDb + 假 spool）', () => {
  test('寫入成功 → 不落 spool', async () => {
    const db = new FakeRunsDb()
    const { handle, appended } = fakeSpool()
    await tryWriteOrSpool({
      budgetMs: 1000,
      pool: db,
      spool: handle,
      runId: 'run-1',
      fn: 'writeRunProgress',
      args: [{ runId: 'run-1' }],
      attempt: async pool => {
        await pool.execute(W1_SQL, ['run-1', 'head', 'ALDREQ-1', 'demand', 30, null, 111, null, null, null, null, null])
      },
      onFailLabel: 'test',
    })
    expect(appended).toHaveLength(0)
    expect(db.rows.has('run-1')).toBe(true)
  })

  test('attempt 同步丟例外 → 落 spool，條目帶正確的 run_id/fn/args', async () => {
    const { handle, appended } = fakeSpool()
    await tryWriteOrSpool({
      budgetMs: 1000,
      pool: new FakeRunsDb(),
      spool: handle,
      runId: 'run-err',
      fn: 'writeRunOutcomeAuthoritative',
      args: [{ runId: 'run-err', outcome: 'spawn_error' }],
      attempt: async () => {
        throw new Error('DB 連不上')
      },
      onFailLabel: 'test-fail',
    })
    expect(appended).toHaveLength(1)
    expect(appended[0]!.run_id).toBe('run-err')
    expect(appended[0]!.fn).toBe('writeRunOutcomeAuthoritative')
    expect(appended[0]!.args).toEqual([{ runId: 'run-err', outcome: 'spawn_error' }])
    expect(typeof appended[0]!.ts).toBe('string')
  })

  test('attempt 逾時未 resolve（小 budgetMs）→ 落 spool', async () => {
    const { handle, appended } = fakeSpool()
    await tryWriteOrSpool({
      budgetMs: 15,
      pool: new FakeRunsDb(),
      spool: handle,
      runId: 'run-slow',
      fn: 'writeRunProgress',
      args: [],
      attempt: () => new Promise(() => {}), // 永不 resolve
      onFailLabel: 'test-timeout',
    })
    expect(appended).toHaveLength(1)
    expect(appended[0]!.run_id).toBe('run-slow')
  })

  test('DB 與 spool 都失敗 → 不拋出（best-effort，只記 log）', async () => {
    const brokenSpool = {
      append: () => {
        throw new Error('磁碟滿')
      },
      appendBatch: () => {},
      filePath: () => '/tmp/x',
      close: () => {},
    }
    await expect(
      tryWriteOrSpool({
        budgetMs: 10,
        pool: new FakeRunsDb(),
        spool: brokenSpool,
        runId: 'run-doom',
        fn: 'writeRunProgress',
        args: [],
        attempt: async () => {
          throw new Error('DB 也壞了')
        },
        onFailLabel: 'test-both-fail',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('flag 關閉（MON_DB_ENABLED 未設）→ 公開函式零副作用', () => {
  test('writeDemandOutcomeAuthoritative 直接 resolve，不建立任何連線', async () => {
    delete process.env.MON_DB_ENABLED
    await expect(
      writeDemandOutcomeAuthoritative(
        { runId: 'r1', ticket: 'ALDREQ-1', outcome: 'success', outcomeSource: 'test', finishedAt: new Date().toISOString() },
        { writerName: 'cli' },
      ),
    ).resolves.toBeUndefined()
  })
})

// 2026-09-04 回歸測試（ALDREQ-834 事故）：本檔的兩個實際呼叫端
// （post-run-demand.ts 的 trap 側、run-demand-pipeline.ts 的 finalize()）
// 不是固定只在 head 機器上跑——dispatch.ts 的派工機制會把 demand pipeline
// 派去 worker 執行。writeDemandOutcomeAuthoritative 曾在最早執行點顯式寫死
// declareMonitorRole('mon_head')，worker 上 .env 的 MON_DB_USER 卻是
// mon_exec，跟寫死值不符，loadMonitorEnv 的 expectedRole 斷言必然拋出、被
// best-effort 吞掉，權威結果永遠寫不進 DB。現已改用
// declareMonitorRoleFromLocalEnv()（見 env.ts），依本機 .env 的 MON_DB_USER
// 判斷角色，不猜。
describe('writeDemandOutcomeAuthoritative — 依本機 .env 宣告角色，不再寫死 mon_head', () => {
  test('ALDREQ-834 核心回歸案例：worker 環境（MON_DB_USER=mon_exec）→ 正確宣告 mon_exec，不再被寫死宣告成 mon_head', async () => {
    const prevEnabled = process.env.MON_DB_ENABLED
    const prevUser = process.env.MON_DB_USER
    const prevWorker = process.env.CLUSTER_WORKER_NAME
    const prevHost = process.env.MON_DB_HOST
    __resetDeclaredMonitorRoleForTest()
    process.env.MON_DB_ENABLED = '1'
    process.env.MON_DB_USER = 'mon_exec' // 真實案例：landon2 的 .env
    process.env.CLUSTER_WORKER_NAME = 'landon2'
    // 故意指到不可路由的位址：這則測試只關心角色宣告本身是否正確，不依賴
    // 任何真的 monitor DB 是否在跑——pool.ts 的 connectTimeout（500ms）讓
    // 連線嘗試確定性地快速失敗，不是靠等待解決正確性問題。
    process.env.MON_DB_HOST = '10.255.255.1'
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        writeDemandOutcomeAuthoritative(
          { runId: 'run-role-check', ticket: 'ALDREQ-834', outcome: 'success', outcomeSource: 'test', finishedAt: new Date().toISOString() },
          { writerName: 'cli' },
        ),
      ).resolves.toBeUndefined() // 全程 best-effort：即使連線建立失敗也不拋出
      // 核心斷言：角色正確解析為 mon_exec（跟本機 MON_DB_USER 一致）——這正是
      // ALDREQ-834 的根因修復，舊版寫死 mon_head 這裡會斷言失敗。
      expect(getDeclaredMonitorRole()).toBe('mon_exec')
      // 連帶證明：不再出現「角色不符」這種自我矛盾的例外（舊 bug 的症狀，
      // 由呼叫端自己寫死的角色跟 .env 打架造成，不是真的連線問題）。
      const loggedMessages = errorSpy.mock.calls.map(args => String(args[0]))
      expect(loggedMessages.some(m => m.includes('角色不符'))).toBe(false)
    } finally {
      errorSpy.mockRestore()
      if (prevEnabled === undefined) delete process.env.MON_DB_ENABLED
      else process.env.MON_DB_ENABLED = prevEnabled
      if (prevUser === undefined) delete process.env.MON_DB_USER
      else process.env.MON_DB_USER = prevUser
      if (prevWorker === undefined) delete process.env.CLUSTER_WORKER_NAME
      else process.env.CLUSTER_WORKER_NAME = prevWorker
      if (prevHost === undefined) delete process.env.MON_DB_HOST
      else process.env.MON_DB_HOST = prevHost
      __resetDeclaredMonitorRoleForTest()
    }
  })
})
