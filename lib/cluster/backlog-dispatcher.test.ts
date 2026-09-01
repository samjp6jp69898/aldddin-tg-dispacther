import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatchRegistry } from './dispatch-registry.ts'
import { createBacklogDispatcher, type BacklogDispatcherDeps } from './backlog-dispatcher.ts'
import { createPipelineQueue } from '../pipeline-runner/pipeline-queue.ts'
import { createConcurrencyLimiter } from '../pipeline-runner/concurrency-limiter.ts'
import type { WorkerInfo } from './worker-registry.ts'
import type { CapacityReport, JobRequest, PostJobResult, QueueStats } from './worker-client.ts'

function worker(name: string): WorkerInfo {
  return { name, url: `http://10.0.0.${name.length}:8801`, registeredAt: 'x', disabled: false }
}
const idle: QueueStats = { limit: 5, running: 0, queued: 0 }
const full: QueueStats = { limit: 5, running: 5, queued: 0 }

/** 全假件 harness：bug/demand 佇列用真的 createPipelineQueue（limiter 永遠額滿
 * ＝ submit 一律入列，模擬「本機也滿，單只能待在 head 佇列」的前提），
 * registry 用真的 createDispatchRegistry（跟 dispatch.test.ts 同一套做法）；
 * 只有 postJob/fetchCapacity 打網路的部分是假件。 */
