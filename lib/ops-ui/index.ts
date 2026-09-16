import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { claimBugTicket } from '../locking/claim.ts'
import { claimDemandTicket } from '../locking/demand-claim.ts'
import { resolveTechUserByChatId, type TechUser } from '../user-resolution/tech-user.ts'
import { describeTicketProgress, isTicketLocked } from '../pipeline-runner/ticket-progress.ts'
import { getBugQueueStats, getBugRunningTickets } from '../pipeline-runner/spawn-create-mr.ts'
import { getDemandQueueStats, getDemandRunningTickets } from '../pipeline-runner/spawn-demand-pipeline.ts'
import { describeRemoteProgress, isMaintenanceModeOn, listRemoteEntries } from '../cluster/cluster-head.ts'
import { getLongLivedMonitorPool } from '../monitor-db/runtime.ts'
import { parseCidrList } from './ip-allowlist.ts'
import { createSessionStore } from './session-store.ts'
import { invalidateNotionCache, kindOf, listBugCandidates, listDemandCandidates, lookupTickets } from './notion-tickets.ts'
import { readActiveRuns, readFinishedRuns, type HistoryQuery } from './runs-read.ts'
import { registerOpsRoutes, type ActivePayload, type ActiveRow, type HistoryPayload, type PendingPayload } from './routes.ts'

// ops-ui 的正式接線（2026-09-08）：把 routes.ts 需要的每個 dep 接到真實的
// 既有模組——認領核心、Notion 讀取、監控 DB、本機鎖／佇列／遠端登記表。
// server.ts 只呼叫 mountOpsUi(app, { botUsername })，其餘全部在這裡。
// routes.ts 本身不 import 任何會在載入時產生副作用的模組，測試可以單獨載它。

const LOCK_DIR = '/tmp/bug-analysis-locks'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SESSION_TTL_MS = 24 * 3600 * 1000

type QueueFileEntry = { ticket: string; enqueuedAt: string; triggeredBy: { name: string; email: string } | null }

/** 讀 pipeline-queue.ts 落盤的佇列快照（logs/pipeline-queue.{bug,demand}.json）。
 * 佇列模組刻意沒有 list()（只給 spawn 端用），這裡比照 tg-monitor 讀檔；
 * 檔案不存在／壞掉一律當空佇列，不擋畫面。 */
