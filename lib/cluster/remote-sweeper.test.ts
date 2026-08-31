import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatchRegistry } from './dispatch-registry.ts'
import { createRemoteSweeper, SWEEP_GRACE_MS, SWEEP_MAX_AGE_MS, SWEEP_MISS_LIMIT } from './remote-sweeper.ts'
import type { JobStatus } from './worker-client.ts'
import type { WorkerInfo } from './worker-registry.ts'

const RUNNING: JobStatus = { locked: true, queueState: 'running', progress: 'x' }
const GONE: JobStatus = { locked: false, queueState: null, progress: null }

function makeHarness(opts: {
  /** key = `${url}|${ticket}`；未列出的組合回 null（失聯）。 */
  statuses?: Record<string, JobStatus>
  workers?: WorkerInfo[]
  now?: number
}) {
  const dir = mkdtempSync(join(tmpdir(), 'sweeper-test-'))
  const registry = createDispatchRegistry(join(dir, 'dispatched.json'))
  const operatorNotes: string[] = []
  const userNotes: { email: string | null; text: string }[] = []
  const resets: string[] = []
  const now = opts.now ?? Date.now()
  const sweeper = createRemoteSweeper({
    registry,
    listWorkers: () => opts.workers ?? [],
    fetchStatus: async (url, ticket) => opts.statuses?.[`${url}|${ticket}`] ?? null,
    notifyOperator: text => {
      operatorNotes.push(text)
      return true
    },
    notifyUser: (by, text) => userNotes.push({ email: by?.email ?? null, text }),
    resetDemand: ticket => {
      resets.push(ticket)
      return true
    },
    now: () => now,
  })
  /** 建一筆 confirmed 登記，dispatchedAt 距 now 為 ageMs。 */
  function addConfirmed(ticket: string, ageMs: number, opts2: { kind?: 'bug' | 'demand'; workerUrl?: string } = {}) {
    registry.markDispatching(ticket, opts2.kind ?? 'bug', { name: 'A', email: 'a@x.tw' })
    registry.confirmDispatched(ticket, 'w1', opts2.workerUrl ?? 'http://10.0.0.2:8801')
    const entry = registry.get(ticket)!
    entry.dispatchedAt = new Date(now - ageMs).toISOString()
  }
  function addDispatching(ticket: string, ageMs: number, kind: 'bug' | 'demand' = 'bug') {
    registry.markDispatching(ticket, kind, { name: 'A', email: 'a@x.tw' })
    registry.get(ticket)!.dispatchedAt = new Date(now - ageMs).toISOString()
  }
  return { registry, sweeper, operatorNotes, userNotes, resets, addConfirmed, addDispatching, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('createRemoteSweeper — 基本判定', () => {
  test('寬限期內（<15 分鐘）不做任何事，連狀態都不查', async () => {
    const h = makeHarness({}) // fetchStatus 全部回 null，但不該被呼叫到會觸發 miss
    h.addConfirmed('FAQ-1', SWEEP_GRACE_MS - 60_000)
    await h.sweeper.sweep()
    expect(h.registry.get('FAQ-1')).not.toBe(null)
    expect(h.operatorNotes).toEqual([])
    expect(h.userNotes).toEqual([])
    h.cleanup()
  })

  test('worker 回報仍在跑（locked/queueState）：保留登記、不通知', async () => {
    const h = makeHarness({ statuses: { 'http://10.0.0.2:8801|FAQ-1': RUNNING } })
    h.addConfirmed('FAQ-1', SWEEP_GRACE_MS + 60_000)
    await h.sweeper.sweep()
    expect(h.registry.get('FAQ-1')).not.toBe(null)
    expect(h.operatorNotes).toEqual([])
    h.cleanup()
  })

  test('vanished（可達但無活動）：清登記、通知維運與使用者，但不叫使用者重新認領、demand 不自動 reset', async () => {
    const h = makeHarness({ statuses: { 'http://10.0.0.2:8801|ALDREQ-1': GONE } })
    h.addConfirmed('ALDREQ-1', SWEEP_GRACE_MS + 60_000, { kind: 'demand' })
    await h.sweeper.sweep()
    expect(h.registry.get('ALDREQ-1')).toBe(null)
    expect(h.resets).toEqual([]) // 無法區分「正常完成」，不自動 reset
    expect(h.operatorNotes.length).toBe(1)
    expect(h.operatorNotes[0]).toContain('需要重跑') // 維運訊息附人工處理提示
    expect(h.userNotes.length).toBe(1)
    expect(h.userNotes[0]!.text).not.toContain('請重新認領')
    expect(h.userNotes[0]!.text).toContain('聯絡維運')
    h.cleanup()
  })
})

describe('createRemoteSweeper — 失聯（C-2：不清登記、不叫重新認領）', () => {
  test('連續失聯達門檻：登記保留、告警恰好一次；恢復後計數歸零', async () => {
    const h = makeHarness({}) // 全部失聯
    h.addConfirmed('FAQ-1', SWEEP_GRACE_MS + 60_000)
    for (let i = 0; i < SWEEP_MISS_LIMIT + 2; i++) await h.sweeper.sweep()
    expect(h.registry.get('FAQ-1')).not.toBe(null) // 絕不清
    expect(h.operatorNotes.length).toBe(1) // alerted 旗標：只告警一次
    expect(h.userNotes.length).toBe(1)
    expect(h.userNotes[0]!.text).toContain('不要')
    expect(h.userNotes[0]!.text).not.toMatch(/請重新認領/)
    h.cleanup()
  })

  test('失聯未達門檻前恢復且仍在跑：計數歸零、無任何通知', async () => {
    const statuses: Record<string, JobStatus> = {}
    const h = makeHarness({ statuses })
    h.addConfirmed('FAQ-1', SWEEP_GRACE_MS + 60_000)
    await h.sweeper.sweep() // miss 1
    await h.sweeper.sweep() // miss 2
    statuses['http://10.0.0.2:8801|FAQ-1'] = RUNNING
    await h.sweeper.sweep() // 恢復
    delete statuses['http://10.0.0.2:8801|FAQ-1']
    await h.sweeper.sweep() // 又失聯：從 1 重數，不會立刻到門檻
    expect(h.operatorNotes).toEqual([])
    expect(h.registry.get('FAQ-1')).not.toBe(null)
    h.cleanup()
  })

  test('noteCleared（job-done）清掉失聯計數：同單再派出後不繼承舊計數（M-3）', async () => {
    const h = makeHarness({})
    h.addConfirmed('FAQ-1', SWEEP_GRACE_MS + 60_000)
    await h.sweeper.sweep() // miss 1
    await h.sweeper.sweep() // miss 2
    h.registry.clear('FAQ-1')
    h.sweeper.noteCleared('FAQ-1')
    h.addConfirmed('FAQ-1', SWEEP_GRACE_MS + 60_000) // 重新派出
    await h.sweeper.sweep() // 新計數 miss 1，不該觸發告警
    expect(h.operatorNotes).toEqual([])
    h.cleanup()
  })
})

describe('createRemoteSweeper — 26 小時絕對上限', () => {
  test('bug：清登記＋叫使用者可重新認領；demand：先 reset AI分析', async () => {
    const h = makeHarness({})
    h.addConfirmed('FAQ-1', SWEEP_MAX_AGE_MS + 60_000)
    h.addConfirmed('ALDREQ-2', SWEEP_MAX_AGE_MS + 60_000, { kind: 'demand' })
    await h.sweeper.sweep()
    expect(h.registry.list()).toEqual([])
    expect(h.resets).toEqual(['ALDREQ-2'])
    expect(h.userNotes.find(n => n.text.includes('FAQ-1'))!.text).toContain('請重新認領')
    expect(h.userNotes.find(n => n.text.includes('ALDREQ-2'))!.text).toContain('需要重跑')
    h.cleanup()
  })
})

describe('createRemoteSweeper — dispatching 殘留求證（M-1）', () => {
  const w1: WorkerInfo = { name: 'w1', url: 'http://10.0.0.2:8801', registeredAt: 'x' }
  const w2: WorkerInfo = { name: 'w2', url: 'http://10.0.0.3:8801', registeredAt: 'x' }

  test('某台 worker 上有活動：轉 confirmed 指向該台，不清、不通知使用者', async () => {
    const h = makeHarness({
      workers: [w1, w2],
      statuses: { 'http://10.0.0.2:8801|FAQ-1': GONE, 'http://10.0.0.3:8801|FAQ-1': RUNNING },
    })
    h.addDispatching('FAQ-1', SWEEP_GRACE_MS + 60_000)
    await h.sweeper.sweep()
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'w2' })
    expect(h.userNotes).toEqual([])
    h.cleanup()
  })

  test('全部 worker 可達且都無活動：清登記、通知可重新認領（demand 先 reset）', async () => {
    const h = makeHarness({
      workers: [w1],
      statuses: { 'http://10.0.0.2:8801|ALDREQ-1': GONE },
    })
    h.addDispatching('ALDREQ-1', SWEEP_GRACE_MS + 60_000, 'demand')
    await h.sweeper.sweep()
    expect(h.registry.get('ALDREQ-1')).toBe(null)
    expect(h.resets).toEqual(['ALDREQ-1'])
    expect(h.userNotes.length).toBe(1)
    expect(h.userNotes[0]!.text).toContain('重新認領')
    h.cleanup()
  })

  test('有 worker 失聯：保留待下一輪（可能就在那台上），不清、不通知', async () => {
    const h = makeHarness({
      workers: [w1, w2],
      statuses: { 'http://10.0.0.2:8801|FAQ-1': GONE }, // w2 失聯
    })
    h.addDispatching('FAQ-1', SWEEP_GRACE_MS + 60_000)
    await h.sweeper.sweep()
    expect(h.registry.get('FAQ-1')?.status).toBe('dispatching')
    expect(h.userNotes).toEqual([])
    h.cleanup()
  })
})

