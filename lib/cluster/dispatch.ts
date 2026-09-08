import type { SubmitResult } from '../pipeline-runner/pipeline-queue.ts'
import { DISPATCH_STATUS_RANK, type DispatchRegistry } from './dispatch-registry.ts'
import type { WorkerInfo } from './worker-registry.ts'
import type { CapacityReport, JobRequest, PostJobResult, QueueStats } from './worker-client.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'
import type { BugMode } from '../pipeline-runner/bug-mode.ts'

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
// 本機 FIFO 佇列裡的單改成 cluster-wide 遞補（見 lib/cluster/
// backlog-dispatcher.ts，2026-09-01 新增）：head 本機釋放名額仍走這裡
// submitLocal 之後的既有 drain()；worker 釋放名額則由 backlog-dispatcher.ts
// 在 /cluster/job-done 收到回報時、以及週期性掃描時，把佇列隊頭遞補過去。
// 兩條路徑共用同一個 pipeline-queue 的 `queue` 陣列（新增的 tryDispatchFront
// 方法），只操作隊頭且中間不夾 await，天然不會搶到同一張單。
//
// v1 已知限制（記錄於 README，仍未解的部分）：
// - 步驟 4 的探測對「當下失聯的 worker」問不到活動狀態：若那台正好在跑這
//   張單又正好斷線，重複防護退回登記表本身（正常都在）；登記表也沒有時
//   （job-done 已清 + out-of-band 重跑 + 該機斷線三者疊加）是已接受的殘餘
//   風險，靠 sweeper 的失聯保守策略與維運告警兜底。

export type DispatchResult =
  | SubmitResult
  | { ok: true; status: 'remote_started'; worker: string }
  | { ok: true; status: 'already_running_remote'; worker: string }

/**
 * monitor DB `dispatch_attempts` 的觀察面寫入（plan-db-as-truth-v3.md §5.3）。
 * 純 fire-and-forget：呼叫端（dispatch.ts/backlog-dispatcher.ts/remote-sweeper.ts）
 * 一律不 await，也不管成功失敗——這張表只給 tg-monitor 面板觀察用，真正的派工
 * 正確性完全由 DispatchRegistry 的磁碟持久化 + registry 的同步佔位保證（R1：
 * head 對遠端 run 一律只寫 dispatch_attempts，絕不碰 runs）。production 端
 * 實作（cluster-head.ts）負責 isMonitorDbEnabled() 判斷與錯誤吞噬；測試/單機
 * 模式可以整組省略（optional）。
 */
export type DispatchAttemptWriteDeps = {
  /** §5.3（MJ-C6 後半）：markDispatching 鑄新 dispatchId 後，對同
   * (ticket, kind) 的所有未終結（status_rank<100）舊列一併寫 superseded。
   * Optional：舊測試/單機模式可省略，行為等同不寫觀察面（不影響正確性）。 */
  supersedeOthers?: (input: { ticket: string; kind: 'bug' | 'demand'; excludeDispatchId: string }) => void
  /** 第一次一定是建立列，dispatchId 由 DispatchRegistry.markDispatching 鑄好。 */
  create: (input: {
    dispatchId: string
    ticket: string
    kind: 'bug' | 'demand'
    status: string
    statusRank: number
    dispatchedAt: string
    triggeredByEmail?: string | null
  }) => void
  /** status_rank 單調前進（見 dispatch-registry.ts 的 DISPATCH_STATUS_RANK）。
   * workerName/workerUrl：worker 在 create() 當下（'dispatching'）還不知道，
   * 第一次 advance 到 'dispatched' 才選定——寫入端用 COALESCE 補空，這裡未帶
   * 值時不會清掉已寫好的 worker 資訊（見 writes.ts advanceDispatchAttempt）。 */
  advance: (input: {
    dispatchId: string
    status: string
    statusRank: number
    confirmedAt?: string | null
    clearedAt?: string | null
    clearReason?: string | null
    remoteRunId?: string | null
    workerName?: string | null
    workerUrl?: string | null
  }) => void
}

