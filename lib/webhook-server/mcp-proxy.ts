// hosted MCP path 分流 proxy——共用既有 ngrok domain，把五個前綴各自剝掉後
// 轉發到本機對應 port 的 hosted server（例：/mcp-admin-dev/login →
// http://localhost:8789/login）。認證由各 hosted server 自己的 Bearer token
// 把關，這裡只做純轉發，跟 webhook 的 secret guard 無關（那道 guard 只掛在
// webhook 那一條 route 上，不是全域 middleware）。
//
// 本模組原本內嵌在 server.ts；M1/M4 修正時整段搬過來，讓「前綴 guard → /health
// 攔截 → 認證存在性 → 額度 → body 上限 → 轉發 → 回應正規化」這條鏈能用 Hono 的
// app.request() 對真實 stub 後端做端到端測試。server.ts 在 import 時就會
// bot.init() 並對正式 bot 呼叫 setMyCommands，不可能在測試裡載入，這是唯一能
// 自動驗證這條鏈的方式。搬移過程沒有改寫任何既有邏輯，只加上 M1/M4 兩處修正
// 與測試用的注入點。
//
// 安全紀律（H14 AC11）：/login 的明文密碼會流經這一跳，本模組嚴禁任何
// console.log / console.error 印出 request/response 的 body 或 headers。
// request body 會在轉發前完整讀進記憶體（上限 MAX_PROXY_BODY_SIZE，理由見
// F-1 修正說明），但只是原樣交給 fetch，全程不檢視、不記錄、不落地；
// response body 仍是串流原樣轉回，SSE 長連線不受影響。

import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createTokenBucket, type TokenBucket } from '../security/rate-limit.ts'
import { respondUniform401 } from '../security/uniform-401.ts'

export type ProxyRoute = [prefix: string, port: number]

// 註冊順序是硬約束：Hono 依註冊順序匹配，這五條必須在 webhook route 之後、
// server.ts 那條 catch-all `app.all('*')` 之前，否則全部被 catch-all 的 401
// 吃掉。
export const PROXY_ROUTES: ProxyRoute[] = [
  ['/mcp-admin-dev', 8789],
  ['/mcp-admin-pre', 8791],
  ['/mcp-admin-evi', 8792],
  ['/mcp-platform', 8790], // 既有現役部署，即 platform dev×PK，別名沿用舊名不改
  ['/mcp-platform-dev-6t', 8793],
  ['/mcp-platform-pre-pk', 8794],
  ['/mcp-platform-pre-6t', 8795],
  ['/mcp-platform-evi-6t', 8796], // evi 目前只有 6T 產品的後台網址，沒有 evi×PK
  ['/toolsmith', 8788],
]

// RFC 9110/7230 hop-by-hop headers：只屬於「這一跳」的連線層 header，
// 轉發前必須移除（Connection header 自己點名的 header 也一併移除）。
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// 轉發用 request headers：
// - hop-by-hop 移除（含 Connection 點名的）。
// - host 移除：讓 fetch 依 target 自動補 localhost:<port>，不把 ngrok domain
//   的 Host 帶給後端。
// - content-length 移除：framing 一律由執行環境依實際送出的 body 重算（F-1
//   之後 body 是先讀進記憶體再交給 fetch，fetch 會自己補正確的
//   Content-Length）；沿用入站那份原始 Content-Length 是最典型的 proxy 破法，
//   它跟我們實際送出的位元組數不保證一致。
// - accept-encoding 移除：fetch 收到壓縮回應會自動解壓，但 Content-Encoding
//   header 仍留在回應上，原樣回傳會變成「header 說壓縮、body 已解壓」的
//   不一致；讓後端直接回未壓縮內容最單純（本機 loopback 無壓縮效益）。
// - 其餘（含 Accept、Authorization）原樣保留。
const stripForwardHeaders = (src: Headers): Headers => {
  const connectionListed = new Set(
    (src.get('connection') ?? '')
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(name => name !== ''),
  )
  const out = new Headers()
  for (const [name, value] of src) {
    if (HOP_BY_HOP_HEADERS.has(name) || connectionListed.has(name)) continue
    if (name === 'host' || name === 'content-length' || name === 'accept-encoding') continue
    out.set(name, value)
  }
  return out
}

