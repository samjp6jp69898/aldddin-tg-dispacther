import type { SubmitResult } from '../pipeline-runner/pipeline-queue.ts'
import type { DispatchRegistry } from './dispatch-registry.ts'
import type { WorkerInfo } from './worker-registry.ts'
import type { CapacityReport, JobRequest, PostJobResult, QueueStats } from './worker-client.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

// 派工選擇邏輯（head 專用）。純邏輯、全部依賴注入，不直接 import 任何會
// spawn/打網路的模組——production 接線在 cluster-head.ts，測試各自注入假件。
//
// 選擇策略（2026-08-31 依對抗性 review C-1/M-2 修正後）：
//   1. 本機佇列已有這張單（running/queued）→ 原樣回報，不派遠端。
//   2. dispatch-registry 已有這張單 → already_running_remote。
//   3. 同步佔位（markDispatching）→ 之後才開始打網路探測。
//   4. 並行探測全部 worker 的 /capacity?ticket=<ticket>（2.5 秒上限）——
//      名額與「這張單在該機有沒有活動」一次問完。**任何一台回報這張單
//      active**（out-of-band run：timeout 自動重試、reaper 重跑、人工觸發，
//      C-1 的失明面）→ 就地把登記表回填成 confirmed 指向那台，回
//      already_running_remote，絕不再起新 run。
//   5. 候選 = 本機剩餘名額 vs 各 worker 剩餘名額（佇列有單視同滿）；本機
//      ≥ 最佳 worker（含平手）→ 本機（不用走網路、監控最完整）。
//   6. 遠端只試「最佳一台」（M-2：不輪詢多台，把最壞耗時鎖在 2.5+6 秒，
//      留在 grammy webhook 10 秒預算內）；該台失敗（full/rejected/
//      unreachable＝確定沒接單）→ 清佔位、退回本機 submit（額滿走既有
//      FIFO 佇列，行為與單機相同）。
//   例外：postJob 回 ambiguous（逾時，可能已接單）→ 保守當已接單
//   （confirmDispatched），絕不改派——寧可讓 remote sweeper 事後把沒真的
//   在跑的單清掉，也不冒兩台同時跑同一張單的風險。worker 回
//   already_running（它自己就發現這張單在該機有活動）→ 同樣回填登記表。
//
// v1 已知限制（記錄於 README）：
// - 本機 FIFO 佇列裡的單只會在「本機」名額釋放時遞補，不會在 worker 名額
//   釋放時撿去遠端跑。
// - 步驟 4 的探測對「當下失聯的 worker」問不到活動狀態：若那台正好在跑這
//   張單又正好斷線，重複防護退回登記表本身（正常都在）；登記表也沒有時
//   （job-done 已清 + out-of-band 重跑 + 該機斷線三者疊加）是已接受的殘餘
//   風險，靠 sweeper 的失聯保守策略與維運告警兜底。

export type DispatchResult =
  | SubmitResult
  | { ok: true; status: 'remote_started'; worker: string }
  | { ok: true; status: 'already_running_remote'; worker: string }

export type DispatchDeps = {
  registry: DispatchRegistry
  listWorkers: () => WorkerInfo[]
  /** 帶 ticket 的名額+活動探測（見 worker-client.fetchWorkerCapacity）。 */
  fetchCapacity: (w: WorkerInfo, ticket: string) => Promise<CapacityReport | null>
  postJob: (w: WorkerInfo, job: JobRequest) => Promise<PostJobResult>
  local: {
    bug: {
      stats: () => QueueStats
      has: (ticket: string) => 'running' | 'queued' | null
      submit: (ticket: string, triggeredBy: TechUser) => SubmitResult
    }
    demand: {
      stats: () => QueueStats
      has: (ticket: string) => 'running' | 'queued' | null
      submit: (ticket: string, assigneeEmail: string, triggeredBy: TechUser) => SubmitResult
    }
  }
}

function freeSlots(stats: QueueStats): number {
  // 有單在排隊代表名額實際上已滿（排隊者優先於新單），不論 running 數字。
  if (stats.queued > 0) return 0
  return Math.max(0, stats.limit - stats.running)
}