describe('createRemoteSweeper — 重疊防護', () => {
  test('上一輪還在跑時再呼叫 sweep 直接返回，不重複計數', async () => {
    let resolveFetch: ((s: JobStatus | null) => void) | null = null
    const dir = mkdtempSync(join(tmpdir(), 'sweeper-test-'))
    const registry = createDispatchRegistry(join(dir, 'dispatched.json'))
    let fetchCalls = 0
    const sweeper = createRemoteSweeper({
      registry,
      listWorkers: () => [],
      fetchStatus: () => {
        fetchCalls++
        return new Promise(resolve => {
          resolveFetch = resolve
        })
      },
      notifyOperator: () => true,
      notifyUser: () => {},
      resetDemand: () => true,
    })
    registry.markDispatching('FAQ-1', 'bug', null)
    registry.confirmDispatched('FAQ-1', 'w1', 'http://10.0.0.2:8801')
    registry.get('FAQ-1')!.dispatchedAt = new Date(Date.now() - SWEEP_GRACE_MS - 60_000).toISOString()

    const first = sweeper.sweep() // 卡在 fetchStatus 未 resolve
    await sweeper.sweep() // 重疊呼叫：應直接返回
    expect(fetchCalls).toBe(1)
    resolveFetch!(RUNNING)
    await first
    rmSync(dir, { recursive: true, force: true })
  })
})
