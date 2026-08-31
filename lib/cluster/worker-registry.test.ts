import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerRegistry } from './worker-registry.ts'

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-registry-test-'))
  return { file: join(dir, 'workers.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('createWorkerRegistry', () => {
  test('登記/列出/同名覆蓋 url，且落盤後新實例讀得回來（head 重啟不歸零）', () => {
    const { file, cleanup } = tmpFile()
    const r = createWorkerRegistry(file)
    expect(r.register('mac-mini-2', 'http://192.168.1.50:8801')).toBe(true)
    expect(r.register('mbp-3', 'http://192.168.1.51:8801')).toBe(true)
    expect(r.list().map(w => w.name)).toEqual(['mac-mini-2', 'mbp-3'])

    expect(r.register('mac-mini-2', 'http://192.168.1.60:8801')).toBe(true) // 換 IP 重登記
    expect(r.list().find(w => w.name === 'mac-mini-2')?.url).toBe('http://192.168.1.60:8801')

    const reloaded = createWorkerRegistry(file)
    expect(reloaded.list().map(w => w.url).sort()).toEqual(['http://192.168.1.51:8801', 'http://192.168.1.60:8801'])
    cleanup()
  })

  test('name/url 格式不合法拒絕登記（資料來自網路 body，不進名冊）', () => {
    const { file, cleanup } = tmpFile()
    const r = createWorkerRegistry(file)
    expect(r.register('bad name with space', 'http://192.168.1.50:8801')).toBe(false)
    expect(r.register('ok-name', 'ftp://192.168.1.50')).toBe(false)
    expect(r.register('ok-name', 'http://192.168.1.50:8801/evil/path')).toBe(false)
    expect(r.list()).toEqual([])
    cleanup()
  })

  test('檔案被竄改/半寫壞：不合法條目丟棄、壞 JSON 當空名冊', () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(
      file,
      JSON.stringify({ workers: [{ name: 'ok-1', url: 'http://10.0.0.2:8801', registeredAt: 'x' }, { name: 'in valid', url: 'http://10.0.0.3:8801' }, { name: 'ok-2', url: 'javascript:alert(1)' }] }),
    )
    expect(createWorkerRegistry(file).list().map(w => w.name)).toEqual(['ok-1'])

    writeFileSync(file, '{ broken json')
    expect(createWorkerRegistry(file).list()).toEqual([])
    cleanup()
  })

  test('冪等重登記（同 name 同 url）回 true 且不重寫檔', () => {
    const { file, cleanup } = tmpFile()
    const r = createWorkerRegistry(file)
    r.register('w1', 'http://10.0.0.2:8801')
    const before = readFileSync(file, 'utf8')
    expect(r.register('w1', 'http://10.0.0.2:8801')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
    cleanup()
  })
})
