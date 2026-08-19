// Telegram dispatcher — webhook server 入口。
// inline keyboard、認領流程等留給後續 task（見 tasks.json）。

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { webhookCallback } from 'grammy'
import { bot } from './lib/webhook-server/bot.ts'
import { registerHandlers } from './lib/security/whitelist.ts'
import { createRateLimitMiddleware, createTokenBucket } from './lib/security/rate-limit.ts'
import { createWebhookSecretGuard } from './lib/security/webhook-secret-guard.ts'
import { createHealthMonitor } from './lib/webhook-server/health-monitor.ts'

registerHandlers(bot)

// 提前 await bot.init()（Bun.serve 開始監聽之前）：webhookCallback 內部只在
// 第一次呼叫時才 await bot.init()，若第一個進來的請求是攻擊者的無效
// payload，仍會觸發一次真正打 Telegram API 的 init，把冷啟動延遲疊加在
// 使用者請求上——見 tasks.json T4 risk_notes。
await bot.init()
console.error(`telegram-dispatcher: bot initialized as @${bot.botInfo.username}`)

// T30：讓 Telegram 客戶端的「/」指令選單顯示 /bug /req /menu（含說明文字），
// 使用者打「/」時才有 autocomplete 可選，不用死記指令字串。setMyCommands
// 是覆寫式、冪等 API，每次啟動都呼叫一次即可維持跟 whitelist.ts 實際路由
// 邏輯同步，不需要另外手動用 BotFather 維護一份容易漂移的清單。
//
// 明確指定 scope: all_private_chats（而非留白吃 default scope）：Telegram
// 的 scope 優先序是 chat 專屬 > all_private_chats > default，這個 bot 本來
// 就是純 DM 使用（白名單靠 chat_id 判斷，見 whitelist.ts），語意上本該對應
// all_private_chats；且實測發現這個 bot token 底下先前已經有一組殘留在
// all_private_chats scope 的舊指令（/start /help /status，來源不明，疑似
// BotFather 建立時的預設範本），優先度比 default 高，只設 default 蓋不掉，
// 使用者端「/」選單仍會看到舊清單——已改成直接設在 all_private_chats scope
// 蓋掉殘留值。
await bot.api.setMyCommands(
  [
    { command: 'bug', description: '列出你可認領的 Bug 工單' },
    { command: 'req', description: '需求池（開發中，見 T23）' },
    { command: 'menu', description: '顯示頂層選單' },
  ],
  { scope: { type: 'all_private_chats' } },
)

const app = new Hono()

// T24 review 順帶發現並修正：空 body／格式錯誤的 JSON（帶對的 secret_token）
// 會讓 grammy 的 c.req.json() 丟出未捕捉的 SyntaxError，沒有這個 handler 時
// Hono 只會回通用的 500（不會讓 process 崩潰或卡住，但回應不夠乾淨、且會把
// 內部例外訊息暴露出去）。全域接住：JSON 格式錯誤回乾淨的 400，其他真正
// 未預期的例外才維持 500（且不把例外內容回給呼叫端，只留在 stderr）。
app.onError((err, c) => {
  if (err instanceof SyntaxError) {
    return c.text('Bad Request', 400)
  }
  console.error(`unhandled error: ${err}`)
  return c.text('Internal Server Error', 500)
})

// T19 review 順帶發現並修正：這裡原本回明文 'telegram-dispatcher: placeholder
// ok'——跟 webhook 路徑、/health 一樣不驗證任何東西，卻直接把專案名稱洩漏
// 出去，讓 /health 刻意不透露身分的用心失去意義（換個路徑就查得到）。跟
// /health 一致，只回最基本、不帶專案識別資訊的內容。
app.get('/', c => c.text('ok', 200))

// T19：跟 webhook 路徑不同，這個 endpoint 刻意不驗證 secret_token（供外部
// 監控探測），內容只能是最基本的存活資訊——絕不能出現 ticket 編號、
// assignee 姓名/email 等業務細節，否則等於給外部免費偵察窗口。
app.get('/health', c => c.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }))