function readQueueFile(kind: 'bug' | 'demand'): QueueFileEntry[] {
  try {
    const raw = readFileSync(join(LOG_DIR, `pipeline-queue.${kind}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.entries) ? parsed.entries.filter((e: any) => typeof e?.ticket === 'string') : []
  } catch {
    return []
  }
}

function listLockedTickets(): string[] {
  try {
    return readdirSync(LOCK_DIR).filter(name => kindOf(name) !== null)
  } catch {
    return []
  }
}

async function buildPending(user: TechUser): Promise<PendingPayload> {
  const [bug, demand] = await Promise.all([listBugCandidates(), listDemandCandidates()])
  const mark = (rows: typeof bug) =>
    rows
      .map(r => ({ ...r, canStart: r.assignees.some(a => a.id === user.notion_user_id) }))
      .sort((a, b) => Number(b.canStart) - Number(a.canStart) || (b.lastEditedAt ?? '').localeCompare(a.lastEditedAt ?? ''))
  return { bug: mark(bug), demand: mark(demand), fetchedAt: new Date().toISOString() }
}

/** 大小寫不敏感比對（名冊 email 的大小寫不保證與 monitor DB
 * triggered_by_email／routes.ts 登入者 email 一致）。 */
function sameEmail(a: string | null, b: string): boolean {
  return a !== null && a.trim().toLowerCase() === b.trim().toLowerCase()
}

async function buildActive(user: TechUser): Promise<ActivePayload> {
  const pool = await getLongLivedMonitorPool()
  let dbRows: Awaited<ReturnType<typeof readActiveRuns>> = []
  if (pool) {
    try {
      dbRows = await readActiveRuns(pool)
    } catch (err) {
      console.error(`ops-ui: 讀 runs（active）失敗，改用本機訊號: ${err}`)
    }
  }

  const rows = new Map<string, ActiveRow>()
  const base = (ticket: string): ActiveRow => ({
    ticket,
    kind: kindOf(ticket) ?? 'bug',
    state: 'running',
    host: '',
    triggeredByName: null,
    triggeredByEmail: null,
    startedAt: null,
    enqueuedAt: null,
    runId: null,
    verified: false,
    progress: '',
    queuePosition: null,
    title: null,
    url: null,
    aiAnalysis: null,
  })
  const upsert = (ticket: string, patch: Partial<ActiveRow>): ActiveRow => {
    const row = rows.get(ticket) ?? base(ticket)
    Object.assign(row, patch)
    rows.set(ticket, row)
    return row
  }

  // 1. 監控 DB：跨 host 的 queued／running（含 worker 上的 run）。
  for (const r of dbRows) {
    upsert(r.ticket, {
      kind: r.kind,
      state: r.lifecycle === 'queued' ? 'queued' : 'running',
      host: r.host,
      triggeredByName: r.triggeredByName,
      triggeredByEmail: r.triggeredByEmail,
      startedAt: r.startedAt,
      enqueuedAt: r.createdAt,
      runId: r.runId,
    })
  }
  // 2. 本機：鎖目錄（pipeline 真的在跑）＋ 佇列 running 集合（剛 spawn、還沒拿鎖）。
  const localRunning = new Set([...listLockedTickets(), ...getBugRunningTickets(), ...getDemandRunningTickets()])
  for (const ticket of localRunning) {
    upsert(ticket, { state: 'running', host: 'head', verified: true })
  }
  // 3. 本機佇列檔：排隊中的單（有順位）。
  for (const kind of ['bug', 'demand'] as const) {
    readQueueFile(kind).forEach((e, i) => {
      upsert(e.ticket, {
        state: 'queued',
        host: 'head',
        verified: true,
        queuePosition: i + 1,
        enqueuedAt: e.enqueuedAt,
        triggeredByName: e.triggeredBy?.name ?? null,
        triggeredByEmail: e.triggeredBy?.email ?? null,
      })
    })
  }
  // 4. 遠端派工登記表：派到 worker 的單（本機鎖看不到）。
  const remote = listRemoteEntries()
  for (const e of remote) {
    upsert(e.ticket, {
      kind: e.kind,
      state: e.status === 'confirmed' ? 'running' : 'dispatching',
      host: e.worker || '(交涉中)',
      verified: true,
      startedAt: e.dispatchedAt,
      triggeredByName: e.triggeredBy?.name ?? null,
      triggeredByEmail: e.triggeredBy?.email ?? null,
    })
  }

  // 進度文字：本機鎖 → Debug 產物還原；遠端 → 問 worker；排隊 → 順位；
  // 純 DB 訊號（本機也沒鎖、登記表也沒有）→ 標示待校正。
  const remoteByTicket = new Map(remote.map(e => [e.ticket, e]))
  await Promise.all(
    [...rows.values()].map(async row => {
      if (row.state === 'queued') {
        row.progress = row.queuePosition ? `排隊中（第 ${row.queuePosition} 順位）` : '排隊中'
        return
      }
      const remoteEntry = remoteByTicket.get(row.ticket)
      if (remoteEntry) {
        row.progress = await describeRemoteProgress(remoteEntry)
        return
      }
      if (isTicketLocked(row.ticket)) {
        row.progress = describeTicketProgress(row.ticket)
        return
      }
      if (localRunning.has(row.ticket)) {
        row.progress = '背景流程剛啟動（尚未取得工單鎖）'
        return
      }
      row.progress = '監控 DB 標示執行中，但本機與派工登記表都查無此單——可能剛結束，等待監控校正'
    }),
  )

  // Notion 標題／連結／AI分析 現值。
  const notion = await lookupTickets([...rows.keys()]).catch(err => {
    console.error(`ops-ui: 查 Notion 標題失敗: ${err}`)
    return new Map()
  })
  for (const row of rows.values()) {
    const n = notion.get(row.ticket)
    if (n) {
      row.title = n.title
      row.url = n.url
      row.aiAnalysis = n.aiAnalysis
    }
  }

  // 隱私邊界（2026-09-08）：只回登入者自己發起的工單，不比照待處理分頁的
  // 「全隊可見」（Notion 候選單本來就是全隊共用資料，這裡的 runs 不是）。
  // 找不到發起人（triggeredByEmail 為 null——理論上只有純 DB 訊號但監控
  // DB 尚未回填、或 CLI 觸發沒有 sidecar 的邊角情況）一律排除，不當成
  // 「可能是我的」而顯示：寧可短暫看不到自己剛觸發的單，也不能誤放別人的單。
  const mine = [...rows.values()].filter(r => sameEmail(r.triggeredByEmail, user.email))
  const sorted = mine.sort((a, b) => {
    const order = { running: 0, dispatching: 1, queued: 2 }
    return order[a.state] - order[b.state] || (a.startedAt ?? a.enqueuedAt ?? '').localeCompare(b.startedAt ?? b.enqueuedAt ?? '')
  })
  return { rows: sorted, limits: { bug: getBugQueueStats(), demand: getDemandQueueStats() }, monitorDb: pool !== null, fetchedAt: new Date().toISOString() }
}

async function buildHistory(user: TechUser, q: HistoryQuery): Promise<HistoryPayload> {
  const pool = await getLongLivedMonitorPool()
  const fetchedAt = new Date().toISOString()
  if (!pool) return { rows: [], total: 0, limit: 0, offset: 0, monitorDb: false, fetchedAt }
  // 隱私邊界（2026-09-08）：同 buildActive，只回登入者自己發起的工單；
  // 覆寫呼叫端可能傳入的同名欄位，這裡是唯一權威來源。
  const { rows, total, limit, offset } = await readFinishedRuns(pool, { ...q, triggeredByEmail: user.email })
  const notion = await lookupTickets(rows.map(r => r.ticket)).catch(err => {
    console.error(`ops-ui: 查 Notion 標題失敗: ${err}`)
    return new Map()
  })
  return {
    rows: rows.map(r => {
      const n = notion.get(r.ticket)
      return { ...r, title: n?.title ?? null, url: n?.url ?? null, aiAnalysis: n?.aiAnalysis ?? null, notionStatus: n?.status ?? null }
    }),
    total,
    limit,
    offset,
    monitorDb: true,
    fetchedAt,
  }
}

/**
 * 掛載 /ops 路由。必須在 server.ts 的 catch-all 之前呼叫。
 * OPS_ALLOWED_CIDRS 未設定時照樣掛（全部拒絕，fail-closed）並在 stderr 留一行
 * 提醒；格式錯誤則直接丟例外讓 server 拒絕啟動（跟 TG_WEBHOOK_PATH 格式檢查
 * 同一個態度：寧可不啟動，也不要帶著錯誤設定上線）。
 */
export function mountOpsUi(app: Hono, opts: { botUsername: string }): void {
  const botToken = process.env.TG_DISPATCH_BOT_TOKEN
  if (!botToken) throw new Error('TG_DISPATCH_BOT_TOKEN is required for ops-ui login verification')
  const allowedCidrs = parseCidrList(process.env.OPS_ALLOWED_CIDRS)
  if (allowedCidrs.length === 0) {
    console.error('ops-ui: OPS_ALLOWED_CIDRS 未設定或為空，/ops 對所有來源一律拒絕（fail-closed）；填好後 kickstart server 即生效')
  }
  const pageFile = new URL('./static/index.html', import.meta.url).pathname
  if (!existsSync(pageFile)) throw new Error(`ops-ui: 找不到 ${pageFile}`)
  const pageHtml = readFileSync(pageFile, 'utf8')

  registerOpsRoutes(app, {
    botToken,
    botUsername: opts.botUsername,
    allowedCidrs,
    sessions: createSessionStore({ ttlMs: SESSION_TTL_MS }),
    resolveTechUserByChatId,
    claimBug: async (user, ticket) => {
      const outcome = await claimBugTicket(user, ticket)
      invalidateNotionCache()
      return outcome
    },
    claimDemand: async (user, ticket) => {
      const outcome = await claimDemandTicket(user, ticket)
      invalidateNotionCache()
      return outcome
    },
    listPending: buildPending,
    listActive: buildActive,
    listHistory: buildHistory,
    getStatus: () => ({ maintenance: isMaintenanceModeOn() }),
    pageHtml,
    publicOrigin: process.env.OPS_PUBLIC_ORIGIN || undefined,
  })
  console.error(`ops-ui: 已掛載 /ops（白名單 ${allowedCidrs.length} 條，widget bot=@${opts.botUsername}）`)
}
