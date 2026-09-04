import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUG_STAGE_DEBUG_FILES, readLocalStageFiles } from './local-stage-files.ts'

const DEBUG_DIR = '/Users/user/aladdin/obsidian/Debug'
const WORKTREES_DIR = '/Users/user/aladdin/worktrees'

describe('readLocalStageFiles', () => {
  test('ticket 目錄不存在：全部欄位回 null（不是丟例外）', () => {
    const r = readLocalStageFiles('FAQ-__no-such-ticket-999999__')
    expect(r.worktreeBootstrapLog).toBeNull()
    for (const f of BUG_STAGE_DEBUG_FILES) expect(r.debugFiles[f]).toBeNull()
  })

  test('部分檔案存在：對應欄位回 ISO mtime，其餘仍是 null', () => {
    const ticket = 'FAQ-__unit-test-local-stage-files__'
    const dir = join(DEBUG_DIR, ticket)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ticket}-analytics.md`), '# analytics')
    writeFileSync(join(dir, `${ticket}-solution.md`), '# solution')
    const worktreeDir = join(WORKTREES_DIR, ticket)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'bootstrap.log'), 'ok')
    try {
      const r = readLocalStageFiles(ticket)
      expect(typeof r.debugFiles['analytics.md']).toBe('string')
      expect(typeof r.debugFiles['solution.md']).toBe('string')
      expect(r.debugFiles['spec.md']).toBeNull()
      expect(r.debugFiles['grounding.md']).toBeNull()
      expect(typeof r.worktreeBootstrapLog).toBe('string')
      // 回傳的是合法 ISO 字串（fileMtimeIso 用 .toISOString()）
      expect(() => new Date(r.debugFiles['analytics.md']!).toISOString()).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(worktreeDir, { recursive: true, force: true })
    }
  })

  test('BUG_STAGE_DEBUG_FILES 逐字比照 tg-monitor computeBugStages 讀取的 9 個檔名（改動任一邊都要同步）', () => {
    expect(BUG_STAGE_DEBUG_FILES).toEqual([
      'analytics.md',
      'spec.md',
      'grounding.md',
      'analysis-notes.md',
      'reviewer-report.md',
      'adversarial-review.md',
      'tdd-fidelity-review.md',
      'final-adversarial-review.md',
      'solution.md',
    ])
  })
})