function makeHarness(opts: { postResults?: Record<string, PostJobResult>; capacities?: Record<string, CapacityReport | null> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backlog-dispatcher-test-'))
  const registry = createDispatchRegistry(join(dir, 'dispatched.json'))
  const bugQueue = createPipelineQueue<{ resume: boolean }>({
    limiter: createConcurrencyLimiter(0),
    stateFile: join(dir, 'bug.json'),
    ticketRe: /^FAQ-\d+$/,
    spawnNow: () => ({ ok: false }), // limiter 永遠額滿，spawnNow 不會被呼叫到
  })
  const demandQueue = createPipelineQueue<{ assigneeEmail: string }>({
    limiter: createConcurrencyLimiter(0),
    stateFile: join(dir, 'demand.json'),
    ticketRe: /^ALDREQ-\d+$/,
    spawnNow: () => ({ ok: false }),
  })
  const postedJobs: { worker: string; job: JobRequest; registrySnapshotAtCall: ReturnType<DispatchRegistry['get']> }[] = []
  const deps: BacklogDispatcherDeps = {
    registry,
    postJob: async (w, job) => {
      // registry.get() 回傳 Map 內同一個物件參考，不是拷貝：這裡呼叫當下就要
      // 淺拷貝快照下來，否則後續 confirmDispatched/clear 原地修改會讓這筆
      // 記錄跟著變，測試斷言就量不到「postJob 呼叫當下」的真實狀態。
      const snapshot = registry.get(job.ticket)
      postedJobs.push({ worker: w.name, job, registrySnapshotAtCall: snapshot ? { ...snapshot } : null })
      return opts.postResults?.[w.name] ?? { accepted: true, result: { ok: true, status: 'started', pid: 1 } }
    },
    fetchCapacity: async w => opts.capacities?.[w.name] ?? null,
    listWorkers: () => [],
    bug: { tryDispatchFront: attempt => bugQueue.tryDispatchFront(attempt) },
    demand: { tryDispatchFront: attempt => demandQueue.tryDispatchFront(attempt) },
  }
  return {
    dispatcher: createBacklogDispatcher(deps),
    registry,
    bugQueue,
    demandQueue,
    postedJobs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
type DispatchRegistry = ReturnType<typeof createDispatchRegistry>

describe('createBacklogDispatcher — fillFreedSlot', () => {
  test('佇列空：不打網路、不動登記表', async () => {
    const h = makeHarness()
    await h.dispatcher.fillFreedSlot('bug', worker('w1'))
    expect(h.postedJobs).toEqual([])
    expect(h.registry.list()).toEqual([])
    h.cleanup()
  })

  test('隊頭有單、worker 接受：postJob 帶正確 job 內容，登記表 confirmed，單離開佇列', async () => {
    const h = makeHarness()
    h.bugQueue.submit('FAQ-1', { name: '測試員', email: 't@x.tw' }, { resume: false })
    await h.dispatcher.fillFreedSlot('bug', worker('w1'))
    expect(h.postedJobs).toHaveLength(1)
    expect(h.postedJobs[0]!.worker).toBe('w1')
    expect(h.postedJobs[0]!.job).toMatchObject({
      kind: 'bug',
      ticket: 'FAQ-1',
      resume: false,
      triggeredBy: { notion_user_id: '', notion_user_name: '測試員', email: 't@x.tw' },
    })
    // postJob 被呼叫的當下，登記表必須已經是 dispatching（同步佔位跑在
    // await 之前）——這是防重複派工的關鍵前提。
    expect(h.postedJobs[0]!.registrySnapshotAtCall).toMatchObject({ status: 'dispatching', ticket: 'FAQ-1' })
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'w1' })
    expect(h.bugQueue.size()).toBe(0)
    h.cleanup()
  })

  test('demand kind：job 帶 assigneeEmail', async () => {
    const h = makeHarness()
    h.demandQueue.submit('ALDREQ-9', null, { assigneeEmail: 'a@x.tw' })
    await h.dispatcher.fillFreedSlot('demand', worker('w1'))
    expect(h.postedJobs[0]!.job).toMatchObject({ kind: 'demand', ticket: 'ALDREQ-9', assigneeEmail: 'a@x.tw' })
    expect(h.registry.get('ALDREQ-9')).toMatchObject({ status: 'confirmed', kind: 'demand' })
    h.cleanup()
  })

  test('worker 拒絕（full/rejected/unreachable）：登記表清掉佔位，單塞回隊頭', async () => {
    const h = makeHarness({ postResults: { w1: { accepted: false, reason: 'full' } } })
    h.bugQueue.submit('FAQ-1', null, { resume: false })
    await h.dispatcher.fillFreedSlot('bug', worker('w1'))
    expect(h.registry.get('FAQ-1')).toBe(null)
    expect(h.bugQueue.size()).toBe(1)
    expect(h.bugQueue.has('FAQ-1')).toBe('queued')
    h.cleanup()
  })

  test('postJob 逾時（ambiguous）：保守視為已接單，登記表 confirmed', async () => {
    const h = makeHarness({ postResults: { w1: { accepted: false, reason: 'ambiguous' } } })
    h.bugQueue.submit('FAQ-1', null, { resume: false })
    await h.dispatcher.fillFreedSlot('bug', worker('w1'))
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'w1' })
    expect(h.bugQueue.size()).toBe(0)
    h.cleanup()
  })

  test('demand 分支：worker 拒絕時同樣清掉登記表佔位、單塞回隊頭（跟 bug 分支對等，不是各自複製一份就漏掉某一步）', async () => {
    const h = makeHarness({ postResults: { w1: { accepted: false, reason: 'rejected' } } })
    h.demandQueue.submit('ALDREQ-1', null, { assigneeEmail: 'a@x.tw' })
    await h.dispatcher.fillFreedSlot('demand', worker('w1'))
    expect(h.registry.get('ALDREQ-1')).toBe(null)
    expect(h.demandQueue.size()).toBe(1)
    expect(h.demandQueue.has('ALDREQ-1')).toBe('queued')
    h.cleanup()
  })

  test('防禦性預檢：隊頭單在登記表已有條目（不應發生的異常狀態）——跳過、不覆蓋、不清掉既有登記，也不打網路', async () => {
    const h = makeHarness()
    h.bugQueue.submit('FAQ-1', null, { resume: false })
    // 構造「不應發生」的狀態：這張單同時在佇列與登記表（模擬未來某個新入隊
    // 路徑忘了先 clear）。
    h.registry.markDispatching('FAQ-1', 'bug', null)
    h.registry.confirmDispatched('FAQ-1', 'other-worker', 'http://10.0.0.9:8801')
    await h.dispatcher.fillFreedSlot('bug', worker('w1'))
    expect(h.postedJobs).toEqual([]) // 完全沒打網路
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'other-worker' }) // 既有登記原封不動
    expect(h.bugQueue.size()).toBe(1) // 單還在隊頭，等人工排除異常
    h.cleanup()
  })
})

