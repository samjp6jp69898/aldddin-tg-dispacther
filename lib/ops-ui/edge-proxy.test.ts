import { afterEach, describe, expect, test } from 'bun:test'
import { createOpsUiEdgeApp } from './edge-proxy.ts'

// 比照 lib/webhook-server/mcp-proxy.test.ts 的既有手法：用真的 Bun.serve stub
// 後端 + Hono 的 app.request() 跑完整條轉發鏈，不 mock fetch——proxy 的錯誤
// 幾乎都出在「串流 body、headers、狀態碼在真實 fetch 下的行為」，mock 掉就
// 等於沒測。

type Stub = { port: number; received: { method: string; path: string; headers: Record<string, string>; body: string }[]; setResponder: (fn: (req: Request) => Response | Promise<Response>) => void; stop: () => void }

function startStub(): Stub {
  const received: Stub['received'] = []
  let respond: (req: Request) => Response | Promise<Response> = () => new Response('upstream-ok', { status: 200 })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text()
      received.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body })
      return respond(req)
    },
  })
  return {
    port: server.port ?? 0, // Bun.serve() 同步啟動後一定有真實 port；?? 0 只是配合本機 bun-types 版本的型別要求。
    received,
    setResponder: fn => {
      respond = fn
    },
    stop: () => server.stop(true),
  }
}

let stub: Stub | null = null
afterEach(() => {
  stub?.stop()
  stub = null
})

function build() {
  stub = startStub()
  const app = createOpsUiEdgeApp({ upstreamBase: `http://127.0.0.1:${stub.port}`, now: () => 1_000_000 })
  return { app, stub }
}

describe('GET /health', () => {
  test('不轉發，回自己的存活資訊', async () => {
    const { app, stub } = build()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok' })
    expect(stub.received).toHaveLength(0)
  })
})

describe('/ops 轉發', () => {
  test('GET /ops/ → 原樣轉發路徑、方法、query string，回傳 upstream 的 body/status', async () => {
    const { app, stub } = build()
    stub.setResponder(() => new Response('<html>ops</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const res = await app.request('/ops/?x=1')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>ops</html>')
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(stub.received[0]).toMatchObject({ method: 'GET', path: '/ops/?x=1' })
  })
  test('/ops（無結尾斜線）也轉發', async () => {
    const { app, stub } = build()
    await app.request('/ops')
    expect(stub.received[0]!.path).toBe('/ops')
  })
  test('POST 帶 JSON body 完整轉發到 upstream；upstream 的 401 原樣回傳', async () => {
    const { app, stub } = build()
    stub.setResponder(() => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const res = await app.request('/ops/api/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ops-ui': '1' }, body: JSON.stringify({ ticket: 'FAQ-1' }) })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(stub.received[0]).toMatchObject({ method: 'POST', path: '/ops/api/start', body: '{"ticket":"FAQ-1"}' })
    expect(stub.received[0]!.headers['x-ops-ui']).toBe('1')
  })
  test('cookie 與 CF-Connecting-IP 原樣轉發（下游身分/公司網路判斷依賴這兩個 header）', async () => {
    const { app, stub } = build()
    await app.request('/ops/api/me', { headers: { cookie: 'ops_session=abc', 'cf-connecting-ip': '61.222.239.250' } })
    expect(stub.received[0]!.headers['cookie']).toBe('ops_session=abc')
    expect(stub.received[0]!.headers['cf-connecting-ip']).toBe('61.222.239.250')
  })
  test('upstream 的 Set-Cookie 原樣轉發回呼叫端（含屬性）', async () => {
    const { app, stub } = build()
    stub.setResponder(() => new Response(null, { status: 302, headers: { location: '/ops/', 'set-cookie': 'ops_session=xyz; HttpOnly; Secure; SameSite=Lax; Path=/ops' } }))
    const res = await app.request('/ops/auth/telegram?id=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toBe('ops_session=xyz; HttpOnly; Secure; SameSite=Lax; Path=/ops')
    expect(res.headers.get('location')).toBe('/ops/')
  })
  test('hop-by-hop／host／accept-encoding 不轉發給 upstream', async () => {
    const { app, stub } = build()
    // connection／accept-encoding 都用 fetch 自己絕不會湊巧採用的值探測
    // （不是 'toBeUndefined'）：Bun 的 fetch 自己的 HTTP client 本來就會依
    // 連線層需要送出它自己的 Connection／Accept-Encoding header，跟我們有
    // 沒有剝除入站那份無關；用特殊值才能真的驗證到「入站的值沒有被原樣
    // 轉發」而不是巧合通過。
    await app.request('/ops/', { headers: { host: 'mcp.aladdin-assistant.cc', connection: 'close', 'accept-encoding': 'x-test-probe-encoding' } })
    const h = stub.received[0]!.headers
    expect(h['host']).not.toBe('mcp.aladdin-assistant.cc')
    expect(h['connection']).not.toBe('close')
    expect(h['accept-encoding']).not.toBe('x-test-probe-encoding')
  })
  test('upstream 不可達 → 502，不是未捕捉例外', async () => {
    const app = createOpsUiEdgeApp({ upstreamBase: 'http://127.0.0.1:1' })
    const res = await app.request('/ops/')
    expect(res.status).toBe(502)
  })
  test('POST body 超過 1MB（帶 Content-Length）→ 413，不轉發給 upstream', async () => {
    const { app, stub } = build()
    const res = await app.request('/ops/api/start', { method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024) }, body: 'x' })
    expect(res.status).toBe(413)
    expect(stub.received).toHaveLength(0)
  })
})

describe('職責邊界：只轉發 /ops 與 /health，其餘一律 404', () => {
  test('webhook／mcp-proxy／cluster 等其他路徑不轉發', async () => {
    const { app, stub } = build()
    for (const path of ['/', '/some-webhook-secret-path', '/mcp-admin-dev/login', '/cluster/register']) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
    }
    expect(stub.received).toHaveLength(0)
  })
})
