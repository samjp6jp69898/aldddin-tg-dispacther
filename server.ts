// Telegram dispatcher — webhook server 入口。
// inline keyboard、認領流程等留給後續 task（見 tasks.json）。

import { Hono } from 'hono'
import { webhookCallback } from 'grammy'
import { bot } from './lib/webhook-server/bot.ts'
import { registerHandlers } from './lib/security/whitelist.ts'

registerHandlers(bot)

// 提前 await bot.init()（Bun.serve 開始監聽之前）：webhookCallback 內部只在
// 第一次呼叫時才 await bot.init()，若第一個進來的請求是攻擊者的無效
// payload，仍會觸發一次真正打 Telegram API 的 init，把冷啟動延遲疊加在
// 使用者請求上——見 tasks.json T4 risk_notes。
await bot.init()
console.error(`telegram-dispatcher: bot initialized as @${bot.botInfo.username}`)

const app = new Hono()

app.get('/', c => c.text('telegram-dispatcher: placeholder ok', 200))

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

app.post(`/${webhookPath}`, webhookCallback(bot, 'hono', { secretToken: webhookSecret }))

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

const port = Number(process.env.PORT ?? 8787)

export default {
  fetch: app.fetch,
  port,
}