/** bug 派工的附加選項：resume（續跑，tg-monitor 重試/自動重試）與 mode
 * （執行模式，claim.ts 依 Notion AI分析 值決定）正交，可同時存在。 */
export type BugDispatchOpts = { resume?: boolean; mode?: BugMode }

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
      /** triggeredBy 可為 null（2026-09-04，task 2：tg-monitor 的續跑不一定
       * 查得到原認領人 email）；opts.resume 同上新增，讓 tg-monitor 的
       * `/api/pipelines/retry` 走這條分派路徑時能帶 `--resume` 語意。 */
      submit: (ticket: string, triggeredBy: TechUser | null, opts?: BugDispatchOpts) => SubmitResult
    }
    demand: {
      stats: () => QueueStats
      has: (ticket: string) => 'running' | 'queued' | null
      submit: (ticket: string, assigneeEmail: string, triggeredBy: TechUser | null) => SubmitResult
    }
  }
  dispatchAttempts?: DispatchAttemptWriteDeps
}

/** 剩餘名額判斷：有單在排隊代表名額實際上已滿（排隊者優先於新單），不論
 * running 數字。export 給 lib/cluster/backlog-dispatcher.ts 的週期性掃描共用，
 * 避免兩處各自實作同一個判斷而漂移。 */
export function freeSlots(stats: QueueStats): number {
  if (stats.queued > 0) return 0
  return Math.max(0, stats.limit - stats.running)
}

