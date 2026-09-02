// lib/monitor-db/runtime.test.ts — 2026-09-02 熱修回歸測試（Bug 2）：
// isWorkerProcess() 優先看 env.ts 的顯式宣告，只有未宣告時才退回舊的
// CLUSTER_WORKER_NAME 環境變數嗅探。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { __resetDeclaredMonitorRoleForTest, declareMonitorRole } from './env.ts'
import { isWorkerProcess } from './runtime.ts'

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
