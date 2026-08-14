import { Bot } from 'grammy'

// client.canUseWebhookReply 保持預設 false（不覆寫）。
// 見 tasks.json T2 risk_notes：一旦啟用，hono adapter 會把 grammy 已序列化的
// JSON 字串再丟進 Hono c.json() 造成雙重字串化，回應格式壞掉。

// 只透過 process.env 讀取，值本身來自 /Users/user/aladdin/.env（啟動 wrapper
// script 用 grep '^TG_DISPATCH_BOT_TOKEN=' 匯出，比照 cron/bug-report-run.sh
// 的手法——見 tasks.json T15）。這裡不自己解析 .env，不寫死。
const token = process.env.TG_DISPATCH_BOT_TOKEN
if (!token) {
  throw new Error('TG_DISPATCH_BOT_TOKEN is required (export it from /Users/user/aladdin/.env before starting)')
}

export const bot = new Bot(token)