export function createDispatcher(deps: DispatchDeps) {
  /**
   * techUser 可為 null（2026-09-04，task 2）：一般派工（claim.ts/demand-claim.ts）
   * 一律有真實 Telegram 使用者、恆非 null；tg-monitor 的續跑走 HTTP 呼叫
   * `/cluster/retry`，原認領人 email 查不到時就是 null——比照 submitCreateMr
   * 既有的 `opts.triggeredBy?: TechUser` optional 語意（QueueTriggeredBy 本來
   * 就是 `{name,email}|null`），不用一個假造的使用者物件頂替。
   *
   * opts.resume：只有 bug 支援（demand 目前沒有 resume 機制，見
   * cluster-head.ts `/cluster/retry` 只接受 FAQ- 的註解）。
   */
  async function dispatch(
    kind: 'bug' | 'demand',
    ticket: string,
    techUser: TechUser | null,
    assigneeEmail: string,
    opts?: BugDispatchOpts,
  ): Promise<DispatchResult> {
    const localSide = deps.local[kind]
    const submitLocal = (): SubmitResult =>
      kind === 'bug' ? deps.local.bug.submit(ticket, techUser, opts) : deps.local.demand.submit(ticket, assigneeEmail, techUser)

    // (1)(2) 重複防護——這兩個檢查與 (3) 佔位之間沒有任何 await，同一條
    // event loop 上的併發認領不可能雙雙通過。
    const localState = localSide.has(ticket)
    if (localState === 'running') return { ok: true, status: 'already_running' }
    if (localState === 'queued') return submitLocal() // 佇列自己回 already_queued（含順位）
    const remote = deps.registry.get(ticket)
    if (remote) return { ok: true, status: 'already_running_remote', worker: remote.worker || '(交涉中)' }

    const workers = deps.listWorkers()
    if (workers.length === 0) return submitLocal() // 單機模式：完全等同既有行為

    const attempts = deps.dispatchAttempts
    const dispatchId = deps.registry.markDispatching(ticket, kind, techUser ? { name: techUser.notion_user_name, email: techUser.email } : null)
    const dispatchedAt = new Date().toISOString()
    attempts?.supersedeOthers?.({ ticket, kind, excludeDispatchId: dispatchId })
    attempts?.create({ dispatchId, ticket, kind, status: 'dispatching', statusRank: DISPATCH_STATUS_RANK.dispatching, dispatchedAt, triggeredByEmail: techUser?.email })
    try {
      // (4) 並行探測：名額 + 這張單在各 worker 的本機活動。
      const capacities = await Promise.all(workers.map(async w => ({ worker: w, cap: await deps.fetchCapacity(w, ticket) })))

      const activeOn = capacities.find(c => c.cap?.ticket?.active === true)
      if (activeOn) {
        // C-1 healing：這張單其實已在某台 worker 上跑（out-of-band run，
        // 登記表先前被 job-done 清掉）——回填登記，不起新 run。
        deps.registry.confirmDispatched(ticket, activeOn.worker.name, activeOn.worker.url)
        attempts?.advance({
          dispatchId,
          status: 'dispatched',
          statusRank: DISPATCH_STATUS_RANK.dispatched,
          confirmedAt: new Date().toISOString(),
          workerName: activeOn.worker.name,
          workerUrl: activeOn.worker.url,
        })
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
        attempts?.advance({
          dispatchId,
          status: 'cleared',
          statusRank: DISPATCH_STATUS_RANK.terminal,
          clearedAt: new Date().toISOString(),
          clearReason: 'no_remote_capacity',
        })
        return submitLocal()
      }

      // (6) 只試最佳一台（M-2 預算約束）。dispatchId 隨請求一併送出（§5.3）：
      // 即使 postJob 逾時拿不到回應 body，worker 端把它寫進自己鑄的 runs.dispatch_id
      // 欄，事後仍能用 runs.dispatch_id = dispatch_attempts.dispatch_id 精確 join。
      const job: JobRequest =
        kind === 'bug'
          ? { kind, ticket, triggeredBy: techUser ?? undefined, dispatchId, ...(opts?.resume ? { resume: true } : {}), ...(opts?.mode ? { mode: opts.mode } : {}) }
          : { kind, ticket, triggeredBy: techUser ?? undefined, assigneeEmail, dispatchId }
      const r = await deps.postJob(best.worker, job)
      if (r.accepted) {
        deps.registry.confirmDispatched(ticket, best.worker.name, best.worker.url)
        attempts?.advance({
          dispatchId,
          status: 'dispatched',
          statusRank: DISPATCH_STATUS_RANK.dispatched,
          confirmedAt: new Date().toISOString(),
          remoteRunId: r.runId,
          workerName: best.worker.name,
          workerUrl: best.worker.url,
        })
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
        attempts?.advance({
          dispatchId,
          status: 'dispatched',
          statusRank: DISPATCH_STATUS_RANK.dispatched,
          confirmedAt: new Date().toISOString(),
          workerName: best.worker.name,
          workerUrl: best.worker.url,
        })
        return { ok: true, status: 'remote_started', worker: best.worker.name }
      }

      // full / rejected / unreachable：確定沒接單，退回本機。
      deps.registry.clear(ticket)
      attempts?.advance({
        dispatchId,
        status: 'cleared',
        statusRank: DISPATCH_STATUS_RANK.terminal,
        clearedAt: new Date().toISOString(),
        clearReason: r.reason,
      })
      return submitLocal()
    } catch (err) {
      // 防禦性收尾：探測/選擇過程任何未預期例外都不能留下永久佔位（那會讓
      // 這張單直到 sweeper 清理前都無法認領），清掉並退回本機路徑。
      console.error(`cluster-dispatch: ${ticket} 派工過程例外，退回本機執行: ${err}`)
      deps.registry.clear(ticket)
      attempts?.advance({
        dispatchId,
        status: 'cleared',
        statusRank: DISPATCH_STATUS_RANK.terminal,
        clearedAt: new Date().toISOString(),
        clearReason: 'exception',
      })
      return submitLocal()
    }
  }

  return {
    dispatchBug: (ticket: string, techUser: TechUser | null, opts?: BugDispatchOpts) => dispatch('bug', ticket, techUser, '', opts),
    dispatchDemand: (ticket: string, assigneeEmail: string, techUser: TechUser | null) => dispatch('demand', ticket, techUser, assigneeEmail),
  }
}
