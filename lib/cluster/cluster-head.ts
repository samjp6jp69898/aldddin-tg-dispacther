import { join } from 'node:path'
import type { Hono } from 'hono'
import { getClusterSecret, CLUSTER_TICKET_RE, WORKER_NAME_RE } from './cluster-env.ts'
import { createClusterAuthGuard } from './cluster-auth.ts'
import { createWorkerRegistry } from './worker-registry.ts'
import { createDispatchRegistry, DISPATCH_STATUS_RANK, type DispatchEntry } from './dispatch-registry.ts'
import { createMaintenanceModeStore } from '../maintenance/mode-store.ts'
import { drainMaintenanceQueue } from '../maintenance/request-queue.ts'
import { createDispatcher, type BugDispatchOpts, type DispatchAttemptWriteDeps, type DispatchResult } from './dispatch.ts'
import { createRemoteSweeper } from './remote-sweeper.ts'
import { recordWorkerMonitorStatus } from './worker-monitor-status.ts'
import { createBacklogDispatcher } from './backlog-dispatcher.ts'
import { fetchWorkerCapacity, fetchWorkerJobStatus, fetchRemoteStageFiles, postWorkerJob } from './worker-client.ts'
import { headHasArtifacts, pullTicketArtifacts, pushTicketArtifacts, queryArtifactHost, retryPendingArtifactPulls } from './artifact-sync.ts'
import { isMonitorDbEnabled, MON_HOST } from '../monitor-db/env.ts'
import { createMonitorPool } from '../monitor-db/pool.ts'
import { createDispatchAttempt, advanceDispatchAttempt, supersedeOtherDispatchAttempts } from '../monitor-db/writes.ts'
import { submitCreateMr, getBugQueueStats, hasBugTicketActive, notifyQueueEvent, tryDispatchBugQueueFront } from '../pipeline-runner/spawn-create-mr.ts'
import {
  submitDemandPipeline,
  getDemandQueueStats,
  hasDemandTicketActive,
  resetAiAnalysisForReclaim,
  tryDispatchDemandQueueFront,
} from '../pipeline-runner/spawn-demand-pipeline.ts'
import { notifyOperator } from '../notify/operator.ts'
import { applyRemoteTrackerRow, parseTrackerRow, readTrackerFile } from '../pipeline-runner/tracker-sync.ts'
import { resolveTechUserByEmail } from '../user-resolution/tech-user.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

// retry（task 2）只支援 bug 單——tg-monitor `/api/pipelines/retry` 本來就只
// 接受 `FAQ-\d+`（見該端點註解「需求單 ALDREQ 目前不提供這個按鈕」），這裡
// 收斂同一個限制，不接受 ALDREQ- 混進來。
const RETRY_TICKET_RE = /^FAQ-\d+$/

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
// 維護模式（2026-09-08）：這個 store 在模組層級無條件建立（不像
// workerRegistry/dispatchRegistry 只服務多機派工），claim.ts／demand-claim.ts
// 直接呼叫 isMaintenanceModeOn()（同一個長駐 head 行程內的記憶體讀取，不走
// HTTP）在任何部署形態下都生效。
//
// ⚠️ 但「用 tg-monitor 切換」這件事目前綁在下面 registerClusterRoutes 掛的
// POST /cluster/maintenance——那支路由跟其他 /cluster/* 一樣，secret 未設定
// （單機部署）時 registerClusterRoutes 整個提前 return，路由不會掛上去，
// 這種部署下沒有 HTTP 管道可以手動開關（跟既有 worker 名冊管理三個動作
// 同一種限制，見下方該段落）。目前實際部署是多機（有設定 secret），這不是
// 阻礙；真要在單機部署開關，只能直接編輯／刪除
// logs/maintenance-mode.json 再重啟行程。
const maintenanceMode = createMaintenanceModeStore(join(LOG_DIR, 'maintenance-mode.json'))

