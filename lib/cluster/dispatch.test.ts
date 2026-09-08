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
  /** Phase 4（§4.3）：給了才注入 artifacts deps；不給＝完全等同 Phase 4 之前。 */
  artifacts?: {
    headHas?: boolean
    /** ticket_artifact_sync/ticket_stages 查到的原執行機（null＝查無紀錄）。 */
    host?: string | null
    /** 各 worker 的產物存在性檢查結果：true=有、false=沒有、null=不可達。 */
    remoteHas?: Record<string, boolean | null>
    pushOk?: boolean
  }
}) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-test-'))
  const registry = createDispatchRegistry(join(dir, 'dispatched.json'))
  const localSubmits: string[] = []
  const localSubmitOpts: ({ resume?: boolean; mode?: string } | undefined)[] = []
  const postedJobs: { worker: string; job: JobRequest }[] = []
  const probedTickets: { worker: string; ticket: string }[] = []
  const dispatchAttemptCalls: { fn: 'create' | 'advance' | 'supersedeOthers'; input: Record<string, unknown> }[] = []
  /** 依序記錄 push/postJob，用來驗「push 一定在 postJob 之前」。 */
  const events: string[] = []
  const artifactCalls: string[] = []
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
      events.push(`post:${w.name}`)
      return opts.postResults?.[w.name] ?? { accepted: true, result: { ok: true, status: 'started', pid: 1 }, runId: null }
    },
    ...(opts.artifacts
      ? {
          artifacts: {
            headHas: () => {
              artifactCalls.push('headHas')
              return opts.artifacts?.headHas ?? false
            },
            lookupHost: async () => {
              artifactCalls.push('lookupHost')
              return opts.artifacts?.host ?? null
            },
            remoteHas: async w => {
              artifactCalls.push(`remoteHas:${w.name}`)
              return opts.artifacts?.remoteHas?.[w.name] ?? null
            },
            push: async w => {
              artifactCalls.push(`push:${w.name}`)
              events.push(`push:${w.name}`)
              return opts.artifacts?.pushOk ?? true
            },
          },
        }
      : {}),
    dispatchAttempts: {
      supersedeOthers: input => dispatchAttemptCalls.push({ fn: 'supersedeOthers', input }),
      create: input => dispatchAttemptCalls.push({ fn: 'create', input }),
      advance: input => dispatchAttemptCalls.push({ fn: 'advance', input }),
    },
    local: {
      bug: {
        stats: () => opts.localBugStats ?? full,
        has: () => opts.localHas ?? null,
        submit: (ticket, _triggeredBy, submitOpts) => {
          localSubmits.push(ticket)
          localSubmitOpts.push(submitOpts)
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
    localSubmitOpts,
    postedJobs,
    probedTickets,
    dispatchAttemptCalls,
    events,
    artifactCalls,
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
      postResults: { w1: { accepted: true, result: { ok: true, status: 'already_running' }, runId: null } },
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

describe('createDispatcher — dispatch_attempts 觀察面寫入（plan §5.3）', () => {
  test('遠端派工成功：create(dispatching) 先於 advance(dispatched)，dispatchId 前後一致，job body 帶 dispatchId', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: full,
    })
    await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(h.dispatchAttemptCalls.map(c => c.fn)).toEqual(['supersedeOthers', 'create', 'advance'])
    const dispatchId = h.dispatchAttemptCalls[1]!.input.dispatchId
    expect(dispatchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(h.dispatchAttemptCalls[1]!.input).toMatchObject({ ticket: 'FAQ-1', kind: 'bug', status: 'dispatching', statusRank: 10, triggeredByEmail: 't@x.tw' })
    expect(h.dispatchAttemptCalls[2]!.input).toMatchObject({ dispatchId, status: 'dispatched', statusRank: 20 })
    // 整合修補：advance(dispatched) 必須帶 worker 資訊，否則 writes.ts 的
    // COALESCE 永遠補不到值、dispatch_attempts.worker_name/worker_url 永遠 NULL。
    expect(h.dispatchAttemptCalls[2]!.input).toMatchObject({ workerName: 'w1', workerUrl: worker('w1').url })
    expect(h.postedJobs[0]!.job.dispatchId).toBe(dispatchId as string)
    h.cleanup()
  })

  test('退回本機（本機名額 ≥ worker）：create(dispatching) 之後緊接 advance(cleared, no_remote_capacity)', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: stats(2), // 平手本機優先
    })
    await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(h.dispatchAttemptCalls.map(c => c.fn)).toEqual(['supersedeOthers', 'create', 'advance'])
    expect(h.dispatchAttemptCalls[2]!.input).toMatchObject({ status: 'cleared', statusRank: 100, clearReason: 'no_remote_capacity' })
    h.cleanup()
  })

  test('worker 拒絕（full）：advance(cleared) 的 clearReason 帶原始拒絕原因', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      postResults: { w1: { accepted: false, reason: 'full' } },
      localBugStats: full,
    })
    await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(h.dispatchAttemptCalls[2]!.input).toMatchObject({ status: 'cleared', statusRank: 100, clearReason: 'full' })
    h.cleanup()
  })

  test('§5.3：markDispatching 之後、create 之前呼叫 supersedeOthers（若 deps 有提供）', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: full,
    })
    await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(h.dispatchAttemptCalls.map(c => c.fn)).toEqual(['supersedeOthers', 'create', 'advance'])
    const dispatchId = h.dispatchAttemptCalls[1]!.input.dispatchId
    expect(h.dispatchAttemptCalls[0]!.input).toMatchObject({ ticket: 'FAQ-1', kind: 'bug', excludeDispatchId: dispatchId })
    h.cleanup()
  })

  test('沒有 dispatchAttempts deps（單機/舊測試相容）：不拋例外，行為不變', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-test-'))
    const registry = createDispatchRegistry(join(dir, 'dispatched.json'))
    const deps: DispatchDeps = {
      registry,
      listWorkers: () => [worker('w1')],
      fetchCapacity: async () => cap(stats(2)),
      postJob: async () => ({ accepted: true, result: { ok: true, status: 'started', pid: 1 }, runId: null }),
      local: {
        bug: { stats: () => full, has: () => null, submit: () => ({ ok: true, status: 'started', pid: 99 }) },
        demand: { stats: () => idle, has: () => null, submit: () => ({ ok: true, status: 'started', pid: 99 }) },
      },
    }
    const r = await createDispatcher(deps).dispatchBug('FAQ-1', USER)
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('createDispatcher — 執行模式 mode（2026-09-08，plan-pipeline-modes-v1 §2.2）：與 resume 正交，兩條路徑都透傳', () => {
  test('本機優先時：mode 透傳進 local.bug.submit 的 opts', async () => {
    const h = makeHarness({ workers: [worker('w1')], capacities: { w1: cap(stats(4)) }, localBugStats: idle })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'analysis' })
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.localSubmitOpts).toEqual([{ mode: 'analysis' }])
    h.cleanup()
  })

  test('派到 worker 時：job body 帶 mode；resume 同時存在時兩者都在', async () => {
    const h = makeHarness({ workers: [worker('w1')], capacities: { w1: cap(idle) }, localBugStats: full })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix', resume: true })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.postedJobs[0]!.job).toMatchObject({ kind: 'bug', ticket: 'FAQ-1', mode: 'fix', resume: true })
    h.cleanup()
  })

  test('不帶 mode（既有呼叫端／續跑）：job body 不含 mode 欄位——由執行端 submitCreateMr 決定預設', async () => {
    const h = makeHarness({ workers: [worker('w1')], capacities: { w1: cap(idle) }, localBugStats: full })
    await h.dispatcher.dispatchBug('FAQ-1', USER, { resume: true })
    expect(h.postedJobs[0]!.job.mode).toBeUndefined()
    h.cleanup()
  })
})