// T14：webhook 路徑本身也是一道防線（secret_token 防「來源真偽」，路徑防
// 「被 fuzz 出來」），路徑跟 secret 都只從 process.env 讀（值來自
// /Users/user/aladdin/.env，比照 bot.ts 對 TG_DISPATCH_BOT_TOKEN 的手法——
// 啟動 wrapper script 匯出，不自己解析 .env、不印出值、不寫死）。
const webhookPath = process.env.TG_WEBHOOK_PATH
const webhookSecret = process.env.TG_WEBHOOK_SECRET
if (!webhookPath || !webhookSecret) {
  throw new Error('TG_WEBHOOK_PATH / TG_WEBHOOK_SECRET is required (export them from /Users/user/aladdin/.env before starting)')
}
// review 發現：Hono 路由把開頭 `:` 當成路徑參數、單獨 `*` 當成萬用字元，這種
// 值會讓任何猜測都命中 webhook 路由，直接讓「秘密路徑」變成公開路由。目前
// 產生方式（crypto.randomBytes(24).toString('hex')）只會是 [0-9a-f]，不會踩到，
// 但 .env 是人工可編輯的檔案，格式在啟動時就驗證掉比運行期間才發現安全。
if (!/^[0-9a-f]{32,}$/.test(webhookPath)) {
  throw new Error('TG_WEBHOOK_PATH 格式不對（必須是純 hex 字串，長度 ≥32）：可能被誤改，拒絕啟動以免變成公開路由')
}

// T17：沒有覆寫 timeoutMilliseconds（維持 grammy 預設 10 秒、onTimeout='throw'）。
// bot.on('message') 熱路徑上唯一會打真實網路的一段（T6 queryCandidateTickets）
// 實測 5 次落在 400-720ms（見 tasks.json T17 changelog），離 10 秒有 10 倍以上
// margin；該函式也已改成非阻塞 async（見 candidate-tickets.ts 註解），單一
// 使用者的請求變慢不會拖累其他人，不需要為了單一極端情境放寬全域 timeout。
// T24：正常 Telegram update（含 message/callback_query/photo caption 等常見
// 欄位）就算塞滿文字上限也只有幾 KB，1MB 給了充足margin；限制目的是擋異常
// 巨大 body 造成的記憶體壓力，不是卡正常流量。
//
// review 實測澄清（讀 hono bodyLimit 原始碼＋live test 確認，不是憑印象）：
// 帶 Content-Length 的一般請求（真實 Telegram webhook 都是這種）會在進
// webhookCallback 之前就短路擋掉，如原本描述；但沒有 Content-Length 或用
// chunked 傳輸時，bodyLimit 走的是邊讀邊計位元組數的串流模式，webhookCallback
// 會先開始執行、直到串流讀超過 maxSize 才丟例外變成 413——結果一樣正確
// （超過 1MB 的資料不會真的進到記憶體，413 也照樣正確回），只是「一定
// 在解析邏輯之前短路」這句話對 chunked 這條分支不完全成立，如實記錄。
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024 // 1MB

// T25 review 發現並修正：secret_token 驗證要排在量體控制之前——rate limit
// 原本掛在 webhookCallback（真正驗證 secret_token 的地方）之前，代表任何
// 知道路徑但沒有 token 的請求也能消耗全域額度，連帶讓合法請求被 429，且
// 429 跟下面 catch-all 的 401 不一致，會變成「這條路徑存在」的側漏訊號，
// 破壞 T14 的均一回應防線。createWebhookSecretGuard 自己先做一次跟 grammy
// 對等（含常數時間比較、含完全一致的 401 空 body 回應）的驗證，見
// lib/security/webhook-secret-guard.ts 檔頭註解；只有通過的請求才進到
// rate limit，webhookCallback 內部還會再驗一次 secret_token，重複但無害。
app.post(
  `/${webhookPath}`,
  createWebhookSecretGuard(webhookSecret),
  createRateLimitMiddleware(),
  bodyLimit({
    maxSize: MAX_WEBHOOK_BODY_SIZE,
    onError: c => c.text('Payload Too Large', 413),
  }),
  webhookCallback(bot, 'hono', { secretToken: webhookSecret }),
)

