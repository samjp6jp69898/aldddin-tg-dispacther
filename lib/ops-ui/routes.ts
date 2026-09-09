import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createRateLimitMiddleware, createTokenBucket } from '../security/rate-limit.ts'
import type { ClaimOutcome } from '../locking/claim.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'
import { createIpAllowlistGuard, type Cidr } from './ip-allowlist.ts'
import type { OpsSession, SessionStore } from './session-store.ts'
import { verifyTelegramLogin } from './telegram-login.ts'
import { kindOf, type TicketRow } from './notion-tickets.ts'
import type { HistoryQuery, RunRow } from './runs-read.ts'

// ops-ui 路由（2026-09-08）：技術同事用瀏覽器看「進行中／待處理／處理過」的
// 工單，並可對自己被指派的待處理單直接啟動既有 pipeline。掛在 head 的 8787
// Hono app 上（跟 mcp-proxy／cluster 路由同一支 server）——認領要走跟 TG bot
// 完全相同的 in-process 決策核心（claimBugTicket／claimDemandTicket，含佇列
// 與多機派工狀態），拆成獨立 process 就得再造一層內部 API，得不償失。
//
// 防線順序（每一條 /ops 請求都先過前兩道）：
//   1. 公司網路：createIpAllowlistGuard（OPS_ALLOWED_CIDRS，fail-closed，
//      拒絕＝401 空 body，與 catch-all 無法區分）
//   2. 額度：獨立 token bucket，不跟 webhook 共用（UI 輪詢不該吃掉 Telegram
//      的額度，反之亦然）
//   3. 身分：/ops/api/* 需要有效 session cookie；session 只由
//      /ops/auth/telegram（Telegram Login Widget 驗簽 + tech-users.csv
//      tg_chat_id 對映）建立
//   4. 寫入（POST /ops/api/start）另要求自訂 header X-Ops-Ui（瀏覽器跨站表單
//      送不出自訂 header，配合 SameSite=Lax cookie 擋 CSRF）＋ 單號格式檢查
//      ＋ 同一使用者同時只允許一個 start 在途（擋連點）
//
// 註冊位置是硬約束（跟 mcp-proxy.ts 相同）：必須在 server.ts 的 catch-all
// `app.all('*')` 之前，否則整組被 401 吃掉。

export const OPS_PREFIX = '/ops'
export const SESSION_COOKIE = 'ops_session'
export const CSRF_HEADER = 'x-ops-ui'

export type PendingTicket = TicketRow & { canStart: boolean }
export type PendingPayload = { bug: PendingTicket[]; demand: PendingTicket[]; fetchedAt: string }

export type ActiveRow = {
  ticket: string
  kind: 'bug' | 'demand' | string
  state: 'running' | 'queued' | 'dispatching'
  host: string
  triggeredByName: string | null
  triggeredByEmail: string | null
  startedAt: string | null
  enqueuedAt: string | null
  runId: string | null
  /** 本機鎖／遠端登記表有沒有真的看到這張單（純 DB 訊號時為 false）。 */
  verified: boolean
  progress: string
  queuePosition: number | null
  title: string | null
  url: string | null
  aiAnalysis: string | null
}
export type ActivePayload = {
  rows: ActiveRow[]
  limits: { bug: { limit: number; running: number; queued: number }; demand: { limit: number; running: number; queued: number } }
  monitorDb: boolean
  fetchedAt: string
}

export type HistoryRow = RunRow & { title: string | null; url: string | null; aiAnalysis: string | null; notionStatus: string | null }
export type HistoryPayload = { rows: HistoryRow[]; total: number; limit: number; offset: number; monitorDb: boolean; fetchedAt: string }

export type StatusPayload = { maintenance: boolean }

