/**
 * bug-report-command.ts — Telegram `/bugreport` 指令。
 *
 * 只有 TG_BUG_REPORT_ADMIN_CHAT_ID 這一個 chat_id 能觸發（比照 kit-issue.ts
 * 的 isKitAdminChat 手法；呼叫端 whitelist.ts 額外做這道檢查，不是靠
 * Telegram 的「/」選單 scope 隱藏就夠——scope 只影響 autocomplete 顯示，
 * 任何人手動打字仍能送出指令字串）。
 *
 * 實際產生＋送出報表的邏輯在 bug-report-send.ts（跟 cron/bug-report-send.ts
 * 的每日排程共用，見該檔檔頭註解），這裡只負責把 grammy Context 包成
 * BugReportRecipient。
 */
import { InputFile, type Context } from 'grammy'
import { generateAndSendBugAssigneeReport } from './bug-report-send.ts'

/** 只從根目錄 .env 的 TG_BUG_REPORT_ADMIN_CHAT_ID 讀（比照 bot.ts 對 token 的手法），不寫死。 */
export function isBugReportAdminChat(chatId: string): boolean {
  const adminChatId = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
  return !!adminChatId && chatId === adminChatId
}

export async function handleBugReportCommand(ctx: Context): Promise<void> {
  await generateAndSendBugAssigneeReport({
    sendDocument: async (path, filename, caption) => {
      await ctx.replyWithDocument(new InputFile(path, filename), { caption })
    },
    sendMessage: async text => {
      await ctx.reply(text)
    },
  })
}