// H14：hosted MCP path 分流 proxy——共用既有 ngrok domain，把五個前綴各自
// 剝掉後轉發到本機對應 port 的 hosted server（例：/mcp-admin-dev/login →
// http://localhost:8789/login）。認證由各 hosted server 自己的 Bearer token
// 把關，這裡只做純轉發，跟 webhook 的 secret guard 無關（那道 guard 只掛在
// webhook 那一條 route 上，不是全域 middleware）。
//
// 註冊順序是硬約束：Hono 依註冊順序匹配，這五條必須在 webhook route 之後、
// 下面 catch-all `app.all('*')` 之前，否則全部被 catch-all 的 401 吃掉。
//
// 安全紀律（H14 AC11）：/login 的明文密碼會流經這一跳，本段落嚴禁任何
// console.log / console.error 印出 request/response 的 body 或 headers，
// body 只以串流原樣轉發、不讀取不緩衝。
const PROXY_ROUTES: Array<[prefix: string, port: number]> = [
  ['/mcp-admin-dev', 8789],
  ['/mcp-admin-pre', 8791],
  ['/mcp-admin-evi', 8792],
  ['/mcp-platform', 8790],
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
// - content-length 移除：body 是串流轉發，由執行環境重算 framing；沿用原始
//   Content-Length 配串流 body 是最典型的 proxy 破法。
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

// H31：五條 proxy route 各自的流量層量體控制（rate limit + body size）。
//
// 【硬性要求：bucket 絕不共用】——每條 route 在下面迴圈裡各自呼叫一次
// createTokenBucket()，彼此獨立（三條 admin 路由之間也各自獨立，避免一個
// 環境的高頻使用波及另一個環境的企劃），也都不與上面 webhook 那顆 bucket
// 共用：webhook 的 createRateLimitMiddleware() 沒帶參數、內部自建自己的
// bucket（見 rate-limit.ts createRateLimitMiddleware 預設值），本段落每次
// 呼叫都另外自建一顆，物件各自獨立、互不影響——MCP 流量吃掉 TG 的額度會讓
// 團隊的 bug 認領入口失效，反之亦然。
//
// admin 三條與 platform 給較寬鬆的容量：MCP 一次對話可能連續呼叫多支 tool，
// 訂太小會誤擋企劃正常操作。toolsmith 因為後端 N=1 併發、單次操作數分鐘，
// 容量另訂且明顯較小，避免一個長任務就把整個 process 對 toolsmith 的額度
// 耗盡太久。這裡的數字只抓量級，不追求精確到某個神聖數值。
const MCP_ROUTE_CAPACITY = 30
const MCP_ROUTE_REFILL_PER_SECOND = 30 / 60 // 每分鐘 30 次
const TOOLSMITH_CAPACITY = 5
const TOOLSMITH_REFILL_PER_SECOND = 5 / 60 // 每分鐘 5 次

// 未認證的巨大 body 會被 proxy 串流轉發到 localhost（認證是在 hosted server
// 那端才發生），這一層要擋在 proxy，跟上面 webhook 的量級一致。
const MAX_PROXY_BODY_SIZE = 1024 * 1024 // 1MB

const PROXY_ROUTE_LIMITS: Record<string, { capacity: number; refillPerSecond: number }> = {
  '/mcp-admin-dev': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-admin-pre': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-admin-evi': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/mcp-platform': { capacity: MCP_ROUTE_CAPACITY, refillPerSecond: MCP_ROUTE_REFILL_PER_SECOND },
  '/toolsmith': { capacity: TOOLSMITH_CAPACITY, refillPerSecond: TOOLSMITH_REFILL_PER_SECOND },
}

for (const [prefix, port] of PROXY_ROUTES) {
  const rateLimit = createRateLimitMiddleware(createTokenBucket(PROXY_ROUTE_LIMITS[prefix]))
  app.all(
    `${prefix}/*`,
    rateLimit,
    bodyLimit({
      maxSize: MAX_PROXY_BODY_SIZE,
      onError: c => c.text('Payload Too Large', 413),
    }),
    async c => {
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
      c.status(401)
      return c.body('')
    }
    const targetUrl = `http://localhost:${port}${url.pathname.slice(prefix.length)}${url.search}`
    let upstream: Response
    try {
      upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers: stripForwardHeaders(c.req.raw.headers),
        body: c.req.raw.body,
        // 3xx 原樣轉回呼叫端，proxy 不代為跟隨（跟隨會把後端的 localhost
        // redirect 目標當成 proxy 自己要去打的地址）。
        redirect: 'manual',
        // @ts-expect-error duplex 是 fetch 串流 request body 的必要選項，型別定義未含
        duplex: 'half',
      })
    } catch {
      // 後端未啟動（如 /toolsmith 的 8788）或連線失敗：回乾淨的 502，不讓
      // 例外冒泡、不影響其他 route；刻意不 log（見上方安全紀律）。
      return c.text('Bad Gateway', 502)
    }
    // 401（未帶/帶錯 Bearer token，由 hosted server 自己的認證判定）對外一律
    // 改回與下面 catch-all 完全一致的 401 + 空 body——不轉發 hosted server 的
    // 401 body 與 WWW-Authenticate 之類 header，讓「路徑存在但沒過認證」與
    // 「路徑不存在」從外部不可區分，維持 T14 均一回應防線。MCP client 端只
    // 依 401 狀態碼判定認證失敗，不需要 body。
    if (upstream.status === 401) {
      void upstream.body?.cancel()
      c.status(401)
      return c.body('')
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: stripResponseHeaders(upstream.headers),
    })
  })
}