describe('createBacklogDispatcher — sweepBacklog（job-done 遺失時的週期性安全網）', () => {
  test('逐台探測名額，>0 才嘗試遞補；capacity 探測失敗（null）的 worker 跳過不拋例外', async () => {
    const h = makeHarness({
      capacities: { w1: { worker: 'w1', bug: idle, demand: full }, w2: null },
    })
    h.bugQueue.submit('FAQ-1', null, { resume: false })
    h.demandQueue.submit('ALDREQ-1', null, { assigneeEmail: 'a@x.tw' })
    const deps: BacklogDispatcherDeps = {
      registry: h.registry,
      postJob: async (w, job) => {
        h.postedJobs.push({ worker: w.name, job, registrySnapshotAtCall: h.registry.get(job.ticket) })
        return { accepted: true, result: { ok: true, status: 'started', pid: 1 } }
      },
      fetchCapacity: async w => (w.name === 'w1' ? { worker: 'w1', bug: idle, demand: full } : null),
      listWorkers: () => [worker('w1'), worker('w2')],
      bug: { tryDispatchFront: attempt => h.bugQueue.tryDispatchFront(attempt) },
      demand: { tryDispatchFront: attempt => h.demandQueue.tryDispatchFront(attempt) },
    }
    const dispatcher = createBacklogDispatcher(deps)
    await dispatcher.sweepBacklog()
    // w1 的 bug 有空位（idle）→ 遞補 FAQ-1；demand 是 full → 不動；w2 探測
    // 失敗（null）→ 整台跳過，不拋例外。
    expect(h.postedJobs.map(p => ({ worker: p.worker, ticket: p.job.ticket }))).toEqual([{ worker: 'w1', ticket: 'FAQ-1' }])
    expect(h.bugQueue.size()).toBe(0)
    expect(h.demandQueue.size()).toBe(1)
    h.cleanup()
  })

  test('重入防護：上一輪還在跑時再呼叫一次，第二次不重複做事', async () => {
    const h = makeHarness()
    h.bugQueue.submit('FAQ-1', null, { resume: false })
    let resolveCapacity: (v: CapacityReport | null) => void = () => {}
    const capacityPromise = new Promise<CapacityReport | null>(resolve => {
      resolveCapacity = resolve
    })
    let fetchCalls = 0
    const deps: BacklogDispatcherDeps = {
      registry: h.registry,
      postJob: async (w, job) => {
        h.postedJobs.push({ worker: w.name, job, registrySnapshotAtCall: h.registry.get(job.ticket) })
        return { accepted: true, result: { ok: true, status: 'started', pid: 1 } }
      },
      fetchCapacity: async () => {
        fetchCalls++
        return capacityPromise
      },
      listWorkers: () => [worker('w1')],
      bug: { tryDispatchFront: attempt => h.bugQueue.tryDispatchFront(attempt) },
      demand: { tryDispatchFront: attempt => h.demandQueue.tryDispatchFront(attempt) },
    }
    const dispatcher = createBacklogDispatcher(deps)
    const first = dispatcher.sweepBacklog() // 卡在 fetchCapacity 的 await 上
    const second = dispatcher.sweepBacklog() // 應該立刻回傳，不重新探測
    resolveCapacity({ worker: 'w1', bug: idle, demand: idle })
    await Promise.all([first, second])
    expect(fetchCalls).toBe(1) // 第二次呼叫沒有真的再探測一次
    expect(h.postedJobs).toHaveLength(1)
    h.cleanup()
  })

  test('某一輪 fetchCapacity 丟例外：finally 仍把 sweeping 旗標放回 false，下一輪 sweep 正常運作（不會被永久卡死判成「還在跑」）', async () => {
    const h = makeHarness()
    h.bugQueue.submit('FAQ-1', null, { resume: false })
    let shouldThrow = true
    const deps: BacklogDispatcherDeps = {
      registry: h.registry,
      postJob: async (w, job) => {
        h.postedJobs.push({ worker: w.name, job, registrySnapshotAtCall: { ...h.registry.get(job.ticket)! } })
        return { accepted: true, result: { ok: true, status: 'started', pid: 1 } }
      },
      fetchCapacity: async () => {
        if (shouldThrow) throw new Error('worker 打不通')
        return { worker: 'w1', bug: idle, demand: idle }
      },
      listWorkers: () => [worker('w1')],
      bug: { tryDispatchFront: attempt => h.bugQueue.tryDispatchFront(attempt) },
      demand: { tryDispatchFront: attempt => h.demandQueue.tryDispatchFront(attempt) },
    }
    const dispatcher = createBacklogDispatcher(deps)
    // 第一輪：fetchCapacity 丟例外，sweepBacklog 本身要把例外往外拋（呼叫端
    // cluster-head.ts 用 .catch 接住），不能吞掉導致維運看不到問題。
    await expect(dispatcher.sweepBacklog()).rejects.toThrow('worker 打不通')
    expect(h.postedJobs).toEqual([])
    // 第二輪：fetchCapacity 恢復正常——若第一輪的 sweeping 旗標沒有在 finally
    // 正確重置，這一輪會被誤判成「上一輪還在跑」而直接跳過，postedJobs 仍是空的。
    shouldThrow = false
    await dispatcher.sweepBacklog()
    expect(h.postedJobs).toHaveLength(1)
    expect(h.bugQueue.size()).toBe(0)
    h.cleanup()
  })
})
