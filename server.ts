// Telegram dispatcher — webhook server 入口。
// inline keyboard、認領流程等留給後續 task（見 tasks.json）。

import { Hono } from 'hono'
import { webhookCallback } from 'grammy'
import { bot } from './lib/webhook-server/bot.ts'
import { registerHandlers } from './lib/security/whitelist.ts'

registerHandlers(bot)

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