// 回應 headers 同樣剝 hop-by-hop 與 content-length / content-encoding（framing
// 由本 server 對外重算；SSE 回應本來就沒有 content-length，Content-Type、
// X-Accel-Buffering 等原樣保留）。date 也剝掉：本 server 對外回應時會自己補
// 一個 Date，保留 upstream 的會變成重複兩個 Date header。
const stripResponseHeaders = (src: Headers): Headers => {
  const out = new Headers()
  for (const [name, value] of src) {
    if (HOP_BY_HOP_HEADERS.has(name)) continue
    if (name === 'content-length' || name === 'content-encoding' || name === 'date') continue
    out.set(name, value)
  }
  return out
}

/**
 * proxy 這一層所有的拒絕都必須跟 server.ts 那條 catch-all 逐位元組一致：
 * 401 + 空 body（那正是 grammy hono adapter 對 secret_token 錯誤的原生回應）。
 * 只要有任何一種拒絕長得不一樣，「前綴存在」就會被外部區分出來。回應內容與
 * 「在請求生命週期的哪個時點送出」都由 uniform-401.ts 統一定義，proxy 這裡
 * 只多做一件 proxy 才需要的事：把上游回應收乾淨。
 */
const uniform401 = (c: Context, upstream?: Response) => {
  // 已經開始接收的上游 body 要主動關掉，否則連線與緩衝區不會被釋放。串流若
  // 已中斷，cancel() 會 reject——這裡明確吞掉：沒有可做的補救，也不能 log
  // （見檔頭安全紀律），未處理的 rejection 反而會變成噪音。
  upstream?.body?.cancel().catch(() => {})
  return respondUniform401(c)
}

/**
 * M1：判定「這個上游狀態碼是否證明請求通過了 Bearer 認證」。
 *
 * 三支 hosted server（aladdin-admin / aladdin-platform / aladdin-toolsmith 的
 * src/http.ts）結構完全一致：Origin guard（403，**認證之前**）→ Bearer guard
 * （401，唯一例外是 path === '/health'）→ 各 route。所以「只可能由已認證請求
 * 收到的狀態碼」是可以逐一列舉的：
 *   - 2xx：正常業務回應（MCP、/login、/files）——全部在認證之後。
 *   - 400：/login、/files 的 JSON／參數錯誤（aladdin-admin/src/http.ts:177,192,265,271,280）。
 *   - 405：GET /mcp（同檔 :326）。
 *   - 413：/files 超過檔案大小上限（同檔 :255）。
 *   - 429：/login 帳號層節流（同檔 :166）。
 * 其餘一律不可信為「已認證」，全部正規化成均一 401：
 *   - 403 來自認證之前的 Origin guard（同檔 :85-90），任何人加個 Origin header
 *     就能拿到，是最廉價的前綴預言機。
 *   - 404 可由認證豁免的 /health 用非 GET 方法觸發（實測 POST /<prefix>/health
 *     回 404）。
 *   - 500 可能由認證 middleware 自己拋例外產生，不保證在認證之後。
 *   - 3xx 目前沒有任何 route 會產生，出現就是非預期狀態。
 *   - 502 是 proxy 自己在後端未啟動時產生的（未啟動的 /toolsmith、
 *     /mcp-admin-pre、/mcp-admin-evi 平時就是這種），直接洩漏「前綴存在但服務
 *     沒開」。
 *
 * 為什麼是白名單而不是「所有非 2xx 一律正規化」：405 對 MCP client 是功能性
 * 依賴，不是可有可無的錯誤碼——GET /mcp 必須回 405，client 才會判定「server
 * 沒有提供 GET SSE」而安靜下來；換成 401 會被當成認證失敗（見
 * aladdin-admin/src/http.ts:37-49 對 SDK client 行為的實測記錄）。400/413/429
 * 同理，是企劃端 skill 用來分辨「參數寫錯 / 檔案太大 / 被節流」與「要重新
 * 登入」的唯一依據，全部壓成 401 會讓每個錯誤都被誤導成「去重新登入」。
 *
 * 已知殘餘（刻意接受）：這份白名單綁定「hosted server 的認證豁免只有 GET
 * /health」這個前提。若未來任何一支 hosted server 新增認證豁免的 route，且它
 * 會回 400/405/413/429，預言機就會重新打開。三支 server 的認證 middleware 都
 * 已在自己的檔頭註記這件事的敏感性，改動時會看到。
 */
const AUTHENTICATED_ONLY_STATUSES = new Set([400, 405, 413, 429])

