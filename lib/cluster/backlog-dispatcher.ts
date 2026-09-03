import type { QueueEntry } from '../pipeline-runner/pipeline-queue.ts'
import type { BugPayload } from '../pipeline-runner/spawn-create-mr.ts'
import type { DemandPayload } from '../pipeline-runner/spawn-demand-pipeline.ts'
import { freeSlots, type DispatchAttemptWriteDeps } from './dispatch.ts'
import { DISPATCH_STATUS_RANK, type DispatchRegistry } from './dispatch-registry.ts'
import type { WorkerInfo } from './worker-registry.ts'
import type { CapacityReport, JobRequest, PostJobResult } from './worker-client.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

// head 佇列的 cluster-wide 遞補（2026-09-01 新增，拿掉 dispatch.ts 舊版 v1
// 已知限制：「本機 FIFO 佇列只認本機釋放的名額」）。純邏輯 + 依賴注入，比照
// dispatch.ts；production 接線在 cluster-head.ts。
//
// 兩條觸發路徑：
//   1. 事件驅動（主要）：worker 的 /cluster/job-done 回報到達時，cluster-head.ts
//      呼叫 fillFreedSlot(kind, worker)——這台剛釋放一個名額，把 head 佇列
//      隊頭遞補過去。本機釋放名額仍走既有 pipeline-queue.ts 的 drain()，
//      不受本模組影響——兩條路徑共用同一個 queue 陣列的隊頭，且都在同一個
//      同步區塊內完成「取出」，不會搶到同一張單（見 tryDispatchFront 註解）。
//   2. 週期性安全網：job-done 是 best-effort（worker 打不到 head 時無法送達）
//      ——sweepBacklog() 每輪（cluster-head.ts 接到跟 remote sweeper 同一顆
//      10 分鐘 timer）逐台探測名額，有剩就補試一次，防止漏接的 job-done
//      讓佇列卡住沒人救。
//
// 防重複派工的關鍵：fillFreedSlot 的 attempt 內第一行必須同步呼叫
// registry.markDispatching——tryDispatchFront 把單從佇列拿出來、到這裡登記
// 完成之前那段空窗，若被另一個幾乎同時的認領看到「佇列裡沒有、登記表也沒有」
// 就會誤判成沒人在處理而派出第二條。作法完全比照 dispatch.ts 既有認領路徑。

export type BacklogDispatcherDeps = {
  registry: DispatchRegistry
  postJob: (w: WorkerInfo, job: JobRequest) => Promise<PostJobResult>
  /** 週期性掃描用，不帶 ticket（比 dispatch.ts 的 fetchCapacity 少一個探測
   * 這張單活動狀態的用途——這裡本來就還沒選定要遞補哪張單）。 */
  fetchCapacity: (w: WorkerInfo) => Promise<CapacityReport | null>
  /** 呼叫端負責先過濾掉 disabled（跟 dispatch.ts 的 listWorkers 同一套過濾，
   * 過濾點放在 wiring 層，理由見 cluster-head.ts 對應註解）。 */
  listWorkers: () => WorkerInfo[]
  bug: { tryDispatchFront: (attempt: (entry: QueueEntry<BugPayload>) => Promise<boolean>) => Promise<'empty' | 'dispatched' | 'declined'> }
  demand: { tryDispatchFront: (attempt: (entry: QueueEntry<DemandPayload>) => Promise<boolean>) => Promise<'empty' | 'dispatched' | 'declined'> }
  /** monitor DB `dispatch_attempts` 觀察面寫入，比照 dispatch.ts（§5.3）。optional：
   * 省略時等同單機/測試模式，不寫入也不影響遞補正確性。 */
  dispatchAttempts?: DispatchAttemptWriteDeps
}

export type BacklogDispatcher = {
  /** worker 剛釋放一個 kind 名額（job-done 回報，或週期性探測發現有空位）：
   * 嘗試把 head 佇列隊頭遞補過去。佇列空／隊頭全部被 skipReason 濾掉／
   * worker 拒絕都是正常結束，不拋例外。 */
  fillFreedSlot: (kind: 'bug' | 'demand', worker: WorkerInfo) => Promise<void>
  /** job-done 遺失時的安全網：逐台探測名額，有剩就補試一次遞補。 */
  sweepBacklog: () => Promise<void>
}

function toTechUser(triggeredBy: QueueEntry<unknown>['triggeredBy']): TechUser | undefined {
  return triggeredBy ? { notion_user_id: '', notion_user_name: triggeredBy.name, email: triggeredBy.email } : undefined
}

function buildJobRequest(kind: 'bug', entry: QueueEntry<BugPayload>, dispatchId: string): JobRequest
function buildJobRequest(kind: 'demand', entry: QueueEntry<DemandPayload>, dispatchId: string): JobRequest
function buildJobRequest(kind: 'bug' | 'demand', entry: QueueEntry<BugPayload> | QueueEntry<DemandPayload>, dispatchId: string): JobRequest {
  const triggeredBy = toTechUser(entry.triggeredBy)
  if (kind === 'bug') {
    const e = entry as QueueEntry<BugPayload>
    return { kind: 'bug', ticket: e.ticket, resume: e.payload.resume, triggeredBy, dispatchId }
  }
  const e = entry as QueueEntry<DemandPayload>
  return { kind: 'demand', ticket: e.ticket, assigneeEmail: e.payload.assigneeEmail, triggeredBy, dispatchId }
}

