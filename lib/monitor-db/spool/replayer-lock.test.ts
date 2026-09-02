import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireReplayerLock, releaseReplayerLock } from './replayer-lock.ts'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spool-lock-test-'))
}

describe('acquireReplayerLock', () => {
  test('鎖檔不存在 → 建檔成功，內容記著 pid/writer/startedAt', () => {
    const dir = tmpDir()
    const result = acquireReplayerLock(dir, 'server', 100, {
      isPidAlive: () => true,
      readProcStartMs: () => 5000,
    })
    expect(result).toEqual({ ok: true })
    const content = JSON.parse(readFileSync(join(dir, '.replayer.lock'), 'utf8'))
    expect(content).toEqual({ pid: 100, writer: 'server', startedAt: 5000 })
  })

  test('2026-09-02 熱修回歸測試：spool 目錄本身不存在（O_CREAT|O_EXCL 不會建父目錄）→ 不拋 ENOENT，自動建目錄後成功取鎖', () => {
    // 刻意不預先 mkdir——舊版程式碼在這裡會拋 ENOENT（見 acquireReplayerLock
    // 的 openSync 呼叫），未被 maintenance.ts 捕捉時會讓 server.ts/
    // worker-agent.ts 開機直接 crash（launchd crash loop 的真實事故）。
    const parent = tmpDir()
    const neverCreatedDir = join(parent, 'spool') // 不存在，acquireReplayerLock 必須自己建
    expect(existsSync(neverCreatedDir)).toBe(false)
    const result = acquireReplayerLock(neverCreatedDir, 'server', 100, {
      isPidAlive: () => true,
      readProcStartMs: () => 5000,
    })
    expect(result).toEqual({ ok: true })
    expect(existsSync(neverCreatedDir)).toBe(true)
    const content = JSON.parse(readFileSync(join(neverCreatedDir, '.replayer.lock'), 'utf8'))
    expect(content).toEqual({ pid: 100, writer: 'server', startedAt: 5000 })
  })

  test('【Phase 1.4 測試 5】重放者互斥：第二個重放者啟動時取不到鎖 → 不重放、回報 ERROR', () => {
    const dir = tmpDir()
    const first = acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    expect(first.ok).toBe(true)

    // 第二個重放者：同一份 readProcStartMs 對「原持有者的 pid」回一樣的
    // startedAt(=5000)，代表 ps -p 100 現在查到的仍是同一個行程 → 真的活著。
    const second = acquireReplayerLock(dir, 'server', 200, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    expect(second).toEqual({ ok: false, reason: 'held_alive' })
  })

  test('鎖檔存在但 pid 已死 → 接管並覆寫鎖檔', () => {
    const dir = tmpDir()
    acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    const takeover = acquireReplayerLock(dir, 'server', 200, {
      isPidAlive: (pid: number) => pid !== 100, // 100 已死
      readProcStartMs: () => 9000,
    })
    expect(takeover).toEqual({ ok: true })
    const content = JSON.parse(readFileSync(join(dir, '.replayer.lock'), 'utf8'))
    expect(content.pid).toBe(200)
  })

  test('鎖檔存在、pid 存活，但啟動時刻與鎖檔內不符（pid 重用）→ 接管', () => {
    const dir = tmpDir()
    acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    const takeover = acquireReplayerLock(dir, 'server', 200, {
      isPidAlive: () => true,
      readProcStartMs: (pid: number) => (pid === 100 ? 9999 : 200), // 100 現在查到的啟動時刻跟鎖檔記的 5000 對不上
    })
    expect(takeover).toEqual({ ok: true })
  })

  test('【Phase 1.4 測試 6】鎖檔接管也 fail-closed：pid 存活但 readProcStartMs 現在回 null → 不得接管，記 ERROR', () => {
    const dir = tmpDir()
    acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    const result = acquireReplayerLock(dir, 'server', 200, {
      isPidAlive: () => true,
      readProcStartMs: (pid: number) => (pid === 100 ? null : 200), // 現在解析失敗
    })
    expect(result).toEqual({ ok: false, reason: 'held_unknown' })
    // 鎖檔內容應該還是原持有者的，沒被覆寫
    const content = JSON.parse(readFileSync(join(dir, '.replayer.lock'), 'utf8'))
    expect(content.pid).toBe(100)
  })

  test('鎖檔存在、pid 存活，但鎖檔內當初就沒記到 startedAt（null）→ 無法比對不一致，fail-closed 不接管', () => {
    const dir = tmpDir()
    // 手動模擬「取得鎖當下 readProcStartMs 就回 null」的情況
    acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => null })
    const result = acquireReplayerLock(dir, 'server', 200, {
      isPidAlive: () => true,
      readProcStartMs: () => 12345, // 現在查得到，但鎖檔內原本是 null，無從比對
    })
    expect(result).toEqual({ ok: false, reason: 'held_unknown' })
  })

  test('鎖檔內容無法解析(壞檔) → fail-closed 不接管', () => {
    const dir = tmpDir()
    const lockPath = join(dir, '.replayer.lock')
    writeFileSync(lockPath, 'not-json')
    const result = acquireReplayerLock(dir, 'server', 200, { isPidAlive: () => true, readProcStartMs: () => 1 })
    expect(result).toEqual({ ok: false, reason: 'held_unknown' })
  })
})

describe('releaseReplayerLock', () => {
  test('正常退出時 unlink 鎖檔', () => {
    const dir = tmpDir()
    acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    releaseReplayerLock(dir, 100)
    expect(existsSync(join(dir, '.replayer.lock'))).toBe(false)
  })

  test('鎖檔已被別的 pid 接管 → 不誤刪別人的鎖', () => {
    const dir = tmpDir()
    acquireReplayerLock(dir, 'server', 100, { isPidAlive: () => true, readProcStartMs: () => 5000 })
    acquireReplayerLock(dir, 'server', 200, { isPidAlive: () => false, readProcStartMs: () => 9000 }) // 接管
    releaseReplayerLock(dir, 100) // 舊 pid 想釋放,但鎖已經是 200 的
    expect(existsSync(join(dir, '.replayer.lock'))).toBe(true)
    const content = JSON.parse(readFileSync(join(dir, '.replayer.lock'), 'utf8'))
    expect(content.pid).toBe(200)
  })

  test('鎖檔不存在 → 不拋例外', () => {
    const dir = tmpDir()
    expect(() => releaseReplayerLock(dir, 100)).not.toThrow()
  })
})