export function isAuthenticatedUpstreamStatus(status: number): boolean {
  if (status >= 200 && status < 300) return true
  return AUTHENTICATED_ONLY_STATUSES.has(status)
}

// H31：五條 proxy route 各自的流量層量體控制（rate limit + body size）。
//
// 【硬性要求：bucket 絕不共用】——每條 route 在下面迴圈裡各自呼叫
// createTokenBucket()，彼此獨立（三條 admin 路由之間也各自獨立，避免一個
// 環境的高頻使用波及另一個環境的企劃），也都不與 webhook 那顆 bucket 共用：
// webhook 的 createRateLimitMiddleware() 沒帶參數、內部自建自己的 bucket
// （見 rate-limit.ts createRateLimitMiddleware 預設值），本模組每次呼叫都
// 另外自建、物件各自獨立、互不影響——MCP 流量吃掉 TG 的額度會讓團隊的 bug
// 認領入口失效，反之亦然。
//
// admin 三條與 platform 給較寬鬆的容量：MCP 一次對話可能連續呼叫多支 tool，
// 訂太小會誤擋企劃正常操作。toolsmith 因為後端 N=1 併發、單次操作數分鐘，
// 容量另訂且明顯較小，避免一個長任務就把整個 process 對 toolsmith 的額度
// 耗盡太久。這裡的數字只抓量級，不追求精確到某個神聖數值；toolsmith 的
// capacity 訂在 10 而非更貼近下限的 5——已知一次 MCP 冷啟動握手
// （initialize + notifications/initialized + tools/list 三個 POST）就吃掉
// 3 顆，訂太緊握手都做不完就先被 429。
const MCP_ROUTE_CAPACITY = 30
const MCP_ROUTE_REFILL_PER_SECOND = 30 / 60 // 每分鐘 30 次
const TOOLSMITH_CAPACITY = 10
const TOOLSMITH_REFILL_PER_SECOND = 5 / 60 // 每分鐘 5 次

export const PROXY_ROUTE_LIMITS: Record<string, BucketLimit> = {
  '/mcp-admin-dev': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-admin-pre': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-admin-evi': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-platform': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-platform-dev-6t': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-platform-pre-pk': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-platform-pre-6t': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-platform-evi-6t': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/toolsmith': { capacity: TOOLSMITH_CAPACITY, refillPerSecond: TOOLSMITH_REFILL_PER_SECOND },
}

// M4：轉發閘（flood breaker），與上面的「已認證額度」分開的第二顆 bucket。
//
// 它的職責只有一個：擋住「持續高速灌流量、每一發都要 proxy 幫忙 fetch 到本機
// 後端」的洪水，讓後端不用為每一發假 token 做一次名冊讀取與比對。它不是業務
// 配額（業務配額是上面那顆），所以刻意訂得比任何合理使用量高一個量級：
// 每分鐘 120 次、瞬間爆發 120 次。
//
// 為什麼是 120 而不是沿用 30：M4 的攻擊之所以「便宜又隱形」，正是因為 30/分鐘
// 這種業務級數字用 1 req/2s 就能長期壓在底部。把轉發閘拉到 2 req/s，攻擊者要
// 觸發它就必須持續打出 ngrok 流量統計上看得見的量，而且觸發之後拿到的仍是跟
// 猜錯前綴一模一樣的 401——他既問不出新資訊，也拿不到「悄悄讓別人被擋」的
// 效果（合法使用者的額度另計，見下方 quota gate）。
const FORWARD_CAPACITY = 120
const FORWARD_REFILL_PER_SECOND = 120 / 60 // 每分鐘 120 次

// 未認證的巨大 body 會被 proxy 串流轉發到 localhost（認證是在 hosted server
// 那端才發生），這一層要擋在 proxy，跟 webhook 的量級一致。
const MAX_PROXY_BODY_SIZE = 1024 * 1024 // 1MB

export type BucketLimit = { capacity: number; refillPerSecond: number }

export type RegisterProxyRoutesOptions = {
  /** 測試用：覆寫 route 表（prefix → 本機 port）。 */
  routes?: ProxyRoute[]
  /**
   * 測試用：覆寫兩顆 bucket 的參數與時鐘。正式啟動不帶這個參數，一律吃上面
   * 的常數；測試要驗證額度行為，只能靠注入假時鐘（硬規則：測試不得靠
   * sleep/等待時間成立）。
   */
  buckets?: {
    authed?: BucketLimit
    forward?: BucketLimit
    now?: () => number
  }
}