export type OpsDeps = {
  botToken: string
  botUsername: string
  allowedCidrs: Cidr[]
  sessions: SessionStore
  resolveTechUserByChatId: (chatId: string) => TechUser | null
  claimBug: (user: TechUser, ticket: string) => Promise<ClaimOutcome>
  claimDemand: (user: TechUser, ticket: string) => Promise<ClaimOutcome>
  listPending: (user: TechUser) => Promise<PendingPayload>
  /** 隱私邊界（2026-09-08）：只回登入者自己發起的工單，見 lib/ops-ui/index.ts
   * buildActive／buildHistory 的實作與檔頭說明——不是這裡的呼叫端自己過濾，
   * 是要求傳入的實作內部就只回登入者自己的資料。 */
  listActive: (user: TechUser) => Promise<ActivePayload>
  listHistory: (user: TechUser, q: HistoryQuery) => Promise<HistoryPayload>
  /** 頂部維護狀態燈號用；刻意不要求登入（見下方路由註冊處），公司網路內
   * 任何人開頁面都該立刻看到目前是否在維護中，不用先登入才看得到。 */
  getStatus: () => StatusPayload
  /** static/index.html 的內容，含 __BOT_USERNAME__／__AUTH_URL__ 佔位符。 */
  pageHtml: string
  /** 對外 origin（如 https://mcp.aladdin-assistant.cc）；未設則從 Host／
   * X-Forwarded-Proto 推導。Login Widget 的 auth-url 必須落在 BotFather
   * /setdomain 綁定的網域下，否則 widget 直接顯示 Bot domain invalid。 */
  publicOrigin?: string
  resolveIp?: (c: Context) => string | null
  now?: () => number
  onDeny?: (ip: string | null, path: string) => void
  log?: (line: string) => void
}

type OpsEnv = { Variables: { opsSession: OpsSession } }

/** requireSession 之後才可呼叫：把 session 從 Context 變數取回（app 由 server.ts
 * 以 BlankEnv 建立，這裡只能用 unknown 轉型一次，集中在這一處）。 */
const sessionOf = (c: Context): OpsSession => (c as unknown as Context<OpsEnv>).get('opsSession')

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

function originOf(c: Context, deps: OpsDeps): string {
  if (deps.publicOrigin) return deps.publicOrigin.replace(/\/+$/, '')
  const proto = c.req.header('x-forwarded-proto') ?? 'https'
  const host = c.req.header('host') ?? 'localhost'
  return `${proto}://${host}`
}

