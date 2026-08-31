import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatchRegistry } from './dispatch-registry.ts'
import { createDispatcher, type DispatchDeps } from './dispatch.ts'
import type { WorkerInfo } from './worker-registry.ts'
import type { CapacityReport, JobRequest, PostJobResult, QueueStats } from './worker-client.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

const USER: TechUser = { notion_user_id: 'u1', notion_user_name: '測試員', email: 't@x.tw' }

const idle: QueueStats = { limit: 5, running: 0, queued: 0 }
const full: QueueStats = { limit: 5, running: 5, queued: 0 }
function stats(running: number, queued = 0, limit = 5): QueueStats {
  return { limit, running, queued }
}
function worker(name: string): WorkerInfo {
  return { name, url: `http://10.0.0.${name.length}:8801`, registeredAt: 'x' }
}
function cap(bug: QueueStats, demand: QueueStats = idle): CapacityReport {
  return { worker: 'w', bug, demand }
}

/** 全假件 harness：不打網路、不 spawn。localSubmit 預設回 started。 */
function makeHarness(opts: {
  workers?: WorkerInfo[]
  capacities?: Record<string, CapacityReport | null>
  /** 某台 worker 的 /capacity?ticket 探測回報「這張單在該機有活動」。 */
  ticketActiveOn?: string[]
  postResults?: Record<string, PostJobResult>
  localBugStats?: QueueStats
  localHas?: 'running' | 'queued' | null
}) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-test-'))
  const registry = createDispatchRegistry(join(dir, 'dispatched.json'))
  const localSubmits: string[] = []
  const postedJobs: { worker: string; job: JobRequest }[] = []
  const probedTickets: { worker: string; ticket: string }[] = []
  const deps: DispatchDeps = {
    registry,
    listWorkers: () => opts.workers ?? [],
    fetchCapacity: async (w, ticket) => {
      probedTickets.push({ worker: w.name, ticket })
      const base = opts.capacities?.[w.name] ?? null
      if (base === null) return null
      return { ...base, ticket: { ticket, active: opts.ticketActiveOn?.includes(w.name) ?? false } }
    },
    postJob: async (w, job) => {
      postedJobs.push({ worker: w.name, job })
      return opts.postResults?.[w.name] ?? { accepted: true, result: { ok: true, status: 'started', pid: 1 } }
    },
    local: {
      bug: {
        stats: () => opts.localBugStats ?? full,
        has: () => opts.localHas ?? null,
        submit: ticket => {
          localSubmits.push(ticket)
          return { ok: true, status: 'started', pid: 99 }
        },
      },
      demand: {
        stats: () => idle,
        has: () => null,
        submit: ticket => {
          localSubmits.push(ticket)
          return { ok: true, status: 'started', pid: 99 }
        },
      },
    },
  }
  return {
    dispatcher: createDispatcher(deps),
    registry,
    localSubmits,
    postedJobs,
    probedTickets,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('createDispatcher — 單機相容性', () => {
  test('無 worker（cluster 停用或名冊空）：直接本機 submit，不碰登記表、不打網路', async () => {
    const h = makeHarness({ workers: [] })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.localSubmits).toEqual(['FAQ-1'])
    expect(h.registry.list()).toEqual([])
    expect(h.probedTickets).toEqual([])
    h.cleanup()
  })

  test('本機已在跑/已在排隊：不做任何遠端探測', async () => {
    const running = makeHarness({ workers: [worker('w1')], localHas: 'running' })
    expect(await running.dispatcher.dispatchBug('FAQ-1', USER)).toEqual({ ok: true, status: 'already_running' })
    expect(running.probedTickets).toEqual([])
    running.cleanup()

    const queued = makeHarness({ workers: [worker('w1')], localHas: 'queued' })
    const r = await queued.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r.ok).toBe(true)
    expect(queued.localSubmits).toEqual(['FAQ-1']) // 交回本機佇列回報順位
    expect(queued.probedTickets).toEqual([])
    queued.cleanup()
  })
})

