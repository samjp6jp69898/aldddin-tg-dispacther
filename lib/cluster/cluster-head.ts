import { join } from 'node:path'
import type { Hono } from 'hono'
import { getClusterSecret, CLUSTER_TICKET_RE, WORKER_NAME_RE } from './cluster-env.ts'
import { createClusterAuthGuard } from './cluster-auth.ts'
import { createWorkerRegistry } from './worker-registry.ts'
import { createDispatchRegistry, type DispatchEntry } from './dispatch-registry.ts'
import { createDispatcher, type DispatchResult } from './dispatch.ts'
import { createRemoteSweeper } from './remote-sweeper.ts'
import { fetchWorkerCapacity, fetchWorkerJobStatus, postWorkerJob } from './worker-client.ts'
import { submitCreateMr, getBugQueueStats, hasBugTicketActive, notifyQueueEvent } from '../pipeline-runner/spawn-create-mr.ts'
import { submitDemandPipeline, getDemandQueueStats, hasDemandTicketActive, resetAiAnalysisForReclaim } from '../pipeline-runner/spawn-demand-pipeline.ts'
import { notifyOperator } from '../notify/operator.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

// head 端多機派工的 production 接線（唯一入口）。dispatch.ts / remote-sweeper.ts
// 是純邏輯，這裡負責把真實依賴（worker-client、spawn 模組、registry 檔案
// 路徑、通知管道）接上，並提供 claim.ts / demand-claim.ts / status-list.ts /
// server.ts 要用的 facade。CLUSTER_SHARED_SECRET 未設定時（單機部署，現況）：
//   - dispatchBug/dispatchDemand 直接等同 submitCreateMr/submitDemandPipeline
//   - registerClusterRoutes / initClusterHead 是 no-op
// 行為與加入 cluster 之前 100% 相同（見 cluster-env.ts 檔頭不變式）。

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'

const secret = getClusterSecret()
const workerRegistry = createWorkerRegistry(join(LOG_DIR, 'cluster-workers.json'))
const dispatchRegistry = createDispatchRegistry(join(LOG_DIR, 'cluster-dispatched.json'))

const dispatcher = createDispatcher({
  registry: dispatchRegistry,
  listWorkers: () => (secret === null ? [] : workerRegistry.list()),
  fetchCapacity: (w, ticket) => fetchWorkerCapacity(w.url, secret ?? '', ticket),
  postJob: (w, job) => postWorkerJob(w.url, secret ?? '', job),
  local: {
    bug: {
      stats: getBugQueueStats,
      has: hasBugTicketActive,
      submit: (ticket, techUser) => submitCreateMr(ticket, { triggeredBy: techUser }),
    },
    demand: {
      stats: getDemandQueueStats,
      has: hasDemandTicketActive,
      submit: (ticket, assigneeEmail, techUser) => submitDemandPipeline(ticket, assigneeEmail, techUser),
    },
  },
})

const sweeper = createRemoteSweeper({
  registry: dispatchRegistry,
  listWorkers: () => workerRegistry.list(),
  fetchStatus: (url, ticket) => fetchWorkerJobStatus(url, secret ?? '', ticket),
  notifyOperator,
  notifyUser: notifyQueueEvent,
  resetDemand: resetAiAnalysisForReclaim,
})

export function isClusterEnabled(): boolean {
  return secret !== null
}

/** claim.ts 的 submitCreateMr 替身：cluster 停用或無 worker 時走本機（等同
 * 既有行為），否則依名額派工。 */
export function dispatchBug(ticket: string, techUser: TechUser): Promise<DispatchResult> {
  return dispatcher.dispatchBug(ticket, techUser)
}

export function dispatchDemand(ticket: string, assigneeEmail: string, techUser: TechUser): Promise<DispatchResult> {
  return dispatcher.dispatchDemand(ticket, assigneeEmail, techUser)
}

/** 這張單目前是否派在某台 worker 上（claim.ts 的 isTicketLocked 遠端對應）。 */
export function getRemoteEntry(ticket: string): DispatchEntry | null {
  return dispatchRegistry.get(ticket)
}

export function listRemoteEntries(): DispatchEntry[] {
  return dispatchRegistry.list()
}

/** 遠端執行中的單的進度描述（/status 與重複點擊回覆用）：即時問 worker，
 * 打不通就退回只講「在哪台」的保底文字。 */