// H31 review 收尾（正確性 + 安全兩份 fresh-context review 獨立判定為同一個
// 真實回歸，非可接受取捨）：rateLimit 與 bodyLimit 原本掛在任何認證檢查之
// 前（甚至在 handler 內、fetch 之前才做的 raw-prefix 字面檢查之前），
// 兩個後果：
// 1. 未認證的請求也能消耗額度做 DoS——違反 rate-limit.ts:15-18 自己寫明的
//    掛載前提（webhook 版本的同一類問題 T25 修過一次，這裡在 proxy route
//    上重現）。
// 2. bodyLimit 413（以及打滿額度的 429）是比 502 更強的側信道：單一請求
//    （>1MB body、完全不需認證）就能 100% 確定性探測出前綴是否存在。
//
// 修法（範圍限定，不是完整認證——真正認證仍在各 hosted server 那端）：
// - rawPrefixGuard：把原本在 handler 內才做的字面前綴檢查，搬到 middleware
//   鏈最前面，讓 percent-encoding 前綴探測在消耗任何額度之前就被均一 401
//   擋下。
// - authPresenceGuard：沒有 Authorization header 的請求視為零知識攻擊者，
//   直接回均一 401，不進額度、不進 bodyLimit。
// - bodyLimit 的 onError 從 413 改回均一 401。注意這只覆蓋 bodyLimit「有
//   Content-Length、進 handler 前就短路」那條分支；沒有 Content-Length／
//   chunked 傳輸時超量走的是 fetch 對已中斷串流拋例外 → handler 的 catch，
//   M1 之後那條路徑也回均一 401（原本是 502）。
const authPresenceGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.header('authorization') === undefined) {
    return uniform401(c)
  }
  await next()
}

const createRawPrefixGuard = (prefix: string): MiddlewareHandler => {
  return async (c, next) => {
    // 用字串串接組 target，不用 new URL(path, base)——path 若以 // 開頭會被
    // URL 建構子當成 protocol-relative host，變成對外任意轉發（open proxy）。
    const url = new URL(c.req.url)
    // Review 修正：Hono 路由匹配會解碼非斜線的 %XX（如 /mcp-admin-de%76/…
    // 會命中 /mcp-admin-dev/*），但這裡的 url.pathname 是未解碼的原文，
    // slice(prefix.length) 會切錯位、組出無效 target 而落到 502——502 與
    // catch-all 的 401 可被外部區分，等於免 token 探測出前綴存在。前綴段
    // 的字面文字不符時（合法 client 的前綴本來就不含編碼字元），直接回
    // 與 catch-all 一致的 401 + 空 body，不進轉發邏輯。
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) {
      return uniform401(c)
    }
    await next()
  }
}

/**
 * M1：/health 是三支 hosted server 刻意豁免 Bearer 認證的端點
 * （aladdin-admin/src/http.ts:103-108，platform / toolsmith 同構），所以只要
 * 塞一個假 Authorization header 就能拿到 `200 {"status":"ok",
 * "uptime_seconds":N}`——同時確認「這個前綴後面有服務」「它活著」「它上次
 * 重啟在多久以前」。它是 2xx，靠回應正規化關不掉（2xx 必須放行，否則正常
 * 業務回應全毀），只能在剝掉前綴之後直接攔截這個 path、完全不轉發。
 *
 * 比對的是解碼後的字串：Hono 路由匹配會解碼非斜線的 %XX（見上面
 * rawPrefixGuard 的說明），`/<prefix>/%68ealth` 這種寫法一樣會被後端 Hono
 * 匹配到 /health，只比對原文會被繞過。query string 不影響判定，因為
 * url.pathname 本來就不含 query（`/health?x=1` 在後端一樣命中 /health）。
 *
 * 權衡：經公網（ngrok）打 /<prefix>/health 這個外部健康檢查手段不再可用。
 * hosted server 的存活探測改用本機直連 http://127.0.0.1:<port>/health——
 * launchd 與人工排查本來就走本機，這條公網路徑本來就非必要。dispatcher
 * 自己的 /health（server.ts）不經過 proxy，不受影響。
 */
