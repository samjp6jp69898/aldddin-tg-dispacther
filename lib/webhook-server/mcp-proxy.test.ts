import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { isAuthenticatedUpstreamStatus, registerProxyRoutes } from './mcp-proxy.ts'

// 這份測試的兩個目標（對應 M1 / M4 兩個缺陷）：
// 1. M1：從外部看，「前綴不存在」與「前綴存在但（認證失敗 / 服務沒開 / 帶了
//    Origin header / 打 /health）」的回應必須逐位元組相同，一個請求都問不出
//    拓撲；同時 hosted server 真正的業務回應（含 405 這種 MCP client 功能上
//    依賴的錯誤碼）必須原樣通過。
// 2. M4：認證失敗的請求不得消耗合法使用者的額度，但也不能因此變成完全不受
//    量體控制的未認證洪水。
//
// 用真的 Bun.serve stub 後端 + Hono 的 app.request() 跑完整條 middleware 鏈，
// 不 mock fetch——proxy 的錯誤幾乎都出在「串流 body、headers、狀態碼在真實
// fetch 下的行為」，mock 掉就等於沒測。
//
// 硬規則：測試不得靠 sleep/等待時間成立。所有跟時間有關的判定都用注入的假
// 時鐘（makeClock），不呼叫真正的 Date.now()、不等待。

const AUTH_HEADERS = { authorization: 'Bearer whatever' }

// server.ts 那條 catch-all 的回應，是所有拒絕都必須對齊的基準。
const UNIFORM_401 = { status: 401, body: '' }

function makeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

type Stub = {
  port: number
  received: Array<{ method: string; path: string }>
  setResponder: (fn: (req: Request) => Response) => void
  stop: () => void
}

function startStub(): Stub {
  const received: Array<{ method: string; path: string }> = []
  let respond: (req: Request) => Response = () => new Response('upstream-ok', { status: 200 })
  // 綁 127.0.0.1 與正式 hosted server 一致（見 agrabah-admin/src/http.ts 檔頭
  // 「綁定 127.0.0.1」），proxy 打的是 http://localhost:<port>。
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      received.push({ method: req.method, path: url.pathname + url.search })
      return respond(req)
    },
  })
  return {
    port: server.port,
    received,
    setResponder: fn => {
      respond = fn
    },
    stop: () => server.stop(true),
  }
}

const stub = startStub()
afterAll(() => stub.stop())

// 沒有任何行程在監聽的 port：開一個再立刻關掉，拿到一個確定關閉的 port，
// 用來模擬「前綴存在但後端沒啟動」（正式環境的 /toolsmith、/mcp-admin-pre、
// /mcp-admin-evi 平時就是這個狀態）。
function reserveClosedPort(): number {
  const tmp = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = tmp.port
  tmp.stop(true)
  return port
}
const CLOSED_PORT = reserveClosedPort()

type BuildOptions = {
  port?: number
  authed?: { capacity: number; refillPerSecond: number }
  forward?: { capacity: number; refillPerSecond: number }
  now?: () => number
}

// 跟 server.ts 同構：proxy route 在前、catch-all 在後。catch-all 一併建起來，
// 才能把「猜錯前綴」的回應當成基準去比對。
function buildApp(opts: BuildOptions = {}) {
  const app = new Hono()
  registerProxyRoutes(app, {
    routes: [['/mcp-test', opts.port ?? stub.port]],
    buckets: {
      authed: opts.authed ?? { capacity: 1_000, refillPerSecond: 0 },
      forward: opts.forward ?? { capacity: 1_000, refillPerSecond: 0 },
      now: opts.now,
    },
  })
  app.all('*', c => {
    c.status(401)
    return c.body('')
  })
  return app
}

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text() }
}

function get(app: Hono, path: string, init: RequestInit = {}) {
  return app.request(path, { headers: AUTH_HEADERS, ...init })
}

