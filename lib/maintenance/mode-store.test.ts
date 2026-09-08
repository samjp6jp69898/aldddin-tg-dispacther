import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaintenanceModeStore } from './mode-store.ts'

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-mode-test-'))
  return { file: join(dir, 'maintenance-mode.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('createMaintenanceModeStore', () => {
  test('預設非維護；檔案不存在時 isOn() 回 false', () => {
    const { file, cleanup } = tmpFile()
    const store = createMaintenanceModeStore(file)
    expect(store.isOn()).toBe(false)
    cleanup()
  })

  test('setOn(true) 落盤，新實例（模擬行程重啟）讀得回 true', () => {
    const { file, cleanup } = tmpFile()
    const store = createMaintenanceModeStore(file)
    store.setOn(true)
    expect(store.isOn()).toBe(true)

    const reloaded = createMaintenanceModeStore(file)
    expect(reloaded.isOn()).toBe(true)
    cleanup()
  })

  test('setOn 冪等：已是目標狀態不重寫檔案（mtime 不變）', () => {
    const { file, cleanup } = tmpFile()
    const store = createMaintenanceModeStore(file)
    store.setOn(true)
    const before = readFileSync(file, 'utf8')
    store.setOn(true)
    const after = readFileSync(file, 'utf8')
    expect(after).toBe(before)
    cleanup()
  })

  test('setOn(false) 可以關回去', () => {
    const { file, cleanup } = tmpFile()
    const store = createMaintenanceModeStore(file)
    store.setOn(true)
    store.setOn(false)
    expect(store.isOn()).toBe(false)
    const reloaded = createMaintenanceModeStore(file)
    expect(reloaded.isOn()).toBe(false)
    cleanup()
  })

  test('檔案被竄改/半寫壞：當作非維護，不拋例外', () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(file, '{not valid json')
    const store = createMaintenanceModeStore(file)
    expect(store.isOn()).toBe(false)
    cleanup()
  })
})