describe('createDispatcher — 產物親和派工（Phase 4，plan-pipeline-modes-v1 §4.3／§4.4.1）', () => {
  test('親和 host 名額 0、另一台名額 5：仍派親和 host（忽略 capacity），postJob 只打那一台，連 capacity 都不探測', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(full), w22: cap(idle) }, // 親和 host 滿載、另一台全空
      artifacts: { headHas: false, host: 'w1', remoteHas: { w1: true } },
      localBugStats: idle, // 本機也有名額，一樣不准搶走
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.postedJobs.map(p => p.worker)).toEqual(['w1'])
    expect(h.postedJobs[0]!.job).toMatchObject({ kind: 'bug', ticket: 'FAQ-1', mode: 'fix' })
    expect(h.probedTickets).toEqual([]) // 親和分支在 capacity 探測之前就 return
    expect(h.localSubmits).toEqual([])
    expect(h.registry.get('FAQ-1')).toMatchObject({ status: 'confirmed', worker: 'w1' })
    h.cleanup()
  })

  test('reanalyze 同樣適用；親和 host 回 full → artifact_host_full，不改派別台、不排隊、登記清空', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(full), w22: cap(idle) },
      postResults: { w1: { accepted: false, reason: 'full' } },
      artifacts: { headHas: false, host: 'w1', remoteHas: { w1: true } },
      localBugStats: idle,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'reanalyze' })
    expect(r).toEqual({ ok: true, status: 'artifact_host_full', worker: 'w1' })
    expect(h.postedJobs.map(p => p.worker)).toEqual(['w1'])
    expect(h.localSubmits).toEqual([])
    expect(h.registry.get('FAQ-1')).toBe(null)
    expect(h.dispatchAttemptCalls.at(-1)!.input).toMatchObject({ status: 'cleared', clearReason: 'artifact_host_full' })
    h.cleanup()
  })

  test('親和 host 的 /stage-files 回 analysis-notes 為 null：退回既有流程，結果附 note=no_prior_artifacts', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(idle) },
      artifacts: { headHas: false, host: 'w1', remoteHas: { w1: false } },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1', note: 'no_prior_artifacts' })
    expect(h.probedTickets.map(p => p.worker)).toEqual(['w1']) // 有走既有 capacity 探測
    expect(h.postedJobs.map(p => p.worker)).toEqual(['w1'])
    h.cleanup()
  })

  test('查無紀錄（DB 關閉或沒跑過）：等同 full 流程，一樣只附 note=no_prior_artifacts', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(idle) },
      artifacts: { headHas: false, host: null },
      localBugStats: idle, // 本機優先
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'started', pid: 99, note: 'no_prior_artifacts' })
    expect(h.localSubmits).toEqual(['FAQ-1'])
    expect(h.artifactCalls).toContain('lookupHost')
    h.cleanup()
  })

  test('親和 host 不可達（remoteHas=null）：artifact_host_offline，不 spawn、不排隊、登記清空', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(idle), w22: cap(idle) },
      artifacts: { headHas: false, host: 'w1', remoteHas: { w1: null } },
      localBugStats: idle,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'artifact_host_offline', worker: 'w1' })
    expect(h.postedJobs).toEqual([])
    expect(h.localSubmits).toEqual([])
    expect(h.registry.get('FAQ-1')).toBe(null)
    expect(h.dispatchAttemptCalls.at(-1)!.input).toMatchObject({ status: 'cleared', clearReason: 'artifact_host_offline' })
    h.cleanup()
  })

  test('親和 host 已不在名冊（退役/停用）：同樣 artifact_host_offline，連 stage-files 都不問', async () => {
    const h = makeHarness({
      workers: [worker('w22')],
      capacities: { w22: cap(idle) },
      artifacts: { headHas: false, host: 'w1', remoteHas: { w1: true } },
      localBugStats: idle,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'artifact_host_offline', worker: 'w1' })
    expect(h.artifactCalls).not.toContain('remoteHas:w1')
    expect(h.postedJobs).toEqual([])
    expect(h.registry.get('FAQ-1')).toBe(null)
    h.cleanup()
  })

  test('head 本機有產物：走既有 capacity 流程，且 postJob 之前一定先 push 到選中的那台', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(stats(4)), w22: cap(idle) }, // w22 剩 5 為最佳
      artifacts: { headHas: true, pushOk: true },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w22' })
    expect(h.events).toEqual(['push:w22', 'post:w22']) // 順序：先推產物再派工
    expect(h.artifactCalls).not.toContain('lookupHost') // head 有產物就不必查 DB
    h.cleanup()
  })

  test('head 有產物但推送失敗：不派遠端，改本機 submit，clearReason=artifact_push_failed', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(idle) },
      artifacts: { headHas: true, pushOk: false },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { mode: 'fix' })
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.postedJobs).toEqual([])
    expect(h.localSubmits).toEqual(['FAQ-1'])
    expect(h.registry.get('FAQ-1')).toBe(null)
    expect(h.dispatchAttemptCalls.at(-1)!.input).toMatchObject({ status: 'cleared', clearReason: 'artifact_push_failed' })
    h.cleanup()
  })

  test('full/analysis/resume 模式：不查親和 host，但 head 有產物時一樣先推送（§4.3 B）', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(idle) },
      artifacts: { headHas: true, host: 'w1' },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { resume: true })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.artifactCalls).not.toContain('lookupHost')
    expect(h.events).toEqual(['push:w1', 'post:w1'])
    h.cleanup()
  })

  test('demand 單完全不走產物路徑（ALDREQ 沒有既有產物的概念）', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: { worker: 'w1', bug: full, demand: stats(0, 0, 6) } },
      artifacts: { headHas: true, host: 'w1' },
    })
    const r = await h.dispatcher.dispatchDemand('ALDREQ-9', 'a@x.tw', USER)
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.artifactCalls).toEqual([])
    h.cleanup()
  })
})

