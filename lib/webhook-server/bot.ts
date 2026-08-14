import { Bot } from 'grammy'

// client.canUseWebhookReply 保持預設 false（不覆寫）。
// 見 tasks.json T2 risk_notes：一旦啟用，hono adapter 會把 grammy 已序列化的
// JSON 字串再丟進 Hono c.json() 造成雙重字串化，回應格式壞掉。

const token = process.env.TG_DISPATCH_BOT_TOKEN
if (!token) {
  throw new Error('TG_DISPATCH_BOT_TOKEN is required (set in telegram-dispatcher/.env)')
}

export const bot = new Bot(token)