function plainPage(c: Context, status: 400 | 401 | 403, message: string): Response {
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>登入失敗</title><body style="font-family:system-ui;padding:2rem;max-width:40rem"><h2>登入失敗</h2><p>${htmlEscape(message)}</p><p><a href="${OPS_PREFIX}/">回登入頁</a></p></body>`,
    status,
  )
}

export function registerOpsRoutes(app: Hono, deps: OpsDeps): void {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((line: string) => console.error(`ops-ui: ${line}`))
  const ipGuard = createIpAllowlistGuard({ cidrs: deps.allowedCidrs, resolveIp: deps.resolveIp, onDeny: deps.onDeny })
  // 每秒 5 次、瞬間 120：十來個人同時開著三個分頁輪詢綽綽有餘，又擋得住
  // 對 /ops/auth/telegram 的暴力嘗試（驗簽本身是常數時間 HMAC，這裡只是
  // 不讓它吃 CPU）。
  const rateLimit = createRateLimitMiddleware(createTokenBucket({ capacity: 120, refillPerSecond: 5 }))
  const ttlSeconds = Math.floor(deps.sessions.ttlMs / 1000)

  const requireSession: MiddlewareHandler<OpsEnv> = async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE)
    const session = id ? deps.sessions.get(id) : null
    if (!session) {
      if (id) deleteCookie(c, SESSION_COOKIE, { path: OPS_PREFIX })
      return c.json({ error: 'unauthenticated' }, 401)
    }
    c.set('opsSession', session)
    await next()
  }

  app.use(OPS_PREFIX, ipGuard, rateLimit)
  app.use(`${OPS_PREFIX}/*`, ipGuard, rateLimit)

  app.get(OPS_PREFIX, c => c.redirect(`${OPS_PREFIX}/`))

  app.get(`${OPS_PREFIX}/`, c => {
    const authUrl = `${originOf(c, deps)}${OPS_PREFIX}/auth/telegram`
    const html = deps.pageHtml.replaceAll('__BOT_USERNAME__', htmlEscape(deps.botUsername)).replaceAll('__AUTH_URL__', htmlEscape(authUrl))
    c.header('Cache-Control', 'no-store')
    return c.html(html)
  })

  // Telegram Login Widget 回呼（redirect 模式，參數在 query string）。
  app.get(`${OPS_PREFIX}/auth/telegram`, c => {
    const verified = verifyTelegramLogin(c.req.query(), deps.botToken, { now: now() })
    if (!verified.ok) {
      log(`telegram 登入驗簽失敗 reason=${verified.reason}`)
      const msg =
        verified.reason === 'expired'
          ? 'Telegram 登入資料已過期，請回登入頁重新按一次 Telegram 登入。'
          : 'Telegram 登入資料驗證失敗（簽章不符或欄位缺漏），請回登入頁重試。'
      return plainPage(c, verified.reason === 'missing_fields' ? 400 : 401, msg)
    }
    const user = deps.resolveTechUserByChatId(verified.id)
    if (!user) {
      // 不印 Telegram id 以外的個資；id 本身是對映 tech-users.csv 需要的鍵，
      // 讓維運者能用 tg-chatid-sync 補上。
      log(`telegram 登入成功但 chat_id=${verified.id} 不在 tech-users.csv 白名單`)
      return plainPage(c, 403, `這個 Telegram 帳號（id ${verified.id}）尚未綁定技術人員名冊。請先私訊 bot 任一訊息，並請維運人員用 tg-chatid-sync 完成對映後再登入。`)
    }
    const session = deps.sessions.create(verified.id, user, verified.displayName)
    setCookie(c, SESSION_COOKIE, session.id, { httpOnly: true, secure: true, sameSite: 'Lax', path: OPS_PREFIX, maxAge: ttlSeconds })
    log(`登入 ${user.email}（${user.notion_user_name}）`)
    return c.redirect(`${OPS_PREFIX}/`)
  })

  app.post(`${OPS_PREFIX}/logout`, c => {
    const id = getCookie(c, SESSION_COOKIE)
    if (id) deps.sessions.delete(id)
    deleteCookie(c, SESSION_COOKIE, { path: OPS_PREFIX })
    return c.body(null, 204)
  })

  const api = `${OPS_PREFIX}/api`

  // 維護燈號刻意放在 requireSession 之前註冊：公司網路內任何人（含尚未用
  // Telegram 登入的人）打開 /ops/ 都該立刻看到目前是不是維護中，不用先登入。
  // 只回一個布林值，不含任何工單／個資，公開這一項不構成資安疑慮。
  app.get(`${api}/status`, c => c.json(deps.getStatus()))

  app.use(`${api}/*`, requireSession)

  app.get(`${api}/me`, c => {
    const s = sessionOf(c)
    return c.json({ name: s.user.notion_user_name, email: s.user.email, displayName: s.displayName, expiresAt: new Date(s.expiresAt).toISOString() })
  })

  app.get(`${api}/pending`, async c => {
    const s = sessionOf(c)
    return c.json(await deps.listPending(s.user))
  })

  app.get(`${api}/active`, async c => c.json(await deps.listActive(sessionOf(c).user)))

  app.get(`${api}/history`, async c => {
    const q = c.req.query()
    const s = sessionOf(c)
    return c.json(await deps.listHistory(s.user, { limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0), ticket: q.ticket, kind: q.kind, outcome: q.outcome }))
  })

  const startInFlight = new Set<string>()
  app.post(
    `${api}/start`,
    bodyLimit({ maxSize: 4 * 1024, onError: c => c.text('Payload Too Large', 413) }),
    async c => {
      const s = sessionOf(c)
      if (c.req.header(CSRF_HEADER) !== '1') return c.json({ error: 'missing_csrf_header' }, 403)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'bad_json' }, 400)
      }
      const ticket = typeof (body as { ticket?: unknown })?.ticket === 'string' ? (body as { ticket: string }).ticket.trim() : ''
      const kind = kindOf(ticket)
      if (kind === null) return c.json({ error: 'bad_ticket' }, 400)
      if (startInFlight.has(s.user.email)) return c.json({ error: 'start_in_flight', text: '你有另一個啟動請求還在處理中，請等它回覆後再試。' }, 409)
      startInFlight.add(s.user.email)
      try {
        log(`${s.user.email} 啟動 ${ticket}`)
        const outcome = kind === 'bug' ? await deps.claimBug(s.user, ticket) : await deps.claimDemand(s.user, ticket)
        log(`${s.user.email} 啟動 ${ticket} → ${outcome.code}`)
        return c.json({ ticket, kind, ...outcome })
      } finally {
        startInFlight.delete(s.user.email)
      }
    },
  )
}
