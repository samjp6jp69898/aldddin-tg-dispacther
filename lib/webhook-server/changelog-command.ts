/**
 * changelog-command.ts — Telegram `/changelog <repo> <branch> <tag> [...]` 指令。
 *
 * 掛在獨立的 changelog bot 上（changelog-bot.ts，long polling；使用者 2026-10-28 定案不用
 * bug_analyst_bot），路由見 registerChangelogBotHandlers。兩個入口：
 * (a) 私訊：只有 TG_BUG_REPORT_ADMIN_CHAT_ID 能觸發（沿用 bugreport 管理員），其他人私訊
 *     一律靜默忽略，不洩漏指令存在
 * (b) 群組：`@本bot /changelog ...`，限後台允許的群組（changelog-group-allowlist.ts），群組內任何人
 *     都可觸發，見 groupChangelogCommand
 * 兩個入口共用同一把 running 鎖。
 *
 * 這裡只做三件事：(1) 同步跑純語法檢查（parseTriples，與 resolver 共用同一份
 * 規則），格式錯就立即指出是哪一組 (2) 同一時間只允許一份在跑 (3) 把真正的
 * 執行丟給 changelog-job.ts 背景跑，handler 立即返回。
 */
import type { Bot, Context } from 'grammy'
import { USAGE, parseTriples } from '/Users/user/aladdin/aladdin_ai/skills/changelog-html/resolve-tag-ranges.ts'
import { runChangelogJob } from './changelog-job.ts'
import { isChangelogGroupChat } from './changelog-group-allowlist.ts'

let running = false

/**
 * 群組訊息：只認「開頭 @本 bot，接著 /changelog ...」（使用者 2026-10-28 定案：一定要 @ 機器人；
 * 群組內任何人都可觸發，權限只靠群組是否在後台允許清單，見 changelog-group-allowlist.ts）。
 * 回傳去掉 @bot 前綴的指令文字，其餘一律回 null——關閉 privacy mode 後 bot 會收到群組所有訊息，
 * 這裡是唯一的過濾點；先比對格式再查允許清單，群組閒聊不會觸發查詢。未允許的群組有人 @ 了 bot
 * 時不回覆，只在 log 記下 chat_id 供到後台設定。
 */
export async function groupChangelogCommand(ctx: Context): Promise<string | null> {
  const m = /^@(\w+)\s+(\/changelog(?:\s[\s\S]*)?)$/i.exec((ctx.message?.text ?? '').trim())
  if (!m || m[1]!.toLowerCase() !== ctx.me.username.toLowerCase()) return null
  const chatId = String(ctx.chat!.id)
  if (!(await isChangelogGroupChat(chatId))) {
    const title = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : ''
    console.error(`changelog: 未允許的群組 @ 了 bot，忽略（chat_id=${chatId} title=${title}）；要開放請到後台加入此群組`)
    return null
  }
  return m[2]!
}

export async function handleChangelogCommand(ctx: Context, rawText: string): Promise<void> {
  const tokens = rawText.trim().split(/\s+/).slice(1)
  const parsed = parseTriples(tokens)
  if (!parsed.ok) {
    await ctx.reply(`❌ 指令格式錯誤：\n${parsed.errors.join('\n')}`)
    return
  }
  if (running) {
    await ctx.reply('已有一份 changelog 正在產生，請等它完成後再送。')
    return
  }
  running = true
  await ctx.reply('收到，正在 fetch 並檢查各 tag 是否在指定分支上…')
  const chatId = ctx.chat!.id
  void runChangelogJob(ctx.api, chatId, tokens)
    .catch(async err => {
      console.error(`changelog job 失敗: ${err}`)
      await ctx.api.sendMessage(chatId, `❌ changelog 執行時發生非預期錯誤：${(err as Error).message}`).catch(() => {})
    })
    .finally(() => {
      running = false
    })
}

/** 私訊 /changelog 的授權：沿用 bugreport 管理員，從 .env 的 TG_BUG_REPORT_ADMIN_CHAT_ID 讀。 */
function isChangelogAdminChat(chatId: string): boolean {
  const adminChatId = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
  return !!adminChatId && chatId === adminChatId
}

export function registerChangelogBotHandlers(bot: Bot): void {
  bot.on('message', async ctx => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const command = await groupChangelogCommand(ctx)
      if (command !== null) await handleChangelogCommand(ctx, command)
      return
    }
    if (ctx.chat.type !== 'private' || !isChangelogAdminChat(String(ctx.chat.id))) return
    const rawText = (ctx.message.text ?? '').trim()
    if (/^\/changelog(\s|$)/i.test(rawText)) await handleChangelogCommand(ctx, rawText)
    else await ctx.reply(USAGE)
  })
}
