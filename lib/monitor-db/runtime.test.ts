// lib/monitor-db/runtime.test.ts — 2026-09-02 熱修回歸測試（Bug 2）：
// isWorkerProcess() 優先看 env.ts 的顯式宣告，只有未宣告時才退回舊的
// CLUSTER_WORKER_NAME 環境變數嗅探。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { __resetDeclaredMonitorRoleForTest, declareMonitorRole } from './env.ts'
import { isWorkerProcess, closeLongLivedMonitorPool, __setMonitorPoolPromiseForTest } from './runtime.ts'

describe('isWorkerProcess — 顯式宣告優先於環境變數嗅探', () => {
  let prevWorkerName: string | undefined

  beforeEach(() => {
    prevWorkerName = process.env.CLUSTER_WORKER_NAME
    __resetDeclaredMonitorRoleForTest()
  })

  afterEach(() => {
    if (prevWorkerName === undefined) delete process.env.CLUSTER_WORKER_NAME
    else process.env.CLUSTER_WORKER_NAME = prevWorkerName
    __resetDeclaredMonitorRoleForTest()
  })

  test('未宣告時：CLUSTER_WORKER_NAME 非空 → true（舊嗅探行為，短命 CLI 相容）', () => {
    process.env.CLUSTER_WORKER_NAME = 'some-worker'
    expect(isWorkerProcess()).toBe(true)
  })

  test('未宣告時：CLUSTER_WORKER_NAME 未設定 → false', () => {
    delete process.env.CLUSTER_WORKER_NAME
    expect(isWorkerProcess()).toBe(false)
  })

  test('核心回歸案例：宣告 mon_head 後，就算 CLUSTER_WORKER_NAME 被污染（非空）也回 false', () => {
    process.env.CLUSTER_WORKER_NAME = 'A140'
    declareMonitorRole('mon_head')
    expect(isWorkerProcess()).toBe(false)
  })

  test('宣告 mon_exec 後 → true（不論環境變數當下內容，宣告優先）', () => {
    process.env.CLUSTER_WORKER_NAME = 'landon2'
    declareMonitorRole('mon_exec')
    expect(isWorkerProcess()).toBe(true)
  })
})

describe('closeLongLivedMonitorPool — B-3：短命 CLI 收掉長駐 pool 單例（review-final-A-dispatcher.md）', () => {
  afterEach(() => {
    __setMonitorPoolPromiseForTest(null)
  })

  test('pool 從未建立 → no-op、不拋出', async () => {
    __setMonitorPoolPromiseForTest(null)
    await closeLongLivedMonitorPool() // 不拋即過
  })

  test('已建立的 pool 被 end() 恰一次；再次呼叫是 no-op（冪等）', async () => {
    let ended = 0
    const fakePool = {
      execute: async (): Promise<[unknown, unknown]> => [[], []],
      end: async () => {
        ended++
      },
    }
    __setMonitorPoolPromiseForTest(Promise.resolve(fakePool as never))
    await closeLongLivedMonitorPool()
    expect(ended).toBe(1)
    await closeLongLivedMonitorPool() // promise 已被清空 → 不再 end
    expect(ended).toBe(1)
  })

  test('pool promise 解出 null（連線失敗路徑）→ no-op、不拋出', async () => {
    __setMonitorPoolPromiseForTest(Promise.resolve(null))
    await closeLongLivedMonitorPool()
  })

  test('end() 拋例外 → 吞掉只 WARN，不往外冒（呼叫端是 CLI 最尾端，沒有更好的處置）', async () => {
    const fakePool = {
      execute: async (): Promise<[unknown, unknown]> => [[], []],
      end: async () => {
        throw new Error('boom')
      },
    }
    __setMonitorPoolPromiseForTest(Promise.resolve(fakePool as never))
    await closeLongLivedMonitorPool() // 不拋即過
  })
})