describe('isAuthenticatedUpstreamStatus — 哪些上游狀態碼可信為「已通過認證」', () => {
  test('2xx 一律可信（正常業務回應：MCP、/login、/files）', () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(isAuthenticatedUpstreamStatus(status)).toBe(true)
    }
  })

  test('400 / 405 / 413 / 429 可信：hosted server 只在認證之後才產生這四種', () => {
    for (const status of [400, 405, 413, 429]) {
      expect(isAuthenticatedUpstreamStatus(status)).toBe(true)
    }
  })

  test('403 不可信：來自認證之前的 Origin guard，任何人加個 Origin header 就拿得到', () => {
    expect(isAuthenticatedUpstreamStatus(403)).toBe(false)
  })

  test('401 / 404 / 500 / 502 / 3xx 一律不可信', () => {
    for (const status of [301, 302, 307, 401, 404, 500, 502, 503]) {
      expect(isAuthenticatedUpstreamStatus(status)).toBe(false)
    }
  })
})

describe('M1 — 前綴/存活/uptime 探測預言機', () => {
  test('基準：猜錯前綴（沒命中任何 proxy route）回 401 + 空 body', async () => {
    const app = buildApp()
    expect(await snapshot(await get(app, '/nonexistent-prefix/x'))).toEqual(UNIFORM_401)
  })

  test('GET /<prefix>/health 不再穿透：回均一 401，且完全不轉發到後端', async () => {
    const app = buildApp()
    const before = stub.received.length
    expect(await snapshot(await get(app, '/mcp-test/health'))).toEqual(UNIFORM_401)
    expect(stub.received.length).toBe(before)
  })

  test('/health 帶 query string 一樣攔掉（後端 Hono 只看 pathname，會命中 /health）', async () => {
    const app = buildApp()
    const before = stub.received.length
    expect(await snapshot(await get(app, '/mcp-test/health?probe=1'))).toEqual(UNIFORM_401)
    expect(stub.received.length).toBe(before)
  })

  test('percent-encoding 繞道 /<prefix>/%68ealth 一樣攔掉（Hono 匹配會解碼）', async () => {
    const app = buildApp()
    const before = stub.received.length
    expect(await snapshot(await get(app, '/mcp-test/%68ealth'))).toEqual(UNIFORM_401)
    expect(stub.received.length).toBe(before)
  })

  test('POST /<prefix>/health（原本靠後端 404 洩漏前綴存在）也攔在 proxy', async () => {
    const app = buildApp()
    const before = stub.received.length
    expect(await snapshot(await get(app, '/mcp-test/health', { method: 'POST' }))).toEqual(UNIFORM_401)
    expect(stub.received.length).toBe(before)
  })

  test('上游 403（Origin guard，認證之前）正規化成均一 401', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('Forbidden', { status: 403 }))
    expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
  })

  test('上游 404 正規化成均一 401', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('404 Not Found', { status: 404 }))
    expect(await snapshot(await get(app, '/mcp-test/whatever'))).toEqual(UNIFORM_401)
  })

  test('上游 500 正規化成均一 401（認證 middleware 自己拋例外也可能產生 500）', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('Internal Server Error', { status: 500 }))
    expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
  })

  test('上游 3xx 正規化成均一 401（redirect: manual，不代為跟隨）', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('', { status: 302, headers: { location: '/elsewhere' } }))
    const res = await get(app, '/mcp-test/mcp')
    expect(await snapshot(res)).toEqual(UNIFORM_401)
    expect(res.headers.get('location')).toBeNull()
  })

  test('上游 401 正規化成均一 401，且不轉發 WWW-Authenticate 之類 header', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } }))
    const res = await get(app, '/mcp-test/mcp')
    expect(await snapshot(res)).toEqual(UNIFORM_401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  test('後端未啟動：回均一 401，不再是可辨識的 502', async () => {
    const app = buildApp({ port: CLOSED_PORT })
    expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
  })

  test('沒有 Authorization header：回均一 401，且不轉發', async () => {
    const app = buildApp()
    const before = stub.received.length
    const res = await app.request('/mcp-test/mcp')
    expect(await snapshot(res)).toEqual(UNIFORM_401)
    expect(stub.received.length).toBe(before)
  })

  test('前綴本身用 percent-encoding 探測：回均一 401，且不轉發', async () => {
    const app = buildApp()
    const before = stub.received.length
    expect(await snapshot(await get(app, '/mcp-te%73t/mcp'))).toEqual(UNIFORM_401)
    expect(stub.received.length).toBe(before)
  })
})

