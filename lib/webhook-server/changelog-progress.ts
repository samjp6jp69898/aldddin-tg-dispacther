/**
 * changelog-progress.ts — /changelog 產生中的進度（使用者 2026-10-28 需求：在「開始產生」那則訊息
 * 上以編輯訊息的方式持續更新）。
 *
 * claude -p 是 `--output-format json`，跑完才有輸出，中途沒有串流可讀；但 changelog-html skill 的
 * 「TG tag 模式」每個階段都會在 RUN_DIR 寫固定檔名的產物（見 SKILL.md 該節），這裡純粹以「檔案
 * 是否存在」判斷做到哪一步——確定性訊號，不靠 LLM 自己回報進度。
 *
 * 更新節奏由呼叫端以 setInterval 驅動 reporter.tick()（週期性排程，不涉及正確性）；tick 內容沒變
 * 就不送 edit（Telegram 對相同內容的 edit 會回 400 message is not modified），edit 失敗只記 log。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Api } from 'grammy'

export type ProgressStep = { label: string; done: boolean; count?: { done: number; total: number } }

/**
 * @param repos 有 commit 的 repo（skill 只為它們各派一個提取 agent／影響範圍 worker）
 */
export function computeProgress(runDir: string, repos: string[], outputHtml: string, exists: (p: string) => boolean = existsSync): ProgressStep[] {
  const countOf = (paths: string[]) => ({ done: paths.filter(exists).length, total: paths.length })
  const extract = countOf(repos.map(r => join(runDir, `${r}.md`)))
  const impact = countOf(repos.map(r => join(runDir, 'v2', `impact-${r}-rel.json`)))
  return [
    { label: '提取各 repo 變更', done: extract.done === extract.total, count: extract },
    { label: '解析菜單', done: exists(join(runDir, 'menu-tree.json')) },
    { label: '對應菜單與 commit 審計', done: exists(join(runDir, 'changes.json')) },
    { label: '影響範圍分析', done: impact.done === impact.total, count: impact },
    { label: '轉成業務語言', done: exists(join(runDir, 'v2', 'changes-business.json')) },
    { label: '組裝 HTML', done: exists(outputHtml) },
  ]
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`
}

/** 第一個未完成的步驟標 ⏳，其後標 ⬜；已完成一律 ✅（各階段不保證嚴格依序，例如菜單可能比提取先寫好）。 */
export function renderProgress(header: string, steps: ProgressStep[], elapsedMs: number, footer?: string): string {
  const current = steps.findIndex(s => !s.done)
  const lines = steps.map((s, i) => {
    const icon = s.done ? '✅' : i === current ? '⏳' : '⬜'
    const count = s.count && s.count.total > 1 ? `（${s.count.done}/${s.count.total}）` : ''
    return `${icon} ${i + 1}/${steps.length} ${s.label}${count}`
  })
  return [header, '', footer ?? `進度（已執行 ${formatElapsed(elapsedMs)}）：`, ...lines].join('\n')
}

export type ProgressReporter = {
  /** 重算一次並在內容有變時 edit。永不拋例外。 */
  tick: () => Promise<void>
  /** 以指定 footer（完成／失敗）做最後一次 edit。 */
  finish: (footer: string) => Promise<void>
}

export function createProgressReporter(opts: {
  api: Pick<Api, 'editMessageText'>
  chatId: number
  messageId: number
  header: string
  progress: () => ProgressStep[]
  startedAt: number
  now?: () => number
}): ProgressReporter {
  const now = opts.now ?? (() => Date.now())
  let lastText = ''
  const edit = async (text: string) => {
    if (text === lastText) return
    try {
      await opts.api.editMessageText(opts.chatId, opts.messageId, text)
      lastText = text
    } catch (err) {
      console.error(`changelog: 進度訊息更新失敗（chat=${opts.chatId} msg=${opts.messageId}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    tick: () => edit(renderProgress(opts.header, opts.progress(), now() - opts.startedAt)),
    finish: footer => edit(renderProgress(opts.header, opts.progress(), now() - opts.startedAt, footer)),
  }
}
