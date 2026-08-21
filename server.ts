// Telegram dispatcher — webhook server 入口。
// inline keyboard、認領流程等留給後續 task（見 tasks.json）。

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { webhookCallback } from 'grammy'
import { bot } from './lib/webhook-server/bot.ts'
import { registerHandlers } from './lib/security/whitelist.ts'
import { createRateLimitMiddleware } from './lib/security/rate-limit.ts'
import { createWebhookSecretGuard } from './lib/security/webhook-secret-guard.ts'
import { respondUniform401 } from './lib/security/uniform-401.ts'
import { createHealthMonitor } from './lib/webhook-server/health-monitor.ts'
import { registerProxyRoutes } from './lib/webhook-server/mcp-proxy.ts'

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
    { command: 'req', description: '列出你可認領的需求單' },
    { command: 'menu', description: '顯示頂層選單' },
  ],
  { scope: { type: 'all_private_chats' } },
)

// /kit 只給 TG_KIT_ADMIN_CHAT_ID 這一個 chat 看得到「/」選單裡的 autocomplete
// （chat 專屬 scope 優先序高於上面的 all_private_chats，其他人的選單不受
// 影響）。這只影響 UI 提示，實際授權判斷在 whitelist.ts 的 isKitAdminChat——
// 就算這裡沒設定，非授權者手動打 /kit 也一樣被擋掉，見 kit-issue.ts 檔頭註解。
const kitAdminChatId = process.env.TG_KIT_ADMIN_CHAT_ID
if (kitAdminChatId) {
  await bot.api.setMyCommands(
    [
      { command: 'bug', description: '列出你可認領的 Bug 工單' },
      { command: 'req', description: '列出你可認領的需求單' },
      { command: 'menu', description: '顯示頂層選單' },
      { command: 'kit', description: '核發企劃 starter kit（/kit <id> <name>）' },
    ],
    { scope: { type: 'chat', chat_id: Number(kitAdminChatId) } },
  )
}

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
// http://localhost:8789/login）。整段實作（含 M1 的回應正規化與 M4 的雙
// bucket 額度）搬到 lib/webhook-server/mcp-proxy.ts，那裡有完整的設計說明
// 與端到端測試（mcp-proxy.test.ts）——本檔在 import 時就會 bot.init() 並對
// 正式 bot 呼叫 setMyCommands，測試無法載入，proxy 邏輯留在這裡等於沒有任何
// 自動驗證。
//
// 註冊位置是硬約束：Hono 依註冊順序匹配，這一行必須在上面 webhook route
// 之後、下面 catch-all `app.all('*')` 之前，否則五條 proxy route 全部被
// catch-all 的 401 吃掉。
registerProxyRoutes(app)

// 任何沒命中上面路由的請求（含猜錯 webhook 路徑）一律回跟「secret_token 錯誤」
// 一模一樣的回應：401 + 空 body。回應內容與送出時點的定義都在
// lib/security/uniform-401.ts（那裡也記著為什麼「拒絕也要先把 request body
// 讀掉」——F-1）。刻意放在所有路由最後，只攔截真正沒命中的請求，不影響上面
// '/' 健康檢查與正確 webhook 路徑本身。
app.all('*', c => respondUniform401(c))

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