export async function describeRemoteProgress(entry: DispatchEntry): Promise<string> {
  if (entry.status === 'confirmed' && entry.workerUrl !== '' && secret !== null) {
    const status = await fetchWorkerJobStatus(entry.workerUrl, secret, entry.ticket)
    if (status?.progress) return `${status.progress}\n（執行於 worker：${entry.worker}）`
    if (status?.queueState === 'queued') return `${entry.ticket} 已派工至 worker ${entry.worker}，目前在該機佇列中等待名額。`
  }
  return `${entry.ticket} 已派工至 worker ${entry.worker || '(交涉中)'}，執行中（進度查詢暫時無法取得）。`
}

/**
 * head 的 /cluster/* 路由（worker 登記 + job-done 回報）。掛在既有 8787
 * Hono app 上：必須在 server.ts 的 catch-all `app.all('*')` 之前註冊。
 * 全部經 cluster auth（含 rejectTunnel——這組路由只給 LAN 上的 worker 用，
 * 經 cloudflared tunnel 進來的一律 401，見 cluster-auth.ts 檔頭；⚠️ 這道
 * 防線依賴「對外 tunnel 是 cloudflared、會注入 CF-Connecting-IP」這個部署
 * 事實，若日後回退 ngrok 等其他 tunnel，/cluster/* 會變成公網可達（仍需
 * token），必須另補防線）。
 */
export function registerClusterRoutes(app: Hono): void {
  if (secret === null) return
  const guard = createClusterAuthGuard(secret, { rejectTunnel: true })

  app.post('/cluster/register', guard, async c => {
    const body = (await c.req.json().catch(() => null)) as { name?: string; url?: string } | null
    if (!body || typeof body.name !== 'string' || typeof body.url !== 'string' || !workerRegistry.register(body.name, body.url)) {
      return c.json({ ok: false }, 400)
    }
    console.error(`cluster: worker 登記 ${body.name} → ${body.url}`)
    return c.json({ ok: true })
  })

  app.post('/cluster/job-done', guard, async c => {
    const body = (await c.req.json().catch(() => null)) as { ticket?: string; worker?: string } | null
    if (!body || typeof body.ticket !== 'string' || !CLUSTER_TICKET_RE.test(body.ticket)) {
      return c.json({ ok: false }, 400)
    }
    // 回報者身分驗證（對抗性 review 2026-08-31 M-4）：worker 名稱格式必須
    // 合法（也杜絕 log 注入），且只有「登記上記載的那台」能清自己的登記——
    // 另一台機器因舊佇列殘留重跑同一張單時的 job-done，不准清掉正主的登記。
    // 不匹配仍回 ok（冪等語意：對回報者而言它的 run 確實結束了）。
    const worker = typeof body.worker === 'string' && WORKER_NAME_RE.test(body.worker) ? body.worker : null
    if (worker === null) return c.json({ ok: false }, 400)
    const entry = dispatchRegistry.get(body.ticket)
    if (entry !== null && entry.status === 'confirmed' && entry.worker !== worker) {
      console.error(`cluster: 忽略 ${body.ticket} 的 job-done——回報者 ${worker} 與登記的執行機 ${entry.worker} 不符`)
      return c.json({ ok: true })
    }
    dispatchRegistry.clear(body.ticket)
    sweeper.noteCleared(body.ticket) // M-3：失聯計數與告警旗標一併歸零
    console.error(`cluster: ${body.ticket} 於 worker ${worker} 執行結束（job-done 回報）`)
    return c.json({ ok: true })
  })
}

const SWEEP_INTERVAL_MS = 10 * 60_000

let started = false

/** 只給 head 的 server.ts 啟動時呼叫一次：撿回重啟前的派工登記 + 啟動
 * remote sweeper（週期性排程器，重疊防護在 sweeper 內）。cluster 停用時是
 * no-op。 */
export function initClusterHead(): void {
  if (secret === null || started) return
  started = true
  const recovered = dispatchRegistry.recoverFromDisk()
  if (recovered > 0) console.error(`cluster: 撿回 ${recovered} 筆重啟前的遠端派工登記（含 dispatching 待求證條目，交由 sweeper 校正）`)
  setInterval(() => {
    sweeper.sweep().catch(err => console.error(`cluster: sweep 失敗: ${err}`))
  }, SWEEP_INTERVAL_MS)
  console.error(
    `cluster: head 模式啟用（已登記 worker：${workerRegistry.list().map(w => w.name).join(', ') || '無'}；/cluster/* 的公網封鎖依賴 cloudflared 注入 CF-Connecting-IP，換 tunnel 需重新評估）`,
  )
}
