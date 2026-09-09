import { CLUSTER_TOKEN_HEADER } from './cluster-auth.ts'
import type { SubmitResult } from '../pipeline-runner/pipeline-queue.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'
import type { ProgressStage } from '../pipeline-runner/ticket-progress.ts'
import type { BugMode } from '../pipeline-runner/bug-mode.ts'

// head → worker 的 HTTP client。所有呼叫都帶 AbortSignal.timeout——這是
// 網路 I/O 的逾時上限（打不通就放棄、走下一個候選），不是用等待解決任何
// 正確性問題；派工的正確性由 dispatch-registry 的同步佔位與 worker 端
// submit 的去重結構保證。
//
// 逾時預算（對抗性 review 2026-08-31 M-2 修正）：grammy webhook handler 的
// 總預算是 10 秒（server.ts 明文維持預設），認領熱路徑上的派工探測必須留在
// 這個預算內——/capacity 2.5 秒（in-memory + 鎖目錄 + 一次 ps，LAN 上綽綽
// 有餘）、POST /jobs 6 秒（含 worker 端 ensureTrackerPending 的一次 Notion
// 查詢，實測量級 1–3 秒；逾時走 ambiguous 保守路徑，不重派）。dispatch 只
// 試一台最佳候選（不輪詢多台），最壞 2.5+6 秒，加上游 Notion 查詢仍在預算
// 內。/jobs/:ticket 5 秒只用在 sweeper 與 /status，不在認領熱路徑。

export type QueueStats = { limit: number; running: number; queued: number }
export type CapacityReport = {
  worker: string
  bug: QueueStats
  demand: QueueStats
  /** 帶 ?ticket= 探測時回傳：這張單在該 worker 是否有任何本機活動（queue ∪
   * 鎖 ∪ ps，見 local-activity.ts）。head 派工前靠這個發現 out-of-band 的
   * run 並就地回填登記表（C-1 修正）。 */
  ticket?: { ticket: string; active: boolean }
}

export type JobRequest = {
  kind: 'bug' | 'demand'
  ticket: string
  resume?: boolean
  /** bug 專用：pipeline 執行模式（plan-pipeline-modes-v1 §2.2）。省略＝full。
   * worker 端 /jobs 會用 isBugMode() 驗值域，不合法整個請求 400。 */
  mode?: BugMode
  /** bug 專用：認領當下 Notion「AI分析」的原始值，worker 收到後原樣寫進自己
   * 鑄的 runs.initial_ai_analysis（見 monitor-db migration 007）。demand 目前
   * 不走這條（demand 的遠端執行還沒鑄 run_id，見 worker-agent.ts 註解）。 */
  aiAnalysis?: string
  triggeredBy?: TechUser
  assigneeEmail?: string
  /** head 端 dispatch-registry.ts 鑄的 monitor DB `dispatch_attempts.dispatch_id`
   * （plan-db-as-truth-v3.md §5.3）。worker 收到後把它寫進自己鑄的 `runs.dispatch_id`
   * 欄——即使 postJob 逾時（ambiguous）拿不到回應 body，事後仍能用
   * `runs.dispatch_id = dispatch_attempts.dispatch_id` 精確 join。目前 worker 側
   * 的 submitCreateMr/submitDemandPipeline（lib/pipeline-runner/）尚未開放接受
   * 這個參數並寫入 runs——本欄位先在協定層落地，等該介面補上即可串接。 */
  dispatchId?: string
}

export type PostJobResult =
  /** runId：worker `/jobs` 回應目前固定帶 `run_id: null`（見
   * worker-agent.ts §5.4 的註解——run_id 尚無管道取得，等 pipeline-runner
   * 開放介面後這裡會拿到真值）。型別先留好，呼叫端（dispatch.ts）可以直接
   * 塞進 dispatch_attempts.remote_run_id，值是 null 時就是「暫時還沒有」。 */
  | { accepted: true; result: SubmitResult; runId: string | null }
  | { accepted: false; reason: 'full' | 'rejected' | 'unreachable' }
  /** 逾時＝結果不明：worker 可能已接單只是回應沒回來。呼叫端（dispatch.ts）
   * 對這種情況絕不能改派其他機器（會造成兩台跑同一張單），只能保守當作
   * 已接單、交給 remote-sweeper 事後校正。 */
  | { accepted: false; reason: 'ambiguous' }

export type JobStatus = { locked: boolean; queueState: 'running' | 'queued' | null; progress: string | null; stages?: ProgressStage[] }

function headers(secret: string): Record<string, string> {
  return { [CLUSTER_TOKEN_HEADER]: secret, 'content-type': 'application/json' }
}

function isTimeoutLike(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? ''
  return name === 'TimeoutError' || name === 'AbortError'
}

/** 探測 worker 名額（可帶 ticket 一併問這張單在該機的活動狀態）。打不通/
 * 格式不對回 null（派工選擇會跳過這台）。 */
