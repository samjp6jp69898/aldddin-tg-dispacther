/**
 * changelog-command.ts — Telegram `/changelog <repo> <branch> <tag> [...]` 指令。
 *
 * 只有 TG_BUG_REPORT_ADMIN_CHAT_ID 能觸發（使用者 2026-10-27 定案沿用 bugreport
 * 管理員；授權判斷在 whitelist.ts 的 isBugReportAdminChat 分支，同一套「非管理員
 * 落到一般用法提示、不洩漏指令存在」原則，見 bug-report-command.ts 檔頭）。
 *
 * 這裡只做三件事：(1) 同步跑純語法檢查（parseTriples，與 resolver 共用同一份
 * 規則），格式錯就立即指出是哪一組 (2) 同一時間只允許一份在跑 (3) 把真正的
 * 執行丟給 changelog-job.ts 背景跑，handler 立即返回。
 */
import type { Context } from 'grammy'
import { parseTriples } from '/Users/user/aladdin/aladdin_ai/skills/changelog-html/resolve-tag-ranges.ts'
import { runChangelogJob } from './changelog-job.ts'

let running = false

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
