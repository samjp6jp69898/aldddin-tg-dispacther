// Telegram dispatcher — webhook server 入口。
// T1（本檔）只建立骨架：Hono app + placeholder 200 response。
// grammy bot 掛載、webhookCallback 路由、白名單等留給後續 task（見 tasks.json）。

import { Hono } from 'hono'

const app = new Hono()

app.get('/', c => c.text('telegram-dispatcher: placeholder ok', 200))

const port = Number(process.env.PORT ?? 8787)

export default {
  fetch: app.fetch,
  port,
}
