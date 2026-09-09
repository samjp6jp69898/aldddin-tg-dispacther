import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { respondUniform401 } from '../security/uniform-401.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'
import { parseCidrList } from './ip-allowlist.ts'
import { createSessionStore } from './session-store.ts'
import { computeTelegramHash } from './telegram-login.ts'
import { CSRF_HEADER, registerOpsRoutes, type ActivePayload, type HistoryPayload, type OpsDeps, type PendingPayload } from './routes.ts'

const TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
const NOW = 1_800_000_000_000
const OFFICE_IP = '61.222.239.250'
const USER: TechUser = { notion_user_id: 'u1', notion_user_name: '小明', email: 'ming@example.com' }
const PAGE = '<html>login __BOT_USERNAME__ __AUTH_URL__</html>'

function signedQuery(id = '987654321', authDateOffset = -30): string {
  const params: Record<string, string> = { id, first_name: '小明', auth_date: String(Math.floor(NOW / 1000) + authDateOffset) }
  params.hash = computeTelegramHash(params, TOKEN)
  return new URLSearchParams(params).toString()
}

function build(overrides: Partial<OpsDeps> = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const pending: PendingPayload = { bug: [], demand: [], fetchedAt: 'x' }
  const active: ActivePayload = { rows: [], limits: { bug: { limit: 5, running: 0, queued: 0 }, demand: { limit: 6, running: 0, queued: 0 } }, monitorDb: false, fetchedAt: 'x' }
  const history: HistoryPayload = { rows: [], total: 0, limit: 50, offset: 0, monitorDb: false, fetchedAt: 'x' }
  const deps: OpsDeps = {
    botToken: TOKEN,
    botUsername: 'aladdin_dispatch_bot',
    allowedCidrs: parseCidrList(`${OFFICE_IP}/32`),
    sessions: createSessionStore({ ttlMs: 3600_000, now: () => NOW }),
    resolveTechUserByChatId: chatId => (chatId === '987654321' ? USER : null),
    claimBug: async (u, t) => {
      calls.push(`bug:${u.email}:${t}`)
      return { code: 'started', text: `已開始處理 ${t}` }
    },
    claimDemand: async (u, t) => {
      calls.push(`demand:${u.email}:${t}`)
      return { code: 'queued', text: `排隊 ${t}` }
    },
    listPending: async () => pending,
    listActive: async user => {
      calls.push(`active:${user.email}`)
      return active
    },
    listHistory: async (user, q) => {
      calls.push(`history:${user.email}`)
      return { ...history, limit: q.limit ?? 0, offset: q.offset ?? 0 }
    },
    getStatus: () => ({ maintenance: false }),
    pageHtml: PAGE,
    now: () => NOW,
    onDeny: () => {},
    log: line => logs.push(line),
    ...overrides,
  }
  const app = new Hono()
  registerOpsRoutes(app, deps)
  app.all('*', c => respondUniform401(c)) // 比照 server.ts 的 catch-all
  const req = (path: string, init: RequestInit & { ip?: string | null; cookie?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.ip !== null) headers.set('cf-connecting-ip', init.ip ?? OFFICE_IP)
    if (init.cookie) headers.set('cookie', init.cookie)
    return app.request(path, { ...init, headers })
  }
  const login = async () => {
    const res = await req(`/ops/auth/telegram?${signedQuery()}`)
    const setCookie = res.headers.get('set-cookie') ?? ''
    return { res, cookie: setCookie.split(';')[0]! }
  }
  return { app, req, login, calls, logs, deps }
}

describe('公司網路門檻', () => {
  test('白名單外的 IP：所有 /ops 路徑一律 401 空 body（含登入頁與 auth 回呼）', async () => {
    const { req } = build()
    for (const path of ['/ops', '/ops/', `/ops/auth/telegram?${signedQuery()}`, '/ops/api/me', '/ops/api/status']) {
      const res = await req(path, { ip: '8.8.8.8' })
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('')
    }
  })
  test('沒有 CF-Connecting-IP 也拿不到 socket 位址 → 401', async () => {
    const { req } = build()
    expect((await req('/ops/', { ip: null })).status).toBe(401)
  })
})

