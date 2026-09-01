#!/usr/bin/env bun
/**
 * cron/bug-report-send.ts — 每日排程入口，由 bug-report-run.sh 呼叫
 * （launchd com.aladdin.bug-report，週一至週五 08:00）。
 *
 * 跟 `/bugreport` 指令（lib/webhook-server/bug-report-command.ts）共用同一套
 * 產生＋送出邏輯（見 lib/webhook-server/bug-report-send.ts 檔頭註解），這裡
 * 只是換一種送出方式：不透過 grammy Context 回覆使用者，而是直接用
 * bot.api 對固定 chat_id（TG_BUG_REPORT_ADMIN_CHAT_ID）發送——沿用既有
 * dispatcher bot（TG_DISPATCH_BOT_TOKEN），不是獨立的 bot/token。
 *
 * 任一步驟失敗（腳本出錯、CSV 為空、Telegram 推送本身失敗）都不能靜默：
 * generateAndSendBugAssigneeReport 內部已經會用 sendMessage 回報前兩種；
 * 這裡額外包一層 try/catch，涵蓋 sendDocument/sendMessage 本身拋錯（網路、
 * Telegram API 錯誤）的情況，再補發一則失敗通知並以非 0 exit code 結束，
 * 讓 launchd 的 log 看得出這次排程失敗。
 */
import { Bot, InputFile } from 'grammy'
import { generateAndSendBugAssigneeReport } from '../lib/webhook-server/bug-report-send.ts'

const botToken = process.env.TG_DISPATCH_BOT_TOKEN
const chatId = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
if (!botToken || !chatId) {
  console.error('TG_DISPATCH_BOT_TOKEN / TG_BUG_REPORT_ADMIN_CHAT_ID is required (export them from telegram-dispatcher/.env before running)')
  process.exit(1)
}

const bot = new Bot(botToken)

try {
  await generateAndSendBugAssigneeReport({
    sendDocument: async (path, filename, caption) => {
      await bot.api.sendDocument(chatId, new InputFile(path, filename), { caption })
    },
    sendMessage: async text => {
      await bot.api.sendMessage(chatId, text)
    },
  })
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`bug-report-send.ts 失敗: ${message}`)
  try {
    await bot.api.sendMessage(chatId, `⚠️ Bug 報表排程失敗：${message}`)
  } catch (notifyErr) {
    console.error(`失敗通知本身也送不出去: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
  }
  process.exit(1)
}
