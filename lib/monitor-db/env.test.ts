// lib/monitor-db/env.test.ts — 2026-09-02 熱修回歸測試（Bug 2）：
// 角色/host 不再嗅探 process.env.CLUSTER_WORKER_NAME，改由進入點顯式宣告。
//
// 事故：head 的 .env 殘留一個雜散的 CLUSTER_WORKER_NAME（本該是空值，只給
// worker 用），舊版 `MON_HOST = (process.env.CLUSTER_WORKER_NAME ?? '').trim() || 'head'`
// 與 runtime.ts 的 isWorkerProcess() 都只看這個變數是否非空來判斷角色，
// head 因此被誤判成 worker：monitor-db 連線要求 mon_exec 帳號，但 .env 只有
// mon_head 密碼，連線池建立失敗（loadMonitorEnv 的角色不符例外）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { __resetDeclaredMonitorRoleForTest, declareMonitorRole, getDeclaredMonitorRole } from './env.ts'
// 動態讀 MON_HOST：它是 `export let`（ESM live binding），每次直接引用
// `MON_HOST` 識別字就能看到宣告後的最新值——這裡刻意每次都重新 import 同一個
// 模組實例（bun test 同一個 process 內模組快取不變，import 多次拿到同一份）
// 確認消費端「原封不動 import { MON_HOST }」的既有用法不需要改。
import { MON_HOST as liveMonHost } from './env.ts'

describe('declareMonitorRole — 顯式宣告角色（不再嗅探 CLUSTER_WORKER_NAME）', () => {
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

  test('未宣告時（相容舊行為）：CLUSTER_WORKER_NAME 非空 → MON_HOST 是那個值（短命 CLI/測試的既有嗅探 fallback）', () => {
    process.env.CLUSTER_WORKER_NAME = 'some-worker'
    __resetDeclaredMonitorRoleForTest() // 重新求值 fallback
    expect(liveMonHost).toBe('some-worker')
    expect(getDeclaredMonitorRole()).toBeNull()
  })

  test('核心回歸案例：role=mon_head 時，就算 CLUSTER_WORKER_NAME 被污染（非空殘留），MON_HOST 仍固定為 "head"', () => {
    process.env.CLUSTER_WORKER_NAME = 'A140' // 模擬事故現場：head .env 的雜散殘留
    declareMonitorRole('mon_head')
    expect(liveMonHost).toBe('head')
    expect(getDeclaredMonitorRole()).toBe('mon_head')
  })

  test('role=mon_exec 時，MON_HOST 讀 CLUSTER_WORKER_NAME（worker 本來就該用這個值）', () => {
    process.env.CLUSTER_WORKER_NAME = 'landon2'
    declareMonitorRole('mon_exec')
    expect(liveMonHost).toBe('landon2')
    expect(getDeclaredMonitorRole()).toBe('mon_exec')
  })

  test('role=mon_exec 但 CLUSTER_WORKER_NAME 未設定/空白 → 立刻拋例外（worker 沒有其他身分來源）', () => {
    delete process.env.CLUSTER_WORKER_NAME
    expect(() => declareMonitorRole('mon_exec')).toThrow(/CLUSTER_WORKER_NAME/)
  })

  test('同一行程重複宣告成不同角色 → 拋例外（防止中途換身分）', () => {
    declareMonitorRole('mon_head')
    expect(() => declareMonitorRole('mon_exec')).toThrow(/已宣告過角色/)
  })

  test('重複宣告成同一個角色 → 允許（冪等，不拋例外）', () => {
    declareMonitorRole('mon_head')
    expect(() => declareMonitorRole('mon_head')).not.toThrow()
  })
})
