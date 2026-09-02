import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatchRegistry } from './dispatch-registry.ts'

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-registry-test-'))
  return { file: join(dir, 'dispatched.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('createDispatchRegistry', () => {
  test('markDispatching → confirmDispatched → clear 生命週期', () => {
    const { file, cleanup } = tmpFile()
    const r = createDispatchRegistry(file)
    const dispatchId = r.markDispatching('FAQ-100', 'bug', { name: 'A', email: 'a@x.tw' })
    expect(dispatchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.get('FAQ-100')?.status).toBe('dispatching')
    expect(r.get('FAQ-100')?.worker).toBe('')
    expect(r.get('FAQ-100')?.dispatchId).toBe(dispatchId)

    r.confirmDispatched('FAQ-100', 'mac-mini-2', 'http://10.0.0.2:8801')
    expect(r.get('FAQ-100')).toMatchObject({ status: 'confirmed', worker: 'mac-mini-2', workerUrl: 'http://10.0.0.2:8801' })

    r.clear('FAQ-100')
    expect(r.get('FAQ-100')).toBe(null)
    expect(r.list()).toEqual([])
    cleanup()
  })

  test('recoverFromDisk 之前的 mutation 不落盤（短命行程/測試 import 不寫檔）', () => {
    const { file, cleanup } = tmpFile()
    const r = createDispatchRegistry(file)
    r.markDispatching('FAQ-1', 'bug', null)
    r.confirmDispatched('FAQ-1', 'w', 'http://10.0.0.2:8801')
    expect(existsSync(file)).toBe(false)
    cleanup()
  })

  test('recoverFromDisk：撿回 confirmed 與 dispatching（M-1：交涉中重啟可能已派出，保留待 sweeper 求證）、丟棄格式不合法的 ticket', () => {
    const { file, cleanup } = tmpFile()
    const base = { worker: 'w', workerUrl: 'http://10.0.0.2:8801', dispatchedAt: new Date().toISOString(), triggeredBy: null }
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          { ticket: 'FAQ-1', kind: 'bug', status: 'confirmed', ...base },
          { ticket: 'ALDREQ-2', kind: 'demand', status: 'confirmed', ...base },
          { ticket: 'FAQ-3', kind: 'bug', status: 'dispatching', ...base },
          { ticket: 'rm -rf /', kind: 'bug', status: 'confirmed', ...base },
          { ticket: 'FAQ-9', kind: 'bug', status: 'garbage', ...base },
        ],
      }),
    )
    const r = createDispatchRegistry(file)
    expect(r.recoverFromDisk()).toBe(3)
    expect(r.get('FAQ-1')?.status).toBe('confirmed')
    expect(r.get('ALDREQ-2')?.kind).toBe('demand')
    expect(r.get('FAQ-3')?.status).toBe('dispatching')
    expect(r.get('FAQ-9')).toBe(null)
    expect(r.list().length).toBe(3)
    // base 沒帶 dispatchId（舊格式）：撿回時每筆都補鑄一個，不是空字串/undefined。
    expect(r.get('FAQ-1')?.dispatchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.get('ALDREQ-2')?.dispatchId).not.toBe(r.get('FAQ-1')?.dispatchId)

    // recover 之後 mutation 開始落盤，新實例讀得回來
    r.clear('ALDREQ-2')
    const reloaded = createDispatchRegistry(file)
    expect(reloaded.recoverFromDisk()).toBe(2)
    cleanup()
  })

  test('recoverFromDisk：已帶 dispatchId 的條目原樣保留，不重新鑄造', () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          {
            ticket: 'FAQ-1',
            kind: 'bug',
            status: 'confirmed',
            dispatchId: 'fixed-id-123',
            worker: 'w',
            workerUrl: 'http://10.0.0.2:8801',
            dispatchedAt: new Date().toISOString(),
            triggeredBy: null,
          },
        ],
      }),
    )
    const r = createDispatchRegistry(file)
    r.recoverFromDisk()
    expect(r.get('FAQ-1')?.dispatchId).toBe('fixed-id-123')
    cleanup()
  })

  test('壞 JSON 當空表，不拋例外', () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(file, 'not json at all')
    const r = createDispatchRegistry(file)
    expect(r.recoverFromDisk()).toBe(0)
    cleanup()
  })
})