// monitor DB 觀察面：dispatch_attempts 只有 head 寫（plan-db-as-truth-v3.md
// §5.3；R1：head 對遠端 run 一律只寫 dispatch_attempts，絕不碰 runs）。
// lazily 建 pool、flag 關閉時完全不建——這是「flag 關閉零行為變化」
// （isMonitorDbEnabled()===false 時 create/advance 都是 no-op）的落地方式。
// 全部 fire-and-forget：這張表只給 tg-monitor 面板觀察用，寫入失敗只記
// log，不影響任何派工正確性（那完全由 DispatchRegistry 的磁碟持久化保證）。
//
// 注意（留給整合階段判斷是否要收斂）：這是 cluster wiring 自己的 mon_head
// pool 實例，與 server.ts／其他 collector 若各自也建立 mon_head pool 是各自
// 獨立的連線——lib/monitor-db/pool.ts 的「全 repo createPool( 恰好一次」只
// 保證『唯一呼叫 mysql2.createPool 的檔案』是 pool.ts，不保證『整個 head
// 行程只有一個 Pool 實例』。§4.6 的 pool 歸屬表把整個 head 行程的 mon_head
// 算成一份 connectionLimit=8 預算；這裡另開一個小的（=2，dispatch_attempts
// 遠比熱路徑低頻），不在本檔所有權範圍內處理跨行程收斂。
let monitorPool: ReturnType<typeof createMonitorPool> | null = null
function getMonitorPool(): ReturnType<typeof createMonitorPool> | null {
  if (!isMonitorDbEnabled()) return null
  if (monitorPool === null) monitorPool = createMonitorPool('mon_head', { connectionLimit: 2 })
  return monitorPool
}

const dispatchAttemptWrites: DispatchAttemptWriteDeps = {
  supersedeOthers(input) {
    const pool = getMonitorPool()
    if (pool === null) return
    void supersedeOtherDispatchAttempts(pool, {
      ticket: input.ticket,
      kind: input.kind,
      excludeDispatchId: input.excludeDispatchId,
    }).catch(err => console.error(`cluster: dispatch_attempts supersede 失敗（ticket=${input.ticket}）：${err}`))
  },
  create(input) {
    const pool = getMonitorPool()
    if (pool === null) return
    void createDispatchAttempt(pool, {
      dispatchId: input.dispatchId,
      ticket: input.ticket,
      kind: input.kind,
      status: input.status,
      statusRank: input.statusRank,
      dispatchedAt: input.dispatchedAt,
      triggeredByEmail: input.triggeredByEmail ?? null,
    }).catch(err => console.error(`cluster: dispatch_attempts create 失敗（dispatchId=${input.dispatchId}）：${err}`))
  },
  advance(input) {
    const pool = getMonitorPool()
    if (pool === null) return
    void advanceDispatchAttempt(pool, {
      dispatchId: input.dispatchId,
      status: input.status,
      statusRank: input.statusRank,
      confirmedAt: input.confirmedAt ?? null,
      clearedAt: input.clearedAt ?? null,
      clearReason: input.clearReason ?? null,
      remoteRunId: input.remoteRunId ?? null,
      workerName: input.workerName ?? null,
      workerUrl: input.workerUrl ?? null,
    }).catch(err => console.error(`cluster: dispatch_attempts advance 失敗（dispatchId=${input.dispatchId}）：${err}`))
  },
}

/** §4.3 A2：這張票的既有產物在哪台。DB 關閉/查詢失敗一律 null＝「查無紀錄」
 * ——派工絕不能因為監控 DB 不可用而失敗（plan §3 的降級紀律）。 */
async function lookupArtifactHost(ticket: string): Promise<string | null> {
  const pool = getMonitorPool()
  if (pool === null) return null
  try {
    return await queryArtifactHost(pool, ticket, MON_HOST)
  } catch (err) {
    console.error(`cluster: ${ticket} 查詢既有產物所在機器失敗（視同查無紀錄）: ${err}`)
    return null
  }
}