export function createDispatcher(deps: DispatchDeps) {
  async function dispatch(kind: 'bug' | 'demand', ticket: string, techUser: TechUser, assigneeEmail: string): Promise<DispatchResult> {
    const localSide = deps.local[kind]
    const submitLocal = (): SubmitResult =>
      kind === 'bug' ? deps.local.bug.submit(ticket, techUser) : deps.local.demand.submit(ticket, assigneeEmail, techUser)

    // (1)(2) 重複防護——這兩個檢查與 (3) 佔位之間沒有任何 await，同一條
    // event loop 上的併發認領不可能雙雙通過。
    const localState = localSide.has(ticket)
    if (localState === 'running') return { ok: true, status: 'already_running' }
    if (localState === 'queued') return submitLocal() // 佇列自己回 already_queued（含順位）
    const remote = deps.registry.get(ticket)
    if (remote) return { ok: true, status: 'already_running_remote', worker: remote.worker || '(交涉中)' }

    const workers = deps.listWorkers()
    if (workers.length === 0) return submitLocal() // 單機模式：完全等同既有行為

    deps.registry.markDispatching(ticket, kind, { name: techUser.notion_user_name, email: techUser.email })
    try {
      // (4) 並行探測：名額 + 這張單在各 worker 的本機活動。
      const capacities = await Promise.all(workers.map(async w => ({ worker: w, cap: await deps.fetchCapacity(w, ticket) })))

      const activeOn = capacities.find(c => c.cap?.ticket?.active === true)
      if (activeOn) {
        // C-1 healing：這張單其實已在某台 worker 上跑（out-of-band run，
        // 登記表先前被 job-done 清掉）——回填登記，不起新 run。
        deps.registry.confirmDispatched(ticket, activeOn.worker.name, activeOn.worker.url)
        return { ok: true, status: 'already_running_remote', worker: activeOn.worker.name }
      }

      const candidates = capacities
        .filter(c => c.cap !== null)
        .map(c => ({ worker: c.worker, free: freeSlots(c.cap![kind]) }))
        .filter(c => c.free > 0)
        .sort((a, b) => b.free - a.free)

      const localFree = freeSlots(localSide.stats())
      const best = candidates[0]
      if (!best || localFree >= best.free) {
        // 平手本機優先；candidates 為空（全滿/全失聯）也落到這裡走本機佇列。
        deps.registry.clear(ticket)
        return submitLocal()
      }

      // (6) 只試最佳一台（M-2 預算約束）。
      const job: JobRequest = kind === 'bug' ? { kind, ticket, triggeredBy: techUser } : { kind, ticket, triggeredBy: techUser, assigneeEmail }
      const r = await deps.postJob(best.worker, job)
      if (r.accepted) {
        deps.registry.confirmDispatched(ticket, best.worker.name, best.worker.url)
        // worker 端自己發現這張單已有本機活動（探測與接單之間的視窗）→
        // 一樣回填登記，但回報語意是「已在跑」而非「已開始」。
        if (r.result.ok && r.result.status === 'already_running') {
          return { ok: true, status: 'already_running_remote', worker: best.worker.name }
        }
        return { ok: true, status: 'remote_started', worker: best.worker.name }
      }
      if (r.reason === 'ambiguous') {
        // 見檔頭：逾時不明＝保守當已接單，交給 sweeper 校正。
        deps.registry.confirmDispatched(ticket, best.worker.name, best.worker.url)
        return { ok: true, status: 'remote_started', worker: best.worker.name }
      }

      // full / rejected / unreachable：確定沒接單，退回本機。
      deps.registry.clear(ticket)
      return submitLocal()
    } catch (err) {
      // 防禦性收尾：探測/選擇過程任何未預期例外都不能留下永久佔位（那會讓
      // 這張單直到 sweeper 清理前都無法認領），清掉並退回本機路徑。
      console.error(`cluster-dispatch: ${ticket} 派工過程例外，退回本機執行: ${err}`)
      deps.registry.clear(ticket)
      return submitLocal()
    }
  }

  return {
    dispatchBug: (ticket: string, techUser: TechUser) => dispatch('bug', ticket, techUser, ''),
    dispatchDemand: (ticket: string, assigneeEmail: string, techUser: TechUser) => dispatch('demand', ticket, techUser, assigneeEmail),
  }
}