const createHealthBlockGuard = (prefix: string): MiddlewareHandler => {
  return async (c, next) => {
    const rawSubPath = new URL(c.req.url).pathname.slice(prefix.length)
    let decodedSubPath = rawSubPath
    try {
      decodedSubPath = decodeURIComponent(rawSubPath)
    } catch {
      // 無效的 percent-encoding：維持原文比對即可，後端也解不開這種路徑。
    }
    if (rawSubPath === '/health' || decodedSubPath === '/health') {
      return uniform401(c)
    }
    await next()
  }
}

/**
 * M4：轉發前的兩道額度判定。
 *
 * 原本只有一顆 bucket、掛在 authPresenceGuard 之後，而 authPresenceGuard 只
 * 檢查 Authorization header 存不存在、不驗真偽——攻擊者塞
 * `Authorization: Bearer x`，用 1 req/2s 就能讓該 route 的額度長期見底，合法
 * 企劃的 MCP 握手（initialize + notifications/initialized + tools/list 三發）
 * 永久 429。成本近乎為零、流量低到不觸發任何告警。server.ts 當時的註解自己
 * 記載了這是「刻意接受的殘餘缺口」，前提是「尚未真正對外」——前提已經不成立。
 *
 * 修法是把「量體控制」拆成兩件本來就不同的事：
 * - authed（已認證額度）：業務配額，只在收到上游回應、且該回應證明認證成功
 *   （isAuthenticatedUpstreamStatus）之後才扣。轉發前只用 hasTokens() 查詢、
 *   不扣款。結果：認證失敗的請求永遠不會消耗這顆 bucket，攻擊者再怎麼打也
 *   壓不到合法使用者的額度——M4 的連坐被結構性地消除，不是靠調參數。
 * - forward（轉發閘）：每一發轉發都扣，容量拉高一個量級（見 FORWARD_CAPACITY
 *   的說明），只在真正的洪水下才觸發。
 *
 * 為什麼不能只留 authed 一顆：那會讓未認證請求完全不受量體控制，每一發都要
 * proxy 幫忙 fetch 到本機後端——這正是 H31 那一輪修正時踩過的坑（限流放在
 * 認證前造成未認證即可 DoS）的反向版本。兩顆 bucket 才同時滿足「攻擊者打不
 * 到合法使用者的額度」與「後端不會被無限灌」。
 *
 * 順序（authed 查詢在前、forward 扣款在後）是刻意的：已經超出自己業務配額的
 * 合法使用者會在這裡被擋下，而且不該因此吃掉轉發閘的額度——那顆是留給擋洪水
 * 用的，不該被正常使用者的超額請求消耗掉。
 *
 * 兩種拒絕都回均一 401，不回 429：429 本身就是「這個前綴存在」的側信道
 * （猜錯前綴只會拿到 catch-all 的 401），會直接架空 M1 剛關掉的預言機。
 */
const createQuotaGate = (authed: TokenBucket, forward: TokenBucket): MiddlewareHandler => {
  return async (c, next) => {
    if (!authed.hasTokens() || !forward.tryConsume()) {
      return uniform401(c)
    }
    await next()
  }
}

