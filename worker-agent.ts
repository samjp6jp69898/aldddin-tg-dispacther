// telegram-dispatcher — worker agent 入口（多機派工的 worker 端）。
//
// 部署在 worker 機（同一套 /Users/user/aladdin 目錄慣例，見 README「多機
// 擴容」一節與 deploy/ 腳本），對 LAN 提供輕量 HTTP 介面，讓 head（跑
// server.ts 的那台）把認領到的 Bug/需求單派過來本機執行：
//   GET  /health        存活探測（比照 server.ts /health：不驗證、最小資訊）
//   GET  /capacity      本機兩條 pipeline 的名額實況（head 派工選擇用）
//   POST /jobs          接單：直接走本機既有的 submitCreateMr/
//                       submitDemandPipeline（佇列、併發上限、去重、
//                       stale-lock 回收全部沿用單機機制，一行不改）
//   GET  /jobs/:ticket  某張單在本機的實況（鎖/佇列狀態 + stage 進度描述）
// 其餘路徑一律 uniform 401。
//
// 完成回報（事件驅動，不輪詢）：任一背景 pipeline 真的結束（pipeline-queue
// 的 onExited 事件）就 POST head 的 /cluster/job-done，讓 head 清掉派工
// 登記、該單恢復可認領。回報 best-effort：head 暫時打不到也沒關係，head 的
// remote sweeper 會事後校正（見 cluster-head.ts）。
//
// 對使用者的通知不經過 head：pipeline 的 EXIT trap / post-run-notify /
// tg-notify.sh 在本機直接打 Telegram API（.env 隨 aladdin 目錄複製過來，
// 見 launchd/run-worker-agent.sh），跟單機部署完全同一條路。
//
// 重要：worker 機上不要跑 server.ts（那是 head 專用——webhook、tunnel、
// MCP proxy 都只該有一份）。worker 只跑這支 + 它自己的 launchd plist。

import { Hono } from 'hono'
import { getClusterSecret, WORKER_NAME_RE, WORKER_URL_RE } from './lib/cluster/cluster-env.ts'
import { createClusterAuthGuard, CLUSTER_TOKEN_HEADER } from './lib/cluster/cluster-auth.ts'
import { respondUniform401 } from './lib/security/uniform-401.ts'
import {
  submitCreateMr,
  recoverBugQueue,
  getBugQueueStats,
  hasBugTicketActive,
  getBugRunningTickets,
  registerBugPipelineExitListener,
} from './lib/pipeline-runner/spawn-create-mr.ts'
import {
  submitDemandPipeline,
  recoverDemandQueue,
  getDemandQueueStats,
  hasDemandTicketActive,
  getDemandRunningTickets,
  registerDemandPipelineExitListener,
} from './lib/pipeline-runner/spawn-demand-pipeline.ts'
import { createLocalActivity } from './lib/cluster/local-activity.ts'
import { isTicketLocked, describeTicketProgress } from './lib/pipeline-runner/ticket-progress.ts'
import { ensureTrackerPending } from './lib/pipeline-runner/tracker-sync.ts'
import { startStaleLockReaper } from './lib/pipeline-runner/stale-lock-reaper.ts'
import type { TechUser } from './lib/user-resolution/tech-user.ts'

const BUG_TICKET_RE = /^FAQ-\d+$/
const DEMAND_TICKET_RE = /^ALDREQ-\d+$/

const maybeSecret = getClusterSecret()
if (maybeSecret === null) {
  // worker 沒有「cluster 停用」的降級模式——它存在的唯一目的就是接 head
  // 派工，沒 secret 等於對 LAN 開一個無認證的 spawn 入口，直接拒絕啟動。
  throw new Error('worker-agent: CLUSTER_SHARED_SECRET 未設定（或長度不足），拒絕啟動（見 launchd/run-worker-agent.sh）')
}
// 重新綁定成 string 型別：模組層的 null check 不會流進下面各 closure 的
// 型別收斂，這一行讓後續所有用點都拿到非 null 型別。
const secret: string = maybeSecret
const headUrl = (process.env.CLUSTER_HEAD_URL ?? '').trim().replace(/\/+$/, '')
const workerName = (process.env.CLUSTER_WORKER_NAME ?? '').trim()
const advertiseUrl = (process.env.CLUSTER_WORKER_URL ?? '').trim().replace(/\/+$/, '')
if (!WORKER_URL_RE.test(headUrl)) throw new Error('worker-agent: CLUSTER_HEAD_URL 未設定或格式不對（需 http(s)://host[:port]）')
if (!WORKER_NAME_RE.test(workerName)) throw new Error('worker-agent: CLUSTER_WORKER_NAME 未設定或格式不對（英數 . _ -，≤64 字元）')
if (!WORKER_URL_RE.test(advertiseUrl)) throw new Error('worker-agent: CLUSTER_WORKER_URL 未設定或格式不對（本機對 LAN 的網址，如 http://192.168.1.50:8801）')

