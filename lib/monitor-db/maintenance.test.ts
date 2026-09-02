// lib/monitor-db/maintenance.test.ts — 2026-09-02 熱修回歸測試（Bug 1）。
//
// 事故：logs/spool/ 目錄在任何寫入者真的 append 過一筆之前不存在；
// acquireReplayerLock 用 O_CREAT|O_EXCL 開 .replayer.lock，不會建父目錄，
// ENOENT 未被捕捉，直接讓 server.ts:244 的頂層呼叫拋出 → launchd crash loop。
// 兩層修法都要驗：(1) acquireReplayerLock 本身自己 mkdir（見
// spool/replayer-lock.test.ts 的專屬回歸測試）；(2) 結構性防護——
// startMonitorMaintenance 的任何失敗只 WARN + 回一個安全的 no-op handle，
// 絕不允許讓呼叫端（server.ts/worker-agent.ts 的開機路徑）的例外往外炸。
// 本檔驗證 (2)，並在整合層面重現一次「目錄不存在」的原始情境確認不再炸。
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMonitorMaintenance } from './maintenance.ts'
import { __resetMonitorTestOverrides, __setMonitorTestOverrides } from './runtime.ts'
import { FakeRunsDb } from './test-support/fake-runs-db.ts'

function tmpParentDir(): string {
  return mkdtempSync(join(tmpdir(), 'monitor-maintenance-test-'))
}

describe('startMonitorMaintenance — 2026-09-02 熱修回歸（Bug 1）', () => {
  let prevFlag: string | undefined
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    prevFlag = process.env.MON_DB_ENABLED
    process.env.MON_DB_ENABLED = '1'
    __setMonitorTestOverrides({ pool: new FakeRunsDb() })
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.MON_DB_ENABLED = prevFlag
    __resetMonitorTestOverrides()
    errorSpy.mockRestore()
  })

  test('回歸：spool 目錄本身不存在（模擬事故現場）→ boot 成功（不拋例外），目錄被自動建立', () => {
    const parent = tmpParentDir()
    const neverCreatedSpoolDir = join(parent, 'spool')
    expect(existsSync(neverCreatedSpoolDir)).toBe(false)

    let handle: ReturnType<typeof startMonitorMaintenance> | undefined
    expect(() => {
      handle = startMonitorMaintenance({ isTicketActive: () => false, spoolDir: neverCreatedSpoolDir })
    }).not.toThrow()

    expect(handle).toBeDefined()
    expect(existsSync(neverCreatedSpoolDir)).toBe(true) // acquireReplayerLock 的 mkdirSync 修法生效
    handle!.stop()
    rmSync(parent, { recursive: true, force: true })
  })

  test('結構性防護：spoolDir 指到一個檔案（非目錄，mkdirSync 會拋 ENOTDIR）→ 仍不拋例外，只 WARN 並回可用的 no-op handle', () => {
    const parent = tmpParentDir()
    const notADir = join(parent, 'this-is-a-file')
    writeFileSync(notADir, 'x')

    let handle: ReturnType<typeof startMonitorMaintenance> | undefined
    expect(() => {
      handle = startMonitorMaintenance({ isTicketActive: () => false, spoolDir: notADir })
    }).not.toThrow()

    expect(handle).toBeDefined()
    expect(() => handle!.stop()).not.toThrow() // no-op handle 的 stop() 必須安全可呼叫
    expect(errorSpy).toHaveBeenCalled() // 有留下 WARN 級 log，不是靜默吞掉
    rmSync(parent, { recursive: true, force: true })
  })

  test('isMonitorDbEnabled()=false → 完全是 no-op，不建目錄也不呼叫 acquireReplayerLock', () => {
    process.env.MON_DB_ENABLED = '0'
    const parent = tmpParentDir()
    const spoolDir = join(parent, 'spool')
    const handle = startMonitorMaintenance({ isTicketActive: () => false, spoolDir })
    expect(existsSync(spoolDir)).toBe(false)
    expect(() => handle.stop()).not.toThrow()
    rmSync(parent, { recursive: true, force: true })
  })
})
