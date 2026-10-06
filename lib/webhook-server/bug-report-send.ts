/**
 * bug-report-send.ts — 產生 bug-assignee-report 三份品牌 CSV 並送出的共用邏輯。
 *
 * 被兩處呼叫：(1) bug-report-command.ts 的 `/bugreport` 指令（透過 grammy
 * Context 回覆）(2) cron/bug-report-send.ts 的每日排程（透過 bot.api 直接對
 * 固定 chat_id 發送）。兩邊只差「怎麼送出一份文件/一則文字」，產生報表、
 * 品牌拆分、tmp 目錄清理這些邏輯只寫一份，避免兩份實作漂移。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBugAssigneeReportScript } from './run-bug-assignee-report.ts'

const BRANDS = ['FF', '巨星', '未分類'] as const

/** 跟 bug-assignee-report.ts 的 brandOutPath 同一套規則：副檔名前插入品牌後綴。 */
function brandPath(base: string, brand: string): string {
  const dot = base.lastIndexOf('.')
  return dot < 0 ? `${base}-${brand}` : `${base.slice(0, dot)}-${brand}${base.slice(dot)}`
}

const TG_MESSAGE_LIMIT = 4000 // Telegram 單則上限 4096，留餘裕

/** 依行切段，每段不超過 TG 單則上限，避免 URL 被攔腰截斷。 */
function splitForTelegram(text: string): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > TG_MESSAGE_LIMIT) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n${line}` : line
  }
  if (cur) chunks.push(cur)
  return chunks
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

    // 待整理清單（無名稱／未指派的 Notion URL）；與 bug-assignee-report.ts 同一檔名規則。每個分類分開發一則（過長再拆）
    const todoPath = `${outBase.replace(/\.[^./]+$/, '')}-待整理.json`
    const todo: { label: string; text: string }[] = existsSync(todoPath) ? JSON.parse(readFileSync(todoPath, 'utf-8')) : []
    if (todo.length === 0) {
      await recipient.sendMessage(`✅ 待整理清單（${today}）：無「無名稱」或「未指派」的 bug`)
      return
    }
    for (const { label, text } of todo) {
      const chunks = splitForTelegram(text)
      for (const [i, chunk] of chunks.entries()) {
        const suffix = chunks.length > 1 ? `（${i + 1}/${chunks.length}）` : ''
        await recipient.sendMessage(`📋 ${label}${suffix}｜${today}\n\n${chunk}`)
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