// ---- 完成回報（事件驅動） + 向 head 登記（啟動時一次 + 每 30 分鐘冪等重送，
// 讓 head 端名冊檔遺失/重建後自癒；週期性排程器，非輪詢等待）----

// 本機活動三合一真相來源（queue ∪ 鎖目錄 ∪ ps wrapper 掃描）：/capacity、
// 接單檢查、/jobs/:ticket、job-done 回報全部以它為準——只看 in-memory queue
// 會對 out-of-band run（timeout 自動重試、reaper 重跑、人工觸發）失明，
// 是對抗性 review 2026-08-31 C-1 的雙跑根因，詳見 local-activity.ts 檔頭。
const localActivity = createLocalActivity({
  queueRunning: { bug: getBugRunningTickets, demand: getDemandRunningTickets },
})

/** kind 的名額實況：running 取「queue 認得的」與「本機實際活動」的聯集
 * 大小（寧可保守少接單，不可超賣）。limit/queued 仍來自 queue。 */
function effectiveStats(kind: 'bug' | 'demand'): { limit: number; running: number; queued: number } {
  const base = kind === 'bug' ? getBugQueueStats() : getDemandQueueStats()
  return { ...base, running: Math.max(base.running, localActivity.activeTickets(kind).size) }
}

async function postToHead(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${headUrl}${path}`, {
      method: 'POST',
      headers: { [CLUSTER_TOKEN_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

function reportJobDone(ticket: string): void {
  // C-1 修正：回報前先確認這張單在本機已無**任何**活動——wrapper 的 EXIT
  // trap 內 post-run-notify 可能已對 timeout 自動重試 spawn 了下一輪 run
  // （它在別的 process，queue 看不到，但 ps/鎖看得到）。此時回報 job-done
  // 會讓 head 清登記、單子回到可認領池，與還活著的重試 run 形成雙跑。
  // 跳過回報＝head 登記保留，之後由 sweeper 向本機 /jobs/:ticket 查證
  // （同樣走三合一判定）決定去留。
  if (localActivity.isActive(ticket)) {
    console.error(`worker-agent: ${ticket} 結束但本機仍有該單的其他活動（可能為自動重試），跳過 job-done 回報`)
    return
  }
  void postToHead('/cluster/job-done', { ticket, worker: workerName }).then(ok => {
    if (!ok) console.error(`worker-agent: job-done 回報失敗（${ticket}），交由 head sweeper 事後校正`)
  })
}

registerBugPipelineExitListener(reportJobDone)
registerDemandPipelineExitListener(reportJobDone)

async function registerWithHead(): Promise<void> {
  const ok = await postToHead('/cluster/register', { name: workerName, url: advertiseUrl })
  console.error(ok ? `worker-agent: 已向 head（${headUrl}）登記為 ${workerName}` : `worker-agent: 向 head（${headUrl}）登記失敗，30 分鐘後自動重試`)
}
void registerWithHead()
setInterval(() => void registerWithHead(), 30 * 60_000)

// ---- 本機既有機制的啟動收尾（比照 server.ts）----

startStaleLockReaper()
const bugRecovered = recoverBugQueue()
const demandRecovered = recoverDemandQueue()
if (bugRecovered.started + bugRecovered.requeued + bugRecovered.skipped + demandRecovered.started + demandRecovered.requeued + demandRecovered.skipped > 0) {
  console.error(
    `worker-agent: 排隊恢復 bug(started=${bugRecovered.started}, requeued=${bugRecovered.requeued}, skipped=${bugRecovered.skipped}) demand(started=${demandRecovered.started}, requeued=${demandRecovered.requeued}, skipped=${demandRecovered.skipped})`,
  )
}

// ---- HTTP 介面 ----

const app = new Hono()
const guard = createClusterAuthGuard(secret)

app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.text('Bad Request', 400)
  console.error(`worker-agent unhandled error: ${err}`)
  return c.text('Internal Server Error', 500)
})

// 比照 server.ts /health 的紀律：不驗證（LAN 監控/doctor 腳本探測用），
// 內容只有存活資訊，不出現 worker 名稱、ticket、名額等業務細節。
app.get('/health', c => c.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }))

app.get('/capacity', guard, c => {
  // ?ticket=：head 派工前順路問「這張單在本機有沒有活動」（C-1 healing 的
  // 資料來源），一次請求兩個答案，不佔用額外的認領熱路徑預算。
  const probe = c.req.query('ticket')
  const ticket = probe !== undefined && (BUG_TICKET_RE.test(probe) || DEMAND_TICKET_RE.test(probe)) ? probe : null
  return c.json({
    worker: workerName,
    bug: effectiveStats('bug'),
    demand: effectiveStats('demand'),
    ...(ticket !== null ? { ticket: { ticket, active: localActivity.isActive(ticket) } } : {}),
  })
})

// body 欄位驗證（值會流進 tg-notify.sh 參數與落盤的 queue.json）：head 端
// 這些值來自 tech-users.csv，worker 端對等地上一道廉價格式閘——不含控制
// 字元、長度有界；email 另驗基本樣式。
const SAFE_TEXT_RE = /^[^\x00-\x1f\x7f]{1,128}$/
const EMAIL_RE = /^[^\s@\x00-\x1f\x7f]{1,64}@[^\s@\x00-\x1f\x7f]{1,190}$/

/** triggeredBy 來自網路 body：只收白名單欄位、逐一驗格式，不把整個物件
 * 原樣往 submit 傳（防夾帶）。格式不合直接當沒帶（通知屬 best-effort）。 */
function sanitizeTriggeredBy(raw: unknown): TechUser | undefined {
  const o = raw as { notion_user_id?: unknown; notion_user_name?: unknown; email?: unknown } | null
  if (!o || typeof o.notion_user_name !== 'string' || typeof o.email !== 'string') return undefined
  if (!SAFE_TEXT_RE.test(o.notion_user_name) || !EMAIL_RE.test(o.email)) return undefined
  return {
    notion_user_id: typeof o.notion_user_id === 'string' && SAFE_TEXT_RE.test(o.notion_user_id) ? o.notion_user_id : '',
    notion_user_name: o.notion_user_name,
    email: o.email,
  }
}

app.post('/jobs', guard, async c => {
  const body = (await c.req.json().catch(() => null)) as
    | { kind?: string; ticket?: string; resume?: boolean; triggeredBy?: unknown; assigneeEmail?: string }
    | null
  if (!body || typeof body.ticket !== 'string') return c.json({ ok: false, reason: 'bad_request' }, 400)
  const triggeredBy = sanitizeTriggeredBy(body.triggeredBy)

  // C-1 修正：這張單在本機已有任何活動（含 out-of-band run）→ 不接單、
  // 不 spawn，回 already_running 讓 head 把登記表回填指向本機。絕不能讓
  // 新 run 撞上活 run（新 run 早退時的 EXIT trap 會 release 活 run 的鎖並
  // 清它的 worktree）。
  if (localActivity.isActive(body.ticket)) {
    return c.json({ ok: true, status: 'already_running' })
  }

  if (body.kind === 'bug') {
    if (!BUG_TICKET_RE.test(body.ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
    const stats = effectiveStats('bug')
    if (stats.queued > 0 || stats.running >= stats.limit) return c.json({ ok: false, reason: 'full' }, 409)
    // 比照 head 端 claim.ts：spawn 前先確保本機 tracker 有這張單（/create-mr
    // Step 0 的存在性檢查讀的是「執行機」的 tracker，不是 head 的）。
    ensureTrackerPending(body.ticket)
    const result = submitCreateMr(body.ticket, { resume: body.resume === true, triggeredBy })
    return c.json(result, result.ok ? 200 : 500)
  }

  if (body.kind === 'demand') {
    if (!DEMAND_TICKET_RE.test(body.ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
    if (typeof body.assigneeEmail !== 'string' || !EMAIL_RE.test(body.assigneeEmail)) return c.json({ ok: false, reason: 'bad_request' }, 400)
    const stats = effectiveStats('demand')
    if (stats.queued > 0 || stats.running >= stats.limit) return c.json({ ok: false, reason: 'full' }, 409)
    const result = submitDemandPipeline(body.ticket, body.assigneeEmail, triggeredBy)
    return c.json(result, result.ok ? 200 : 500)
  }

  return c.json({ ok: false, reason: 'bad_request' }, 400)
})

app.get('/jobs/:ticket', guard, c => {
  const ticket = c.req.param('ticket')
  if (!BUG_TICKET_RE.test(ticket) && !DEMAND_TICKET_RE.test(ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
  const locked = isTicketLocked(ticket)
  // queueState 的語意升級為「本機活動狀態」：queue 認得的照實回 running/
  // queued；queue 看不到但鎖/ps 看得到的 out-of-band run 回 'running'——
  // head 的 sweeper 靠這個判斷「還在跑」，失明會導致誤清登記（C-1）。
  const fromQueue = BUG_TICKET_RE.test(ticket) ? hasBugTicketActive(ticket) : hasDemandTicketActive(ticket)
  const queueState = fromQueue ?? (localActivity.isActive(ticket) ? 'running' : null)
  return c.json({
    ticket,
    locked,
    queueState,
    progress: locked ? describeTicketProgress(ticket) : null,
  })
})

app.all('*', c => respondUniform401(c))

const port = Number(process.env.CLUSTER_WORKER_PORT ?? 8801)
console.error(`worker-agent: ${workerName} 監聽 0.0.0.0:${port}，head=${headUrl}`)

export default {
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
}