export async function fetchWorkerCapacity(url: string, secret: string, ticket?: string, timeoutMs = 2_500): Promise<CapacityReport | null> {
  try {
    const qs = ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''
    const res = await fetch(`${url}/capacity${qs}`, { headers: headers(secret), signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as CapacityReport
    if (typeof body?.bug?.limit !== 'number' || typeof body?.demand?.limit !== 'number') return null
    return body
  } catch {
    return null
  }
}

export async function postWorkerJob(url: string, secret: string, job: JobRequest, timeoutMs = 6_000): Promise<PostJobResult> {
  try {
    const res = await fetch(`${url}/jobs`, {
      method: 'POST',
      headers: headers(secret),
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 409) return { accepted: false, reason: 'full' }
    if (!res.ok) return { accepted: false, reason: 'rejected' }
    const body = (await res.json()) as SubmitResult & { run_id?: string | null }
    if (body?.ok !== true) return { accepted: false, reason: 'rejected' }
    const { run_id, ...result } = body
    return { accepted: true, result: result as SubmitResult, runId: run_id ?? null }
  } catch (err) {
    // 連線層立即失敗（refused/DNS）＝確定沒送達，可以安全改派；逾時＝不明。
    return { accepted: false, reason: isTimeoutLike(err) ? 'ambiguous' : 'unreachable' }
  }
}

/** 查 worker 上某張單的實況（進度描述 + 鎖/佇列狀態）。打不通回 null——
 * 呼叫端自行決定是「暫時查不到進度」還是「累計失聯次數」（sweeper）。 */
export async function fetchWorkerJobStatus(url: string, secret: string, ticket: string, timeoutMs = 5_000): Promise<JobStatus | null> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}`, { headers: headers(secret), signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as JobStatus
    if (typeof body?.locked !== 'boolean') return null
    return body
  } catch {
    return null
  }
}

/** worker-agent.ts 的 `CancelLocalPipelineResult`（見 lib/pipeline-runner/
 * local-cancel.ts）——本檔不 import 那個型別（worker-agent.ts 是入口檔，不是
 * 給其他模組 import 的函式庫），這裡只聲明呼叫端（tg-monitor 的
 * cancelPipeline 轉發路徑）需要的最小形狀。 */
export type RemoteCancelResult = {
  ok: boolean
  killed: number[]
  wrapperPid?: number
  reason?: string
  runId?: string
  runIdResolvedBy?: string
  flagWritten?: boolean
}

/**
 * 轉發取消請求給 worker 的 `POST /jobs/:ticket/cancel`（2026-09-04 新增，
 * task 3）。打不通/逾時一律回 `{ok: false, reason: 'unreachable'}`——呼叫端
 * （tg-monitor 的 `/api/pipelines/cancel`）據此顯示「取消失敗」，不用像
 * `postWorkerJob` 那樣區分 ambiguous（取消沒有「兩台同時取消」的雙跑風險，
 * 逾時重按一次即可，不需要保守語意）。
 */
export async function cancelRemoteJob(url: string, secret: string, ticket: string, timeoutMs = 8_000): Promise<RemoteCancelResult> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}/cancel`, {
      method: 'POST',
      headers: headers(secret),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => null)) as RemoteCancelResult | null
    if (!body || typeof body.ok !== 'boolean') return { ok: false, killed: [], reason: `worker 回應格式不對（HTTP ${res.status}）` }
    return body
  } catch (err) {
    return { ok: false, killed: [], reason: isTimeoutLike(err) ? 'worker 逾時未回應' : 'worker 連不上' }
  }
}

/** worker `GET /files` 的回應形狀（task 1，2026-09-04）。與 cancelRemoteJob 同一
 * 風格：呼叫端（tg-monitor 的 `/api/agent-trace` 代理路徑）需要的最小形狀，本檔
 * 不 import worker-agent.ts 的內部型別（同上方 RemoteCancelResult 註解的理由）。
 * head 這一份跟 cancelRemoteJob 一樣是參考實作——真正呼叫它的是 tg-monitor 自己
 * 在 lib/cluster-state.ts 複製的一份（兩個 repo 沒有 import 關係，見該檔頭）。 */
export type RemoteFileResult = { ok: true; content: string } | { ok: false; reason: string }

/** 讀取 worker 白名單目錄下某個檔案的內容（task 1：head 的 /api/agent-trace 對
 * worker 執行的 run proxy 用）。打不通/逾時/被白名單拒絕都回 `{ok:false}`，
 * reason 帶可讀訊息，不拋例外。 */
export async function fetchRemoteFile(url: string, secret: string, path: string, timeoutMs = 8_000): Promise<RemoteFileResult> {
  try {
    const res = await fetch(`${url}/files?path=${encodeURIComponent(path)}`, { headers: headers(secret), signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; content?: string; reason?: string } | null
    if (!body || body.ok !== true || typeof body.content !== 'string') {
      return { ok: false, reason: body?.reason ?? `worker 回應格式不對（HTTP ${res.status}）` }
    }
    return { ok: true, content: body.content }
  } catch (err) {
    return { ok: false, reason: isTimeoutLike(err) ? 'worker 逾時未回應' : 'worker 連不上' }
  }
}

/** worker `GET /jobs/:ticket/stage-files` 的回應形狀（task 1）——見
 * lib/pipeline-runner/local-stage-files.ts 的 LocalStageFiles。 */
export type RemoteStageFiles = { debugFiles: Record<string, string | null>; worktreeBootstrapLog: string | null }

/** 這張 bug 票在 worker 上的階段產物檔 mtime 原始資料（task 1：head 的
 * computeBugStages() 組裝用）。打不通/逾時/格式不對回 null。 */
export async function fetchRemoteStageFiles(url: string, secret: string, ticket: string, timeoutMs = 8_000): Promise<RemoteStageFiles | null> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}/stage-files`, { headers: headers(secret), signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; debugFiles?: unknown; worktreeBootstrapLog?: unknown }
    if (body?.ok !== true || typeof body.debugFiles !== 'object' || body.debugFiles === null) return null
    return { debugFiles: body.debugFiles as Record<string, string | null>, worktreeBootstrapLog: (body.worktreeBootstrapLog as string | null) ?? null }
  } catch {
    return null
  }
}