// 任何沒命中上面路由的請求（含猜錯 webhook 路徑）一律回跟「secret_token 錯誤」
// 一模一樣的回應：401 + 空 body——這正是 grammy hono adapter 對 secret_token
// 錯誤的原生回應（見 node_modules/grammy/out/convenience/frameworks.js 的
// hono() adapter unauthorized 分支：c.status(401); c.body("")），不是我們自己
// 另外編一種格式去湊巧一致。刻意放在所有路由最後，只攔截真正沒命中的請求，
// 不影響上面 '/' 健康檢查與正確 webhook 路徑本身。
app.all('*', c => {
  c.status(401)
  return c.body('')
})

// T19：每分鐘查一次本機 ngrok admin API，tunnel 狀態翻轉時發 tg-notify.sh
// 告警給維運者（見 health-monitor.ts 註解）。用 setInterval 週期排程，不是
// sleep/輪詢規避競態。
createHealthMonitor().start()

const port = Number(process.env.PORT ?? 8787)

export default {
  fetch: app.fetch,
  port,
  // H14：Bun.serve 預設 idleTimeout 10 秒——低於 MCP SDK SSE keep-alive 的
  // 15 秒間隔，proxy 轉發的 text/event-stream 長連線會在 frame 間隙被 Bun
  // 掐斷（實測：SSE 經 proxy 約 10 秒斷線、收不到 15 秒的 keep-alive frame）。
  // 提高到 120 秒讓 SSE 長連線活得過 keep-alive 週期（8 倍 margin）。對
  // webhook / 其他短請求的影響只是 idle 連線可掛更久，本服務前面有 ngrok、
  // 流量極小，可接受。注意 Bun 的 idleTimeout 上限是 255 秒：若未來 hosted
  // 端出現超過 120 秒完全無輸出的同步長請求（如 toolsmith 生成），這一跳
  // 仍會斷，屆時要靠應用層週期輸出（SSE keep-alive）解，不是再調大這裡。
  idleTimeout: 120,
}
