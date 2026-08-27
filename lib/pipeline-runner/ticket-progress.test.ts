import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeTicketProgress, isTicketLocked } from './ticket-progress.ts'

const NOW = Date.parse('2026-08-27T12:00:00Z')

function makeLockDir(lockedTickets: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-progress-lock-'))
  for (const ticket of lockedTickets) mkdirSync(join(dir, ticket), { recursive: true })
  return dir
}

function makeDebugDir(ticket: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-progress-debug-'))
  const ticketDir = join(dir, ticket)
  mkdirSync(ticketDir, { recursive: true })
  for (const [name, mtimeIso] of Object.entries(files)) {
    const f = join(ticketDir, name)
    writeFileSync(f, 'x')
    const t = new Date(mtimeIso)
    utimesSync(f, t, t)
  }
  return dir
}

describe('isTicketLocked', () => {
  test('鎖目錄存在 → true', () => {
    const lockDir = makeLockDir(['FAQ-1'])
    expect(isTicketLocked('FAQ-1', { lockDir })).toBe(true)
  })

  test('鎖目錄不存在 → false', () => {
    const lockDir = makeLockDir(['FAQ-1'])
    expect(isTicketLocked('FAQ-2', { lockDir })).toBe(false)
  })
})

describe('describeTicketProgress — Bug 票（FAQ-），比照 pipeline-status.sh 的 Debug 產物 mtime 推論', () => {
  test('Debug 目錄尚未建立 → 回覆「Step1 analyst 進行中或剛開始」，不拋例外', () => {
    const debugDir = mkdtempSync(join(tmpdir(), 'ticket-progress-debug-empty-'))
    const text = describeTicketProgress('FAQ-100', { now: NOW, debugDir, worktreeDir: debugDir })
    expect(text).toContain('Debug 目錄尚未建立')
  })

  test('只有 analytics.md（Step1 完成）→ 目前指向 Step2 spec，附經過分鐘數', () => {
    const debugDir = makeDebugDir('FAQ-101', { 'FAQ-101-analytics.md': '2026-08-27T11:50:00Z' })
    const worktreeDir = mkdtempSync(join(tmpdir(), 'ticket-progress-wt-'))
    const text = describeTicketProgress('FAQ-101', { now: NOW, debugDir, worktreeDir })
    expect(text).toContain('Step1 analyst')
    expect(text).toContain('Step2 spec')
    expect(text).toContain('已 10 分鐘')
    expect(text).toContain('worktree：未建立')
  })

  test('analytics/spec/grounding/analysis-notes 都有 → 最新是 Step3 tracer，指向 Step4/Step5', () => {
    const debugDir = makeDebugDir('FAQ-102', {
      'FAQ-102-analytics.md': '2026-08-27T11:00:00Z',
      'FAQ-102-spec.md': '2026-08-27T11:10:00Z',
      'FAQ-102-grounding.md': '2026-08-27T11:20:00Z',
      'FAQ-102-analysis-notes.md': '2026-08-27T11:30:00Z',
    })
    const worktreeDir = mkdtempSync(join(tmpdir(), 'ticket-progress-wt-'))
    mkdirSync(join(worktreeDir, 'FAQ-102'), { recursive: true })
    const text = describeTicketProgress('FAQ-102', { now: NOW, debugDir, worktreeDir })
    expect(text).toContain('Step3 tracer')
    expect(text).toContain('Step4 worktree ＋ Step5 fixer')
    expect(text).toContain('worktree：已建立 → 已進 Step4+')
  })

  test('超過 45 分鐘沒有新產物 → 附加警示字樣', () => {
    const debugDir = makeDebugDir('FAQ-103', { 'FAQ-103-analytics.md': '2026-08-27T11:00:00Z' }) // 60 分鐘前
    const text = describeTicketProgress('FAQ-103', { now: NOW, debugDir, worktreeDir: debugDir })
    expect(text).toContain('⚠ 超過 45 分鐘無新產物')
  })

  test('含 reviewer 檔案 → 最新 stage 是 Step6 reviewer', () => {
    const debugDir = makeDebugDir('FAQ-104', {
      'FAQ-104-solution.md': '2026-08-27T11:00:00Z',
      'FAQ-104-solution-reviewer.md': '2026-08-27T11:30:00Z',
    })
    const text = describeTicketProgress('FAQ-104', { now: NOW, debugDir, worktreeDir: debugDir })
    expect(text).toContain('Step6 reviewer')
  })
})

describe('describeTicketProgress — 需求單（ALDREQ-），改抓 demand-pipeline.log 最後一行', () => {
  test('log 檔不存在 → 明確回覆查無 log，不拋例外', () => {
    const demandLogPath = join(mkdtempSync(join(tmpdir(), 'ticket-progress-demandlog-')), 'missing.log')
    const planDir = mkdtempSync(join(tmpdir(), 'ticket-progress-plandir-'))
    const text = describeTicketProgress('ALDREQ-200', { now: NOW, demandLogPath, planDir })
    expect(text).toContain('查無 demand-pipeline.log')
  })

  test('log 有其他票的紀錄，但沒有這張單 → 回覆尚無紀錄', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-progress-demandlog-'))
    const demandLogPath = join(dir, 'demand-pipeline.log')
    writeFileSync(demandLogPath, '2026-08-27T11:00:00.000Z ALDREQ-999 plan pipeline：draft 階段開始\n')
    const text = describeTicketProgress('ALDREQ-201', { now: NOW, demandLogPath, planDir: dir })
    expect(text).toContain('尚無這張單的紀錄')
  })

  test('取最後一行、附經過分鐘數', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-progress-demandlog-'))
    const demandLogPath = join(dir, 'demand-pipeline.log')
    writeFileSync(
      demandLogPath,
      [
        '2026-08-27T11:00:00.000Z ALDREQ-202 plan pipeline：draft 階段開始（2 個 agent 平行，目標 repo=agrabah）',
        '2026-08-27T11:10:00.000Z ALDREQ-202 plan pipeline：draft 階段完成',
        '2026-08-27T11:20:00.000Z ALDREQ-202 plan pipeline：review 階段開始（3 個角度平行）',
      ].join('\n') + '\n',
    )
    const text = describeTicketProgress('ALDREQ-202', { now: NOW, demandLogPath, planDir: dir })
    expect(text).toContain('review 階段開始')
    expect(text).not.toContain('draft 階段開始')
    expect(text).toContain('距上次進度更新 40 分鐘')
  })

  test('plan.md 已產出 → 附加「正在收尾」字樣', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-progress-demandlog-'))
    const demandLogPath = join(dir, 'demand-pipeline.log')
    writeFileSync(demandLogPath, '2026-08-27T11:50:00.000Z ALDREQ-203 plan pipeline：分類結果=success\n')
    writeFileSync(join(dir, 'ALDREQ-203-plan.md'), '# plan')
    const text = describeTicketProgress('ALDREQ-203', { now: NOW, demandLogPath, planDir: dir })
    expect(text).toContain('plan.md 已產出，正在收尾')
  })
})