const dispatcher = createDispatcher({
  registry: dispatchRegistry,
  // disabled 的 worker（tg-monitor Workers 分頁「中斷」按鈕，見 worker-registry.ts
  // 檔頭）不參與派工選擇，但仍留在名冊裡可查詢——過濾點刻意放在這裡（wiring
  // 層）而非 dispatch.ts 本體，讓派工邏輯本身保持對「disabled」這個概念無感。
  listWorkers: () => (secret === null ? [] : workerRegistry.list().filter(w => !w.disabled)),
  fetchCapacity: (w, ticket) => fetchWorkerCapacity(w.url, secret ?? '', ticket),
  postJob: (w, job) => postWorkerJob(w.url, secret ?? '', job),
  local: {
    bug: {
      stats: getBugQueueStats,
      has: hasBugTicketActive,
      // techUser 可為 null、opts.resume 透傳給 submitCreateMr 的 `--resume`
      // 語意（2026-09-04，task 2：tg-monitor 續跑改走這條路徑，見下方
      // registerClusterRoutes 新增的 POST /cluster/retry）。
      submit: (ticket, techUser, opts) =>
        submitCreateMr(ticket, { triggeredBy: techUser ?? undefined, resume: opts?.resume, mode: opts?.mode, aiAnalysis: opts?.aiAnalysis }),
    },
    demand: {
      stats: getDemandQueueStats,
      has: hasDemandTicketActive,
      submit: (ticket, assigneeEmail, techUser, opts) =>
        submitDemandPipeline(ticket, assigneeEmail, techUser ?? undefined, undefined, opts?.aiAnalysis),
    },
  },
  dispatchAttempts: dispatchAttemptWrites,
  // §4.1–4.3 的產物 I/O（Phase 4）。remoteHas 用既有的 `GET /jobs/:ticket/stage-files`
  // ——不新增 worker 端路由，且它回的就是「這幾個檔在該機存不存在＋mtime」的
  // 原始事實，正好是產物存在性檢查要的東西。打不通回 null（＝不可達，與「可達
  // 但沒有產物」語意完全不同，見 dispatch.ts §4.3）。
  artifacts: {
    headHas: headHasArtifacts,
    lookupHost: lookupArtifactHost,
    remoteHas: async (w, ticket) => {
      const files = await fetchRemoteStageFiles(w.url, secret ?? '', ticket)
      if (files === null) return null
      return files.debugFiles['analysis-notes.md'] != null
    },
    push: pushTicketArtifacts,
  },
})

const sweeper = createRemoteSweeper({
  registry: dispatchRegistry,
  listWorkers: () => workerRegistry.list(),
  fetchStatus: (url, ticket) => fetchWorkerJobStatus(url, secret ?? '', ticket),
  notifyOperator,
  notifyUser: notifyQueueEvent,
  resetDemand: resetAiAnalysisForReclaim,
  dispatchAttempts: dispatchAttemptWrites,
})

// head 佇列的 cluster-wide 遞補（見 backlog-dispatcher.ts 檔頭）。listWorkers
// 過濾 disabled，跟 dispatcher 的候選名單同一套規則——過濾點刻意放在 wiring
// 層，理由見 worker-registry.ts「disabled」段落。
const backlogDispatcher = createBacklogDispatcher({
  registry: dispatchRegistry,
  postJob: (w, job) => postWorkerJob(w.url, secret ?? '', job),
  fetchCapacity: w => fetchWorkerCapacity(w.url, secret ?? ''),
  listWorkers: () => (secret === null ? [] : workerRegistry.list().filter(w => !w.disabled)),
  bug: { tryDispatchFront: tryDispatchBugQueueFront },
  demand: { tryDispatchFront: tryDispatchDemandQueueFront },
  dispatchAttempts: dispatchAttemptWrites,
})

export function isClusterEnabled(): boolean {
  return secret !== null
}

/** claim.ts／demand-claim.ts 的受理閘門：true 時一律拒絕新的認領（見兩檔
 * 各自入口處的呼叫點）。與 cluster 是否啟用無關，單機部署也讀得到。 */
export function isMaintenanceModeOn(): boolean {
  return maintenanceMode.isOn()
}

/** claim.ts 的 submitCreateMr 替身：cluster 停用或無 worker 時走本機（等同
 * 既有行為），否則依名額派工。techUser 可為 null（task 2：tg-monitor 續跑
 * 查不到原認領人 email 時）；opts.resume 透傳 `--resume` 語意。 */
export function dispatchBug(ticket: string, techUser: TechUser | null, opts?: BugDispatchOpts): Promise<DispatchResult> {
  return dispatcher.dispatchBug(ticket, techUser, opts)
}