export function registerProxyRoutes(app: Hono, opts: RegisterProxyRoutesOptions = {}): void {
  const routes = opts.routes ?? PROXY_ROUTES
  const now = opts.buckets?.now

  for (const [prefix, port] of routes) {
    const authedLimit = opts.buckets?.authed ?? PROXY_ROUTE_LIMITS[prefix]
    if (authedLimit === undefined) {
      throw new Error(`proxy route ${prefix} 沒有對應的額度設定（PROXY_ROUTE_LIMITS 漏了）`)
    }
    const forwardLimit = opts.buckets?.forward ?? {
      capacity: FORWARD_CAPACITY,
      refillPerSecond: FORWARD_REFILL_PER_SECOND,
    }
    const authedBucket = createTokenBucket({ ...authedLimit, now })
    const forwardBucket = createTokenBucket({ ...forwardLimit, now })

    app.all(
      `${prefix}/*`,
      createRawPrefixGuard(prefix),
      createHealthBlockGuard(prefix),
      authPresenceGuard,
      createQuotaGate(authedBucket, forwardBucket),
      bodyLimit({
        maxSize: MAX_PROXY_BODY_SIZE,
        onError: c => uniform401(c),
      }),
      async c => {
        const url = new URL(c.req.url)
        const targetUrl = `http://localhost:${port}${url.pathname.slice(prefix.length)}${url.search}`

        // F-1：request body 先完整讀進記憶體才轉發，不再把入站串流直接交給
        // fetch（原本是 `body: c.req.raw.body` + `duplex: 'half'`）。
        //
        // 串流轉發時，上游只要沒讀 body 就先回認證失敗（hosted server 的
        // Bearer guard 正是如此，見 aladdin-admin/src/auth.ts），fetch 會在
        // 入站 body 還在傳輸途中中止它，Bun 因此在 Hono 的回應路徑之外送出
        // 400 + 空 body——一個只在「前綴存在且後端在跑」時才出現的旁通道，
        // isAuthenticatedUpstreamStatus 看不到它，正規化無從介入。先讀完再
        // 轉發之後，入站串流不再有「被讀到一半才中止」的狀態，這條 race 是
        // 結構上不可能發生，不是機率被壓低（實測見 mcp-proxy.test.ts）。
        //
        // 取捨（刻意接受）：轉發中的請求會各自佔住最多 MAX_PROXY_BODY_SIZE
        // 的記憶體，原本串流轉發幾乎不佔。上限由三者相乘夾住：單一 body
        // ≤1MB（下面的 bodyLimit）、每條 route 每分鐘最多 120 發能走到這裡
        // （M4 轉發閘）、停在半途的連線 120 秒被 Bun idleTimeout 回收。而且
        // 要佔住記憶體就得真的把位元組送上來，等於必須打出 ngrok 流量統計上
        // 看得見的量——這正是 M4 轉發閘刻意要逼出來的性質。
        //
        // 對正常路徑無影響：MCP 的 JSON-RPC body、/login 的 JSON、/files 的
        // 圖片上傳都是有限且 ≤1MB 的 body（SSE 是**回應**側，仍然串流，見
        // 下面 new Response(upstream.body)）。
        let forwardBody: ArrayBuffer | null = null
        try {
          if (c.req.raw.body !== null) {
            forwardBody = await c.req.raw.arrayBuffer()
          }
        } catch {
          // bodyLimit 的串流分支（沒有 Content-Length／chunked）超量時就是在
          // 這裡拋出來的，跟其他所有拒絕一樣回均一 401。
          return uniform401(c)
        }

        let upstream: Response
        try {
          upstream = await fetch(targetUrl, {
            method: c.req.method,
            headers: stripForwardHeaders(c.req.raw.headers),
            body: forwardBody,
            // 3xx 原樣轉回呼叫端，proxy 不代為跟隨（跟隨會把後端的 localhost
            // redirect 目標當成 proxy 自己要去打的地址）。
            redirect: 'manual',
          })
        } catch {
          // 後端未啟動（如 /toolsmith 的 8788）或連線失敗。M1 之前這裡回 502，
          // 而猜錯前綴回 401——一個請求就能分辨「前綴存在但服務沒開」。現在
          // 一律回均一 401，跟其他所有拒絕逐位元組相同；後端有沒有在跑要看
          // 本機的 launchd/log，不從公網問。
          return uniform401(c)
        }
        // M1：只有能證明「請求通過了 hosted server 的 Bearer 認證」的回應才
        // 原樣轉回（含它的狀態碼與 headers）；其餘一律換成均一 401 空 body，
        // 讓「路徑不存在」「前綴存在但認證失敗」「前綴存在但服務沒開」
        // 「前綴存在且帶了 Origin header」從外部完全不可區分。判定與理由見
        // isAuthenticatedUpstreamStatus。
        if (!isAuthenticatedUpstreamStatus(upstream.status)) {
          return uniform401(c, upstream)
        }
        // M4：到這裡才確定這是一次合法使用者的用量，扣他自己的業務配額。
        // 回傳值刻意忽略：放不放行是轉發之前 quota gate 用 hasTokens() 決定
        // 的，這裡只負責記帳。並行的多個請求可能同時通過那次查詢、造成最多
        // 「同時在途請求數 - 1」發的超額（tokens 不會低於 0，tryConsume 額度
        // 不足時不扣），量級遠小於 capacity，且下一發就會被擋下。已經跑完的
        // 後端工作不會因為記帳失敗就把回應丟掉。
        authedBucket.tryConsume()
        return new Response(upstream.body, {
          status: upstream.status,
          headers: stripResponseHeaders(upstream.headers),
        })
      },
    )
  }
}