describe('登入頁與 Telegram 回呼', () => {
  test('/ops → 302 /ops/；/ops/ 回頁面並代入 bot username 與 auth-url（從 Host 推導）', async () => {
    const { req } = build()
    const r1 = await req('/ops')
    expect(r1.status).toBe(302)
    expect(r1.headers.get('location')).toBe('/ops/')
    const r2 = await req('/ops/', { headers: { host: 'mcp.aladdin-assistant.cc', 'x-forwarded-proto': 'https' } })
    expect(r2.status).toBe(200)
    expect(r2.headers.get('cache-control')).toBe('no-store')
    const html = await r2.text()
    expect(html).toContain('aladdin_dispatch_bot')
    expect(html).toContain('https://mcp.aladdin-assistant.cc/ops/auth/telegram')
  })
  test('publicOrigin 設定時 auth-url 以它為準', async () => {
    const { req } = build({ publicOrigin: 'https://ops.example.com/' })
    const html = await (await req('/ops/', { headers: { host: 'evil.example' } })).text()
    expect(html).toContain('https://ops.example.com/ops/auth/telegram')
    expect(html).not.toContain('evil.example')
  })
  test('驗簽通過 + 白名單內 → 設 HttpOnly/Secure/SameSite=Lax cookie 並導回 /ops/', async () => {
    const { login } = build()
    const { res, cookie } = await login()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/ops/')
    const sc = res.headers.get('set-cookie')!
    expect(sc).toMatch(/^ops_session=[0-9a-f]{64};/)
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Secure')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).toContain('Path=/ops')
    expect(cookie).toMatch(/^ops_session=/)
  })
  test('簽章錯誤 → 401 頁面、不設 cookie；過期 → 401；缺欄位 → 400', async () => {
    const { req } = build()
    const bad = await req(`/ops/auth/telegram?${signedQuery().replace(/hash=[0-9a-f]{8}/, 'hash=00000000')}`)
    expect(bad.status).toBe(401)
    expect(bad.headers.get('set-cookie')).toBeNull()
    expect((await req(`/ops/auth/telegram?${signedQuery('987654321', -3600)}`)).status).toBe(401)
    expect((await req('/ops/auth/telegram?id=1')).status).toBe(400)
  })
  test('驗簽通過但 chat_id 不在 tech-users.csv → 403，不設 cookie', async () => {
    const { req } = build()
    const res = await req(`/ops/auth/telegram?${signedQuery('555')}`)
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.text()).toContain('尚未綁定')
  })
})

describe('API 與 session', () => {
  test('無 cookie → /ops/api/* 401 JSON；登入後 /me 回名冊資料', async () => {
    const { req, login } = build()
    const r0 = await req('/ops/api/me')
    expect(r0.status).toBe(401)
    expect(await r0.json()).toEqual({ error: 'unauthenticated' })
    const { cookie } = await login()
    const r1 = await req('/ops/api/me', { cookie })
    expect(r1.status).toBe(200)
    expect(await r1.json()).toMatchObject({ name: '小明', email: 'ming@example.com', displayName: '小明' })
  })
  test('偽造／過期 cookie → 401 並清 cookie', async () => {
    const { req } = build()
    const r = await req('/ops/api/me', { cookie: `ops_session=${'a'.repeat(64)}` })
    expect(r.status).toBe(401)
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0')
  })
  test('登出後同一 cookie 失效', async () => {
    const { req, login } = build()
    const { cookie } = await login()
    expect((await req('/ops/logout', { method: 'POST', cookie })).status).toBe(204)
    expect((await req('/ops/api/me', { cookie })).status).toBe(401)
  })
  test('pending / active / history 走注入的資料源；history 轉發 limit/offset；active／history 帶登入者身分（隱私邊界，不是呼叫端自己過濾）', async () => {
    const { req, login, calls } = build()
    const { cookie } = await login()
    expect((await (await req('/ops/api/pending', { cookie })).json()) as any).toMatchObject({ bug: [], demand: [] })
    expect((await (await req('/ops/api/active', { cookie })).json()) as any).toMatchObject({ monitorDb: false })
    const h = (await (await req('/ops/api/history?limit=20&offset=40', { cookie })).json()) as any
    expect(h).toMatchObject({ limit: 20, offset: 40 })
    expect(calls).toEqual(['active:ming@example.com', 'history:ming@example.com'])
  })
  test('白名單內但 session 是別台機器 IP 帶來的 cookie 仍需過 IP 門檻', async () => {
    const { req, login } = build()
    const { cookie } = await login()
    expect((await req('/ops/api/me', { cookie, ip: '8.8.8.8' })).status).toBe(401)
  })
  test('/ops/api/status 不需要 session（公司網路內未登入也看得到維護燈號），反映 getStatus()', async () => {
    const { req } = build({ getStatus: () => ({ maintenance: true }) })
    const r = await req('/ops/api/status')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ maintenance: true })
  })
})