export function dispatchDemand(
  ticket: string,
  assigneeEmail: string,
  techUser: TechUser | null,
  opts?: { aiAnalysis?: string },
): Promise<DispatchResult> {
  return dispatcher.dispatchDemand(ticket, assigneeEmail, techUser, opts)
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

  // tracker 整檔下載（2026-09-03）：worker 接單當下拉一份覆蓋本機那份，
  // 見 tracker-sync.ts「整檔同步」段落的事故背景。head 這份是唯一權威，
  // 這裡只讀不寫。讀不到（檔案不存在/形狀不對）回 503 而不是空字串——
  // worker 端要能區分「head 沒有 tracker」與「拿到一份空的」，前者必須
  // 保留 worker 本機既有那份，不能拿空的去覆蓋。
  app.get('/cluster/tracker', guard, c => {
    const content = readTrackerFile()
    if (content === null) {
      console.error('cluster: worker 來拉 tracker，但 head 本機這份讀不到或格式不對——worker 會沿用它自己那份')
      return c.json({ ok: false, reason: 'unavailable' }, 503)
    }
    return c.json({ ok: true, content })
  })

  // 續跑（resume）改走跟一般派工相同的分派判斷（task 2，2026-09-04）：
  // tg-monitor 的 `/api/pipelines/retry` 原本寫死呼叫本機
  // spawn-create-mr.ts 的 submitCreateMr()（CLI 進程邊界），完全繞過這裡的
  // dispatcher.dispatchBug()——resume 只在乎能不能 checkout 既有 mr/{ticket}
  // 分支到新 worktree，不依賴哪台機器的本地磁碟殘留狀態，所以理論上可以派到
  // 任一台機器（含跟原本執行的機器不同的 worker），這是預期內、可接受的行為。
  //
  // 為什麼是新端點而不是讓 tg-monitor 直接呼叫 CLI 版 dispatchBug：dispatchBug
  // 依賴的 dispatchRegistry/workerRegistry 是這個**長駐 head 行程**的記憶體
  // 單例（module-level singleton，只有 initClusterHead() 呼叫過的行程持久化
  // 到磁碟並撿回既有狀態）——另開一個短命 CLI 行程 import cluster-head.ts 會
  // 拿到一份空的、彼此不同步的登記表，可能跟這裡的真正 head 行程對同一張票
  // 做出衝突的派工判斷（見 dispatch-registry.ts persistEnabled 只在
  // recoverFromDisk() 之後才是 true 的既有機制）。改成 HTTP 呼叫這個長駐行程
  // 自己，比照 tg-monitor 既有的 worker 名冊管理三個動作（disable/enable/
  // remove）同一種模式——同一個 process、同一份記憶體狀態，不會有雙份登記表。
  //
  // 只接受 FAQ-（bug）：tg-monitor 的重試按鈕本來就只給 bug 單用（需求單
  // ALDREQ 沒有這個按鈕，見 tg-monitor server.ts /api/pipelines/retry 註解），
  // demand 沒有 resume 機制，這裡不開放。
  app.post('/cluster/retry', guard, async c => {
    const body = (await c.req.json().catch(() => null)) as { ticket?: string; triggeredByEmail?: string } | null
    if (!body || typeof body.ticket !== 'string' || !RETRY_TICKET_RE.test(body.ticket)) {
      return c.json({ ok: false, reason: 'bad_request' }, 400)
    }
    let techUser: TechUser | null = null
    if (typeof body.triggeredByEmail === 'string' && body.triggeredByEmail !== '') {
      techUser = resolveTechUserByEmail(body.triggeredByEmail)
      // 帶了 email 卻查不到：明確拒絕，不要靜默丟掉發起人（比照
      // spawn-create-mr.ts CLI `--triggered-by-email` 既有的同款紀律）。
      if (!techUser) return c.json({ ok: false, reason: `triggeredByEmail 在 tech-users.csv 查無此 email：${body.triggeredByEmail}` }, 400)
    }
    const result = await dispatchBug(body.ticket, techUser, { resume: true })
    return c.json(result, result.ok ? 200 : 500)
  })

  app.post('/cluster/job-done', guard, async c => {
    const body = (await c.req.json().catch(() => null)) as { ticket?: string; worker?: string; trackerRow?: string } | null
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
    if (entry !== null) {
      dispatchAttemptWrites.advance({
        dispatchId: entry.dispatchId,
        status: 'cleared',
        statusRank: DISPATCH_STATUS_RANK.terminal,
        clearedAt: new Date().toISOString(),
        clearReason: 'job_done',
      })
    }
    console.error(`cluster: ${body.ticket} 於 worker ${worker} 執行結束（job-done 回報）`)
    // 終態回寫（2026-09-03）：worker 上 /create-mr Step 8 寫的是**執行機**那份
    // tracker，head 這份不會自己知道。把該單的行帶回來寫進 head，多機才只有
    // 一份權威。遠端字串一律先過 parseTrackerRow 的狀態白名單與時間格式，
    // 不合格就當沒帶（記 log，不阻斷 job-done 的冪等回應）。
    if (typeof body.trackerRow === 'string' && body.trackerRow !== '') {
      const parsed = parseTrackerRow(body.trackerRow)
      if (parsed === null) {
        console.error(`cluster: ${body.ticket} 的 job-done 帶了無法解析的 tracker 行，已忽略（head 那份維持原狀）`)
      } else if (!applyRemoteTrackerRow(body.ticket, parsed.status, parsed.doneAt)) {
        console.error(`cluster: ${body.ticket} 的終態 ${parsed.status} 回寫 head tracker 失敗（該單可能不在 head 那份裡）`)
      } else {
        console.error(`cluster: ${body.ticket} 的終態 ${parsed.status} 已從 worker ${worker} 回寫 head tracker`)
      }
    }
    // 這台 worker 剛釋放一個名額：把 head 佇列隊頭遞補過去（cluster-wide
    // 遞補，見 backlog-dispatcher.ts）。fire-and-forget，不擋這支 HTTP 回應
    // ——比照 notifyQueueEvent 等既有 best-effort 收尾的寫法。找不到該 worker
    // （已被移除/停用）就不遞補，理由見 worker-registry.ts「disabled」段落。
    const kind = body.ticket.startsWith('FAQ-') ? 'bug' : 'demand'
    const w = workerRegistry.list().find(x => x.name === worker && !x.disabled)
    // §4.1（Phase 4）：這一輪的 Debug 產物只在該 worker 上——趁 job-done 立刻
    // 拉回 head，之後同一張票要「產出修復程式碼」時就不必依賴那台機器活著。
    // fire-and-forget（rsync 最長 30 秒，不能擋這支 HTTP 回應）；失敗只記
    // ticket_artifact_sync，由 sweeper 每 10 分鐘那輪重試。只拉 bug 票。
    // 名冊裡找不到該 worker（已移除/停用）時不拉——沒有 url 可連。
    if (kind === 'bug' && w) {
      void pullTicketArtifacts(w, body.ticket).catch(err => console.error(`cluster: ${body.ticket} 的產物拉取例外（sweeper 會重試）: ${err}`))
    }
    if (w) void backlogDispatcher.fillFreedSlot(kind, w).catch(err => console.error(`cluster: ${body.ticket} 的 backlog 遞補失敗: ${err}`))
    return c.json({ ok: true })
  })

  // 【plan-db-as-truth-v3.2.md MJ-E4 ＝ MAJOR-F6，§6.8(e)】worker 的監控自況
  // 主動回報。與上面兩條 /cluster/register、/cluster/job-done **完全同型**：
  // 同一組 guard（LAN-only + shared secret）、同樣低頻（每 worker 每 60 秒
  // 一次）、同樣小 payload、同樣不擴大能力面——這是本案往 8787 唯一新增的
  // 路由（【G:MN-G8】）。刻意不動 worker 的 `GET /health`（那是 worker 上唯一
  // 不驗證的路由，MJ-E4 的裁定就是一個字都不改它）。
  // head 只存記憶體（worker-monitor-status.ts），判斷與告警在 health-monitor
  // 的 60 秒 timer 內，不在這支 handler 裡——handler 本身零 I/O。
  app.post('/cluster/monitor-status', guard, async c => {
    const body = (await c.req.json().catch(() => null)) as { worker?: unknown } | null
    if (!body || typeof body.worker !== 'string' || !WORKER_NAME_RE.test(body.worker)) {
      return c.json({ ok: false }, 400)
    }
    // 三個數值欄的型別收斂在 recordWorkerMonitorStatus 內（不合法一律 null =
    // 「不知道」）：回報端暫時算不出 spool 深度時仍該讓這筆回報留下時間戳，
    // 400 掉整筆會讓 §6.8(e) 誤判成「這台完全失聯」。
    recordWorkerMonitorStatus(body.worker, body as Parameters<typeof recordWorkerMonitorStatus>[1])
    return c.json({ ok: true })
  })

  // worker 名冊管理（2026-08-31，tg-monitor Workers 分頁「中斷／恢復／移除」
  // 按鈕新增）：呼叫端是本機的 tg-monitor（打 127.0.0.1:8787），不是遠端
  // worker，但仍走同一組 guard（LAN-only + secret）——這組操作一樣不該對
  // 公網開放，跟 /cluster/register 同等敏感度。
  app.post('/cluster/worker/:name/disable', guard, c => {
    const name = c.req.param('name')
    if (!WORKER_NAME_RE.test(name)) return c.json({ ok: false }, 400)
    const ok = workerRegistry.setDisabled(name, true)
    if (ok) console.error(`cluster: worker ${name} 已停用（不再收到新工作，該台身上既有的工作不受影響）`)
    return c.json({ ok }, ok ? 200 : 404)
  })

  app.post('/cluster/worker/:name/enable', guard, c => {
    const name = c.req.param('name')
    if (!WORKER_NAME_RE.test(name)) return c.json({ ok: false }, 400)
    const ok = workerRegistry.setDisabled(name, false)
    if (ok) console.error(`cluster: worker ${name} 已恢復，可再收到新工作`)
    return c.json({ ok }, ok ? 200 : 404)
  })

  app.post('/cluster/worker/:name/remove', guard, c => {
    const name = c.req.param('name')
    if (!WORKER_NAME_RE.test(name)) return c.json({ ok: false }, 400)
    const ok = workerRegistry.remove(name)
    if (ok) console.error(`cluster: worker ${name} 已從名冊移除（若該機 worker-agent 行程仍在跑，30 分鐘內會自動重新登記回來——見 worker-registry.ts 檔頭）`)
    return c.json({ ok }, ok ? 200 : 404)
  })

  // 維護模式開關（2026-09-08，tg-monitor 手動控制）：呼叫端是本機的
  // tg-monitor（打 127.0.0.1:8787），同一組 guard（LAN-only + secret），跟上面
  // worker 名冊管理三個動作同一種模式。只管 head 自己這份（claim.ts／
  // demand-claim.ts 的受理閘門）；worker 端各自獨立的旗標由 tg-monitor 另外
  // 直接打每台 worker 自己的 POST /maintenance（見 worker-agent.ts），這裡不
  // 代為轉發——head 對「還有哪些 worker 活著」的認知本來就可能落後，兩邊各自
  // 收各自的請求比較不會有「head 轉發成功但實際上那台早就斷線」的假象。
  app.post('/cluster/maintenance', guard, async c => {
    const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null
    if (!body || typeof body.on !== 'boolean') return c.json({ ok: false, reason: 'bad_request' }, 400)
    const wasOn = maintenanceMode.isOn()
    maintenanceMode.setOn(body.on)
    console.error(`cluster: 維護模式已${body.on ? '開啟' : '關閉'}（head）`)
    // 維護剛從開轉關：把 request-queue.ts 累積的排隊請求依 FIFO 重新完整跑
    // 一次（見該檔 drainMaintenanceQueue 註解）。fire-and-forget——不讓
    // tg-monitor 的這次切換請求等整批重新處理跑完才回應，理由同其他熱路徑
    // 非阻斷紀律（見 spawn-create-mr.ts 檔頭）；drainMaintenanceQueue() 內部
    // 已經逐筆包 try/catch，這裡的 catch 只是最後一道防線。
    if (wasOn && !body.on) {
      void drainMaintenanceQueue().catch(err => console.error(`cluster: 維護結束後重新處理排隊請求失敗: ${err}`))
    }
    return c.json({ ok: true, on: body.on })
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
    // job-done 回報遺失時的安全網（見 backlog-dispatcher.ts 檔頭）：同一顆
    // timer 順便補做一次 backlog 遞補探測，不另開新 timer。
    backlogDispatcher.sweepBacklog().catch(err => console.error(`cluster: backlog sweep 失敗: ${err}`))
    // §4.1 的拉取重試（Phase 4）：head 沒有完整副本、且距上次嘗試超過 10 分鐘
    // 的票再拉一次。同樣掛在這顆 timer 上（不新增 timer）；DB 關閉時 pool 為
    // null，整段 no-op。
    retryPendingArtifactPulls({ pool: getMonitorPool(), listWorkers: () => workerRegistry.list().filter(x => !x.disabled) })
      .then(n => {
        if (n > 0) console.error(`cluster: 本輪重試了 ${n} 張票的產物拉取`)
      })
      .catch(err => console.error(`cluster: 產物拉取重試失敗: ${err}`))
  }, SWEEP_INTERVAL_MS)
  console.error(
    `cluster: head 模式啟用（已登記 worker：${workerRegistry.list().map(w => w.name).join(', ') || '無'}；/cluster/* 的公網封鎖依賴 cloudflared 注入 CF-Connecting-IP，換 tunnel 需重新評估）`,
  )
}
