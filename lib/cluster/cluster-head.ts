import { join } from 'node:path'
import type { Hono } from 'hono'
import { getClusterSecret, CLUSTER_TICKET_RE, WORKER_NAME_RE } from './cluster-env.ts'
import { createClusterAuthGuard } from './cluster-auth.ts'
import { createWorkerRegistry } from './worker-registry.ts'
import { createDispatchRegistry, DISPATCH_STATUS_RANK, type DispatchEntry } from './dispatch-registry.ts'
import { createDispatcher, type DispatchAttemptWriteDeps, type DispatchResult } from './dispatch.ts'
import { createRemoteSweeper } from './remote-sweeper.ts'
import { recordWorkerMonitorStatus } from './worker-monitor-status.ts'
import { createBacklogDispatcher } from './backlog-dispatcher.ts'
import { fetchWorkerCapacity, fetchWorkerJobStatus, postWorkerJob } from './worker-client.ts'
import { isMonitorDbEnabled } from '../monitor-db/env.ts'
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
      submit: (ticket, techUser) => submitCreateMr(ticket, { triggeredBy: techUser }),
    },
    demand: {
      stats: getDemandQueueStats,
      has: hasDemandTicketActive,
      submit: (ticket, assigneeEmail, techUser) => submitDemandPipeline(ticket, assigneeEmail, techUser),
    },
  },
  dispatchAttempts: dispatchAttemptWrites,
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
  }, SWEEP_INTERVAL_MS)
  console.error(
    `cluster: head 模式啟用（已登記 worker：${workerRegistry.list().map(w => w.name).join(', ') || '無'}；/cluster/* 的公網封鎖依賴 cloudflared 注入 CF-Connecting-IP，換 tunnel 需重新評估）`,
  )
}