describe('M1 — 合法業務回應必須原樣通過（不能為了關預言機把功能一起關掉）', () => {
  test('2xx 原樣通過，body 與 Content-Type 都保留', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('{"jsonrpc":"2.0"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await get(app, '/mcp-test/mcp', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"jsonrpc":"2.0"}')
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  // 405 是 MCP SDK client 的功能性依賴，不是可有可無的錯誤碼：GET /mcp 回 405
  // client 才會判定「沒有 GET SSE」而安靜下來，換成 401 會被當成認證失敗。
  // 見 agrabah-admin/src/http.ts:37-49 對 SDK client 行為的實測記錄。
  test('405（GET /mcp）原樣通過，Allow header 保留', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } }))
    const res = await get(app, '/mcp-test/mcp')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST, DELETE')
  })

  test('400 / 413 / 429 原樣通過（企劃端據此分辨參數錯誤、檔案過大、被節流）', async () => {
    for (const status of [400, 413, 429]) {
      const app = buildApp()
      stub.setResponder(() => new Response(`upstream-${status}`, { status }))
      const res = await get(app, '/mcp-test/login', { method: 'POST' })
      expect(res.status).toBe(status)
      expect(await res.text()).toBe(`upstream-${status}`)
    }
  })

  test('轉發時保留 path 與 query，並剝掉 host（後端看到的是自己的 host）', async () => {
    const app = buildApp()
    stub.setResponder(() => new Response('ok', { status: 200 }))
    const before = stub.received.length
    await get(app, '/mcp-test/files?a=1&b=2', { method: 'POST', body: 'payload' })
    expect(stub.received.slice(before)).toEqual([{ method: 'POST', path: '/files?a=1&b=2' }])
  })
})

describe('M4 — 假 token 不得耗盡合法使用者的額度', () => {
  test('認證失敗的請求完全不消耗已認證額度：打爆之後合法請求照樣通過', async () => {
    const clock = makeClock()
    const app = buildApp({
      authed: { capacity: 3, refillPerSecond: 0 },
      forward: { capacity: 1_000, refillPerSecond: 0 },
      now: clock.now,
    })

    // 攻擊者：假 token，上游一律 401。打遠超過 capacity 的量。
    stub.setResponder(() => new Response('unauthorized', { status: 401 }))
    for (let i = 0; i < 50; i++) {
      expect(await snapshot(await get(app, '/mcp-test/mcp', { method: 'POST' }))).toEqual(UNIFORM_401)
    }

    // 合法企劃：整組 MCP 冷啟動握手（initialize + notifications/initialized +
    // tools/list 三發）必須全部拿到 200，一發都不能被連坐擋掉。
    stub.setResponder(() => new Response('ok', { status: 200 }))
    for (let i = 0; i < 3; i++) {
      const res = await get(app, '/mcp-test/mcp', { method: 'POST' })
      expect(res.status).toBe(200)
    }
  })

  test('上游 403（Origin guard，認證之前）同樣不消耗已認證額度', async () => {
    const app = buildApp({
      authed: { capacity: 2, refillPerSecond: 0 },
      forward: { capacity: 1_000, refillPerSecond: 0 },
    })
    stub.setResponder(() => new Response('Forbidden', { status: 403 }))
    for (let i = 0; i < 20; i++) {
      expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
    }

    stub.setResponder(() => new Response('ok', { status: 200 }))
    expect((await get(app, '/mcp-test/mcp')).status).toBe(200)
    expect((await get(app, '/mcp-test/mcp')).status).toBe(200)
  })

  test('後端未啟動時的失敗請求也不消耗額度（額度不會被無法服務的期間吃掉）', async () => {
    const app = buildApp({
      port: CLOSED_PORT,
      authed: { capacity: 2, refillPerSecond: 0 },
      forward: { capacity: 1_000, refillPerSecond: 0 },
    })
    for (let i = 0; i < 10; i++) {
      expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
    }
  })
})

