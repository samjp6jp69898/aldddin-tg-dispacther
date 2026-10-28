// changelog-bot.ts — 獨立的 changelog Telegram bot 入口（使用者 2026-10-28 定案：不掛在
// bug_analyst_bot 上）。
//
// 用 long polling（bot.start()）而不是 webhook：不需要 tunnel、setWebhook、webhook
// path/secret，也不經過 server.ts 的全域 rate limit——群組關閉 privacy mode 後會收到
// 所有訊息，跟 bug_analyst_bot 分開程序，群組流量才不會連帶限流到 bug/需求單操作；兩邊
// 互相重啟也不會中斷對方進行中的工作。路由與執行全部在
// lib/webhook-server/changelog-command.ts / changelog-job.ts。
//
// 由 launchd/run-changelog-bot.sh 啟動（com.aladdin.tg-changelog-bot）。
import { Bot } from 'grammy'
import { registerChangelogBotHandlers } from './lib/webhook-server/changelog-command.ts'

const token = process.env.TG_ALADDIN_OPERATION_BOT_TOKEN
if (!token) {
  throw new Error('TG_ALADDIN_OPERATION_BOT_TOKEN is required (export it from telegram-dispatcher/.env before starting)')
}

const bot = new Bot(token)
registerChangelogBotHandlers(bot)
bot.catch(err => console.error(`changelog-bot: handler 例外: ${err.error}`))

await bot.init()
console.error(`changelog-bot: initialized as @${bot.botInfo.username}`)

// 「/」選單只給私訊管理員看（群組用 @bot /changelog，不靠選單）；實際授權在
// registerChangelogBotHandlers，這裡只影響 autocomplete。
const adminChatId = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
if (adminChatId) {
  await bot.api.setMyCommands(
    [{ command: 'changelog', description: '產生 changelog HTML（/changelog <repo> <branch> <tag> ...）' }],
    { scope: { type: 'chat', chat_id: Number(adminChatId) } },
  )
}

await bot.start({ allowed_updates: ['message'] })