describe('createDispatcher — 名額選擇', () => {
  test('本機滿、worker 有名額：帶 ticket 探測全部 worker，派給剩餘名額最多者，登記表 confirmed', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(stats(4)), w22: cap(stats(1)) }, // w22 剩 4 格 > w1 剩 1 格
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w22' })
    expect(h.probedTickets.map(p => p.ticket)).toEqual(['FAQ-1', 'FAQ-1']) // 兩台都帶 ticket 問過
    expect(h.postedJobs.map(p => p.worker)).toEqual(['w22'])
    expect(h.postedJobs[0]!.job).toMatchObject({ kind: 'bug', ticket: 'FAQ-1', triggeredBy: USER })
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'w22' })
    expect(h.localSubmits).toEqual([])
    h.cleanup()
  })

  test('本機名額 ≥ 最佳 worker（含平手）：本機優先，清掉佔位', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) }, // worker 剩 3
      localBugStats: stats(2), // 本機也剩 3 → 平手本機贏
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.localSubmits).toEqual(['FAQ-1'])
    expect(h.postedJobs).toEqual([])
    expect(h.registry.get('FAQ-1')).toBe(null)
    h.cleanup()
  })

  test('worker 有排隊中的單視同無名額；全滿/探測失敗 → 本機佇列', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(stats(1, 2)), w22: null }, // w1 有排隊、w22 失聯
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 }) // 本機 submit（額滿時實際會回 queued，這裡假件回 started）
    expect(h.postedJobs).toEqual([])
    expect(h.registry.get('FAQ-1')).toBe(null)
    h.cleanup()
  })
})

describe('createDispatcher — out-of-band healing（C-1）', () => {
  test('探測發現某台 worker 上這張單已有活動：回填登記為該台、不起新 run、不本機 submit', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(idle), w22: cap(idle) },
      ticketActiveOn: ['w22'],
      localBugStats: idle, // 即使本機名額充足也不准起新 run
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'already_running_remote', worker: 'w22' })
    expect(h.postedJobs).toEqual([])
    expect(h.localSubmits).toEqual([])
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'w22' })
    h.cleanup()
  })

  test('postJob 回 already_running（探測與接單之間的視窗）：一樣回填登記、回 already_running_remote', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(0)) },
      postResults: { w1: { accepted: true, result: { ok: true, status: 'already_running' } } },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'already_running_remote', worker: 'w1' })
    expect(h.registry.get('FAQ-1')?.status).toBe('confirmed')
    expect(h.localSubmits).toEqual([])
    h.cleanup()
  })
})

describe('createDispatcher — 失敗處理', () => {
  test('最佳候選失敗（full/rejected/unreachable）：不試第二台（M-2 預算），清佔位退回本機', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(stats(0)), w22: cap(stats(1)) }, // w1 剩 5 為最佳
      postResults: { w1: { accepted: false, reason: 'full' } },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.postedJobs.map(p => p.worker)).toEqual(['w1']) // w22 不再嘗試
    expect(h.localSubmits).toEqual(['FAQ-1'])
    expect(h.registry.get('FAQ-1')).toBe(null)
    h.cleanup()
  })

  test('postJob 逾時（ambiguous）：保守當已接單、絕不改派其他機器或本機', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(stats(0)), w22: cap(stats(1)) },
      postResults: { w1: { accepted: false, reason: 'ambiguous' } },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.postedJobs.map(p => p.worker)).toEqual(['w1'])
    expect(h.registry.get('FAQ-1')?.status).toBe('confirmed')
    expect(h.localSubmits).toEqual([])
    h.cleanup()
  })

  test('登記表已有這張單：回 already_running_remote，不重複派工', async () => {
    const h = makeHarness({ workers: [worker('w1')], capacities: { w1: cap(idle) }, localBugStats: full })
    h.registry.markDispatching('FAQ-1', 'bug', null)
    h.registry.confirmDispatched('FAQ-1', 'w1', 'http://10.0.0.2:8801')
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'already_running_remote', worker: 'w1' })
    expect(h.probedTickets).toEqual([])
    h.cleanup()
  })

  test('demand 路徑：本機名額較多時本機優先；本機滿時派遠端且 job 帶 assigneeEmail', async () => {
    // 本機 demand stats（harness 寫死 idle：剩 5）> worker 剩 4 → 本機優先
    const localWins = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: { worker: 'w1', bug: full, demand: stats(2, 0, 6) } },
    })
    expect(await localWins.dispatcher.dispatchDemand('ALDREQ-9', 'a@x.tw', USER)).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(localWins.postedJobs).toEqual([])
    localWins.cleanup()

    // worker 剩 6 > 本機剩 5 → 派遠端，payload 驗 kind/assigneeEmail/triggeredBy
    const remoteWins = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: { worker: 'w1', bug: full, demand: stats(0, 0, 6) } },
    })
    const r = await remoteWins.dispatcher.dispatchDemand('ALDREQ-9', 'a@x.tw', USER)
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(remoteWins.postedJobs[0]!.job).toMatchObject({ kind: 'demand', ticket: 'ALDREQ-9', assigneeEmail: 'a@x.tw', triggeredBy: USER })
    expect(remoteWins.registry.get('ALDREQ-9')?.kind).toBe('demand')
    remoteWins.cleanup()
  })
})