describe('M4 — 額度本身仍然有效（不能修成完全沒有量體控制）', () => {
  test('已認證用量照樣扣自己的配額，用完之後回均一 401（不是會洩漏前綴的 429）', async () => {
    const app = buildApp({
      authed: { capacity: 3, refillPerSecond: 0 },
      forward: { capacity: 1_000, refillPerSecond: 0 },
    })
    stub.setResponder(() => new Response('ok', { status: 200 }))

    const before = stub.received.length
    for (let i = 0; i < 3; i++) {
      expect((await get(app, '/mcp-test/mcp')).status).toBe(200)
    }
    // 第 4 發：額度用盡，回均一 401，而且根本不轉發（後端不用做這次工）。
    expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
    expect(stub.received.length - before).toBe(3)
  })

  test('轉發閘擋得住未認證洪水：超量之後不再轉發到後端', async () => {
    const app = buildApp({
      authed: { capacity: 1_000, refillPerSecond: 0 },
      forward: { capacity: 2, refillPerSecond: 0 },
    })
    stub.setResponder(() => new Response('unauthorized', { status: 401 }))

    const before = stub.received.length
    for (let i = 0; i < 10; i++) {
      expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
    }
    // 只有前 2 發真的打到後端，其餘被轉發閘攔在 proxy。
    expect(stub.received.length - before).toBe(2)
  })

  test('超出業務配額的請求不會連帶吃掉轉發閘的額度（兩顆 bucket 職責分離）', async () => {
    const clock = makeClock()
    const app = buildApp({
      authed: { capacity: 1, refillPerSecond: 1 },
      forward: { capacity: 5, refillPerSecond: 0 },
      now: clock.now,
    })
    stub.setResponder(() => new Response('ok', { status: 200 }))

    const before = stub.received.length
    expect((await get(app, '/mcp-test/mcp')).status).toBe(200) // 轉發閘剩 4

    // 業務配額已空：以下 20 發都被 hasTokens() 擋在轉發之前。若它們也扣了
    // 轉發閘，後面補回配額之後就再也轉發不出去。
    for (let i = 0; i < 20; i++) {
      expect(await snapshot(await get(app, '/mcp-test/mcp'))).toEqual(UNIFORM_401)
    }

    // 假時鐘推進 4 秒 → 業務配額補回（capacity 1，夾在 1）。
    for (let i = 0; i < 4; i++) {
      clock.advance(4_000)
      expect((await get(app, '/mcp-test/mcp')).status).toBe(200)
    }
    expect(stub.received.length - before).toBe(5)
  })

  test('每條 route 的 bucket 各自獨立：打爆一條不影響另一條', async () => {
    const app = new Hono()
    registerProxyRoutes(app, {
      routes: [
        ['/route-a', stub.port],
        ['/route-b', stub.port],
      ],
      buckets: {
        authed: { capacity: 2, refillPerSecond: 0 },
        forward: { capacity: 1_000, refillPerSecond: 0 },
      },
    })
    app.all('*', c => {
      c.status(401)
      return c.body('')
    })
    stub.setResponder(() => new Response('ok', { status: 200 }))

    expect((await get(app, '/route-a/mcp')).status).toBe(200)
    expect((await get(app, '/route-a/mcp')).status).toBe(200)
    expect(await snapshot(await get(app, '/route-a/mcp'))).toEqual(UNIFORM_401) // a 用盡

    expect((await get(app, '/route-b/mcp')).status).toBe(200) // b 完全不受影響
    expect((await get(app, '/route-b/mcp')).status).toBe(200)
  })
})

describe('設定完整性', () => {
  test('缺少額度設定的 route 在啟動時就拒絕註冊（不會靜默變成無限制）', () => {
    const app = new Hono()
    expect(() => registerProxyRoutes(app, { routes: [['/no-limit-defined', 9999]] })).toThrow()
  })
})
