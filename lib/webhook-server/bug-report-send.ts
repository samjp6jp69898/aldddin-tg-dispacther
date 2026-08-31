/**
 * bug-report-send.ts — 產生 bug-assignee-report 三份品牌 CSV 並送出的共用邏輯。
 *
 * 被兩處呼叫：(1) bug-report-command.ts 的 `/bugreport` 指令（透過 grammy
 * Context 回覆）(2) cron/bug-report-send.ts 的每日排程（透過 bot.api 直接對
 * 固定 chat_id 發送）。兩邊只差「怎麼送出一份文件/一則文字」，產生報表、
 * 品牌拆分、tmp 目錄清理這些邏輯只寫一份，避免兩份實作漂移。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBugAssigneeReportScript } from './run-bug-assignee-report.ts'

const BRANDS = ['FF', '巨星', '未分類'] as const

/** 跟 bug-assignee-report.ts 的 brandOutPath 同一套規則：副檔名前插入品牌後綴。 */
function brandPath(base: string, brand: string): string {
  const dot = base.lastIndexOf('.')
  return dot < 0 ? `${base}-${brand}` : `${base.slice(0, dot)}-${brand}${base.slice(dot)}`
}

export type BugReportRecipient = {
  sendDocument: (path: string, filename: string, caption: string) => Promise<void>
  sendMessage: (text: string) => Promise<void>
}

export async function generateAndSendBugAssigneeReport(recipient: BugReportRecipient): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'tg-bugreport-'))
  try {
    const outBase = join(workDir, 'bug-status-by-assignee.csv')
    const result = runBugAssigneeReportScript(outBase)
    if (!result.success) {
      await recipient.sendMessage(`⚠️ 報表產生失敗：${result.stderr}`)
      return
    }

    const today = new Date().toISOString().slice(0, 10)
    for (const brand of BRANDS) {
      const path = brandPath(outBase, brand)
      if (!existsSync(path)) {
        await recipient.sendMessage(`⚠️ ${brand} CSV 未產生：${path}`)
        continue
      }
      await recipient.sendDocument(path, `bug-status-by-assignee-${brand}.csv`, `Bug 指派人員統計 - ${brand}（${today}）`)
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