describe('createDispatcher — 續跑（task 2，2026-09-04）：resume 走跟一般派工相同的分派判斷', () => {
  test('本機優先時：resume 透傳進 local.bug.submit 的 opts', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: stats(2), // 平手本機優先
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { resume: true })
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.localSubmits).toEqual(['FAQ-1'])
    expect(h.localSubmitOpts).toEqual([{ resume: true }])
    h.cleanup()
  })

  test('派到 worker 時：job body 帶 resume:true——可以落到任一台（含跟原執行機不同的 worker），這是預期行為', async () => {
    const h = makeHarness({
      workers: [worker('w1'), worker('w22')],
      capacities: { w1: cap(stats(1)), w22: cap(stats(4)) }, // w1 剩 4 格 > w22 剩 1 格，w1 勝出
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', USER, { resume: true })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.postedJobs[0]!.job).toMatchObject({ kind: 'bug', ticket: 'FAQ-1', resume: true, triggeredBy: USER })
    h.cleanup()
  })

  test('不帶 resume（一般派工）：job body 不含 resume 欄位', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: full,
    })
    await h.dispatcher.dispatchBug('FAQ-1', USER)
    expect(h.postedJobs[0]!.job.resume).toBeUndefined()
    h.cleanup()
  })

  test('techUser 為 null（tg-monitor 續跑查不到原認領人 email）：本機 submit 收到 null，不假造使用者物件', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: stats(2), // 平手本機優先
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', null, { resume: true })
    expect(r).toEqual({ ok: true, status: 'started', pid: 99 })
    expect(h.localSubmitOpts).toEqual([{ resume: true }])
    h.cleanup()
  })

  test('techUser 為 null 且派到 worker：job body 不帶 triggeredBy，dispatch_attempts 的 triggeredByEmail 不帶', async () => {
    const h = makeHarness({
      workers: [worker('w1')],
      capacities: { w1: cap(stats(2)) },
      localBugStats: full,
    })
    const r = await h.dispatcher.dispatchBug('FAQ-1', null, { resume: true })
    expect(r).toEqual({ ok: true, status: 'remote_started', worker: 'w1' })
    expect(h.postedJobs[0]!.job.triggeredBy).toBeUndefined()
    expect(h.postedJobs[0]!.job.resume).toBe(true)
    expect(h.dispatchAttemptCalls[1]!.input.triggeredByEmail).toBeUndefined()
    h.cleanup()
  })
})