describe('POST /ops/api/start', () => {
  const json = (body: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', ...extra },
    body: JSON.stringify(body),
  })
  test('缺 X-Ops-Ui header → 403，不呼叫認領', async () => {
    const { req, login, calls } = build()
    const { cookie } = await login()
    const r = await req('/ops/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: 'FAQ-1' }), cookie })
    expect(r.status).toBe(403)
    expect(calls).toEqual([])
  })
  test('壞 JSON → 400；單號格式錯 → 400（不進認領核心）', async () => {
    const { req, login, calls } = build()
    const { cookie } = await login()
    expect((await req('/ops/api/start', { ...json({}), body: '{', cookie })).status).toBe(400)
    expect((await req('/ops/api/start', { ...json({ ticket: '../etc' }), cookie })).status).toBe(400)
    expect((await req('/ops/api/start', { ...json({ ticket: 'FAQ-' }), cookie })).status).toBe(400)
    expect(calls).toEqual([])
  })
  test('FAQ-* 走 claimBug、ALDREQ-* 走 claimDemand，帶登入者身分，回核心的 code/text', async () => {
    const { req, login, calls, logs } = build()
    const { cookie } = await login()
    const r1 = await req('/ops/api/start', { ...json({ ticket: ' FAQ-4905 ' }), cookie })
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ ticket: 'FAQ-4905', kind: 'bug', code: 'started', text: '已開始處理 FAQ-4905' })
    const r2 = await req('/ops/api/start', { ...json({ ticket: 'ALDREQ-843' }), cookie })
    expect(await r2.json()).toMatchObject({ kind: 'demand', code: 'queued' })
    expect(calls).toEqual(['bug:ming@example.com:FAQ-4905', 'demand:ming@example.com:ALDREQ-843'])
    expect(logs.some(l => l.includes('ming@example.com 啟動 FAQ-4905 → started'))).toBe(true)
  })
  test('同一使用者的 start 在途時第二個請求 409；結束後可再送', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const { req, login } = build({
      claimBug: async (_u, t) => {
        await gate
        return { code: 'started', text: t }
      },
    })
    const { cookie } = await login()
    const first = req('/ops/api/start', { ...json({ ticket: 'FAQ-1' }), cookie })
    await Promise.resolve()
    const second = await req('/ops/api/start', { ...json({ ticket: 'FAQ-2' }), cookie })
    expect(second.status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect((await req('/ops/api/start', { ...json({ ticket: 'FAQ-3' }), cookie })).status).toBe(200)
  })
  test('未登入 → 401，不呼叫認領', async () => {
    const { req, calls } = build()
    expect((await req('/ops/api/start', json({ ticket: 'FAQ-1' }))).status).toBe(401)
    expect(calls).toEqual([])
  })
})