export function createBacklogDispatcher(deps: BacklogDispatcherDeps): BacklogDispatcher {
  // sweepBacklog 的重入防護（比照 remote-sweeper.ts 的 sweeping 旗標）：
  // 一輪要對每台 worker × 兩個 kind 各打一次網路，理論上可能拖過下一次
  // 10 分鐘 timer，避免疊加。
  let sweeping = false

  const attempts = deps.dispatchAttempts

  async function fillFreedSlot(kind: 'bug' | 'demand', worker: WorkerInfo): Promise<void> {
    if (kind === 'bug') {
      await deps.bug.tryDispatchFront(async entry => {
        // 防禦性預檢（不變量：進到 head 佇列的單不該同時有登記表條目——正常
        // 路徑下 dispatch.ts 放單進佇列前一定先 clear，這裡不可能碰到非 null；
        // 加這道檢查是為了不讓這個不變量無聲失守，一旦未來出現新的入隊路徑
        // 忘了先 clear，這裡會保守拒絕、不覆蓋/不清掉別處正在用的登記，而不是
        // 靜默蓋掉它）。
        if (deps.registry.get(entry.ticket) !== null) {
          console.error(`backlog-dispatcher: ${entry.ticket} 進佇列時已有登記表條目，跳過本次遞補（不應發生，需人工檢查）`)
          return false
        }
        // 同步佔位：見檔頭註解，必須是 attempt 的第一行、postJob 的 await 之前。
        const dispatchId = deps.registry.markDispatching(entry.ticket, 'bug', entry.triggeredBy)
        const dispatchedAt = new Date().toISOString()
        // MA-3/MI-10：與 dispatch.ts 的直接派工路徑對齊——先把同票殘留的
        // 未終態 attempt 標 superseded，create 帶 headRunId（backlog 條目在
        // head 有 onEnqueued 寫的 queued run 列，這是 §5.3 的對位鍵；直接派工
        // 路徑沒有 head 列所以不帶）。
        attempts?.supersedeOthers?.({ ticket: entry.ticket, kind: 'bug', excludeDispatchId: dispatchId })
        attempts?.create({
          dispatchId,
          ticket: entry.ticket,
          kind: 'bug',
          status: 'dispatching',
          statusRank: DISPATCH_STATUS_RANK.dispatching,
          dispatchedAt,
          headRunId: entry.payload.runId,
          triggeredByEmail: entry.triggeredBy?.email ?? null,
        })
        const r = await deps.postJob(worker, buildJobRequest('bug', entry, dispatchId))
        if (r.accepted || r.reason === 'ambiguous') {
          deps.registry.confirmDispatched(entry.ticket, worker.name, worker.url)
          attempts?.advance({
            dispatchId,
            status: 'dispatched',
            statusRank: DISPATCH_STATUS_RANK.dispatched,
            confirmedAt: new Date().toISOString(),
            remoteRunId: r.accepted ? r.runId : null,
          })
          return true
        }
        // full/rejected/unreachable：確定沒接單，撤掉佔位，讓單塞回隊頭。
        deps.registry.clear(entry.ticket)
        attempts?.advance({ dispatchId, status: 'cleared', statusRank: DISPATCH_STATUS_RANK.terminal, clearedAt: new Date().toISOString(), clearReason: r.reason })
        return false
      })
      return
    }
    await deps.demand.tryDispatchFront(async entry => {
      if (deps.registry.get(entry.ticket) !== null) {
        console.error(`backlog-dispatcher: ${entry.ticket} 進佇列時已有登記表條目，跳過本次遞補（不應發生，需人工檢查）`)
        return false
      }
      const dispatchId = deps.registry.markDispatching(entry.ticket, 'demand', entry.triggeredBy)
      const dispatchedAt = new Date().toISOString()
      // MA-3/MI-10：同上方 bug 分支的對齊（supersede 殘留 + headRunId 對位鍵）。
      attempts?.supersedeOthers?.({ ticket: entry.ticket, kind: 'demand', excludeDispatchId: dispatchId })
      attempts?.create({
        dispatchId,
        ticket: entry.ticket,
        kind: 'demand',
        status: 'dispatching',
        statusRank: DISPATCH_STATUS_RANK.dispatching,
        dispatchedAt,
        headRunId: entry.payload.runId,
        triggeredByEmail: entry.triggeredBy?.email ?? null,
      })
      const r = await deps.postJob(worker, buildJobRequest('demand', entry, dispatchId))
      if (r.accepted || r.reason === 'ambiguous') {
        deps.registry.confirmDispatched(entry.ticket, worker.name, worker.url)
        attempts?.advance({
          dispatchId,
          status: 'dispatched',
          statusRank: DISPATCH_STATUS_RANK.dispatched,
          confirmedAt: new Date().toISOString(),
          remoteRunId: r.accepted ? r.runId : null,
        })
        return true
      }
      deps.registry.clear(entry.ticket)
      attempts?.advance({ dispatchId, status: 'cleared', statusRank: DISPATCH_STATUS_RANK.terminal, clearedAt: new Date().toISOString(), clearReason: r.reason })
      return false
    })
  }

  async function sweepBacklog(): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      for (const w of deps.listWorkers()) {
        const cap = await deps.fetchCapacity(w)
        if (!cap) continue
        if (freeSlots(cap.bug) > 0) await fillFreedSlot('bug', w)
        if (freeSlots(cap.demand) > 0) await fillFreedSlot('demand', w)
      }
    } finally {
      sweeping = false
    }
  }

  return { fillFreedSlot, sweepBacklog }
}
