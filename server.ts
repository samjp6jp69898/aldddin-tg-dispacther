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

// webhook 路徑目前固定 /webhook，T14 會換成隨機不可猜測的 path segment。
app.post(
  '/webhook',
  webhookCallback(bot, 'hono', { secretToken: process.env.TG_WEBHOOK_SECRET }),
)

const port = Number(process.env.PORT ?? 8787)

export default {
  fetch: app.fetch,
  port,
}
