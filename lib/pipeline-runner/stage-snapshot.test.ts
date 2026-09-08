// lib/pipeline-runner/stage-snapshot.test.ts — computeStageSnapshot 純函式測試
// （pipeline-modes Phase 3）。不碰檔案系統、不碰 DB、不碰 git：三類事實全部
// 由參數餵入，斷言「算出來的 stage 列」與 scripts/resume-inventory.sh 的判定
// 規則一致。
import { describe, expect, test } from 'bun:test'
import { BUG_STAGE_DEBUG_FILES, type LocalStageFiles } from './local-stage-files.ts'
import { computeStageSnapshot, readReviewVerdicts, type ReviewVerdicts, type StageRow } from './stage-snapshot.ts'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const T0 = '2026-09-08T00:00:00.000Z'
const T1 = '2026-09-08T01:00:00.000Z'
const T2 = '2026-09-08T02:00:00.000Z'
const NOW = '2026-09-08T09:00:00.000Z'

/** 全部檔案皆不存在的空盤點；`present` 列出要標成存在的檔名（值＝mtime）。 */
function files(present: Record<string, string> = {}, bootstrapLog: string | null = null): LocalStageFiles {
  const debugFiles: Record<string, string | null> = {}
  for (const f of BUG_STAGE_DEBUG_FILES) debugFiles[f] = present[f] ?? null
  return { debugFiles, worktreeBootstrapLog: bootstrapLog }
}

const NO_VERDICTS: ReviewVerdicts = {
  'reviewer-report.md': 'missing',
  'adversarial-review.md': 'missing',
  'tdd-fidelity-review.md': 'missing',
}

function verdicts(a: 'PASSED' | 'FAILED' | 'missing', b = a, c = a): ReviewVerdicts {
  return { 'reviewer-report.md': a, 'adversarial-review.md': b, 'tdd-fidelity-review.md': c }
}

function byStage(rows: StageRow[]): Record<string, StageRow> {
  return Object.fromEntries(rows.map(r => [r.stage, r]))
}

describe('computeStageSnapshot — 檔案類 stage（同 resume-inventory.sh 的 present/missing）', () => {
  test('完全沒有產物 → 一列都不寫（「查無此列」＝沒做到，不需要 pending 狀態）', () => {
    const rows = computeStageSnapshot(files(), NO_VERDICTS, {}, { mode: 'full', now: NOW })
    expect(rows).toEqual([])
  })

  test('analytics/spec 存在 → 兩列 done，finished_at 取各自的檔案 mtime', () => {
    const rows = computeStageSnapshot(files({ 'analytics.md': T0, 'spec.md': T1 }), NO_VERDICTS, {}, { mode: 'full', now: NOW })
    expect(byStage(rows)).toEqual({
      analytics: { stage: 'analytics', status: 'done', finishedAt: T0 },
      spec: { stage: 'spec', status: 'done', finishedAt: T1 },
    })
  })

  test('六個單檔 stage 逐一對應到 local-stage-files.ts 的檔名', () => {
    const rows = computeStageSnapshot(
      files({
        'analytics.md': T0,
        'spec.md': T0,
        'grounding.md': T0,
        'analysis-notes.md': T0,
        'final-adversarial-review.md': T0,
        'solution.md': T0,
      }),
      NO_VERDICTS,
      {},
      { mode: 'full', now: NOW },
    )
    expect(rows.map(r => r.stage).sort()).toEqual(['analysis-notes', 'analytics', 'final-review', 'grounding', 'solution', 'spec'])
  })
})

describe('computeStageSnapshot — review 三份合成一個 stage', () => {
  test('三份皆 PASSED → done，finished_at 取三份中最新的 mtime', () => {
    const rows = computeStageSnapshot(
      files({ 'reviewer-report.md': T0, 'adversarial-review.md': T2, 'tdd-fidelity-review.md': T1 }),
      verdicts('PASSED'),
      {},
      { mode: 'full', now: NOW },
    )
    expect(byStage(rows).review).toEqual({ stage: 'review', status: 'done', finishedAt: T2 })
  })

  test('任一 FAILED → failed（這一輪被打回，同 resume-inventory 的 step5）', () => {
    const rows = computeStageSnapshot(
      files({ 'reviewer-report.md': T0, 'adversarial-review.md': T0, 'tdd-fidelity-review.md': T0 }),
      verdicts('PASSED', 'FAILED', 'PASSED'),
      {},
      { mode: 'full', now: NOW },
    )
    expect(byStage(rows).review!.status).toBe('failed')
  })

  test('報告不全（無 FAILED）→ 不寫 review 列（同 resume-inventory 的 step6）', () => {
    const rows = computeStageSnapshot(
      files({ 'reviewer-report.md': T0 }),
      verdicts('PASSED', 'missing', 'missing'),
      {},
      { mode: 'full', now: NOW },
    )
    expect(byStage(rows).review).toBeUndefined()
  })
})

describe('computeStageSnapshot — worktree/fixer 由 mr/<ticket> 分支 commit 數判定', () => {
  test('任一 repo commit 數 > 0 → worktree + fixer 皆 done，finished_at 用快照時刻', () => {
    const rows = computeStageSnapshot(files(), NO_VERDICTS, { agrabah: 0, abu: 2, lago: 0, rajah: 0 }, { mode: 'full', now: NOW })
    expect(byStage(rows).worktree).toEqual({ stage: 'worktree', status: 'done', finishedAt: NOW })
    expect(byStage(rows).fixer).toEqual({ stage: 'fixer', status: 'done', finishedAt: NOW })
  })

  test('全部 0（分支存在但沒有領先 commit）→ 不寫這兩列', () => {
    const rows = computeStageSnapshot(files(), NO_VERDICTS, { agrabah: 0, abu: 0, lago: 0, rajah: 0 }, { mode: 'full', now: NOW })
    expect(byStage(rows).worktree).toBeUndefined()
    expect(byStage(rows).fixer).toBeUndefined()
  })
})

describe('computeStageSnapshot — 模式差異（skipped 的唯一來源）', () => {
  for (const mode of ['analysis', 'reanalyze']) {
    test(`${mode} 模式：Step 4~6.5 四個 stage 標成 skipped（與「跑到一半死了」區分得開）`, () => {
      const rows = computeStageSnapshot(files({ 'analysis-notes.md': T1 }), NO_VERDICTS, {}, { mode, now: NOW })
      const m = byStage(rows)
      expect(m['analysis-notes']!.status).toBe('done')
      for (const s of ['worktree', 'fixer', 'review', 'final-review']) {
        expect(m[s]).toEqual({ stage: s, status: 'skipped', finishedAt: NOW })
      }
    })
  }

  test('analysis 模式但檔案真的存在（前一輪 full 留下的）→ 保留 done，不覆蓋成 skipped', () => {
    const rows = computeStageSnapshot(files({ 'final-adversarial-review.md': T1 }), NO_VERDICTS, {}, { mode: 'analysis', now: NOW })
    expect(byStage(rows)['final-review']).toEqual({ stage: 'final-review', status: 'done', finishedAt: T1 })
  })

  test('full / fix 模式不產生任何 skipped 列', () => {
    for (const mode of ['full', 'fix']) {
      const rows = computeStageSnapshot(files(), NO_VERDICTS, {}, { mode, now: NOW })
      expect(rows.filter(r => r.status === 'skipped')).toEqual([])
    }
  })
})

describe('computeStageSnapshot — exit 由呼叫端傳入的 outcome 決定', () => {
  test('沒傳 outcome（onExit 的正常路徑：此刻還不知道分類）→ 不寫 exit 列', () => {
    const rows = computeStageSnapshot(files({ 'analytics.md': T0 }), NO_VERDICTS, {}, { mode: 'full', now: NOW })
    expect(byStage(rows).exit).toBeUndefined()
  })

  test('outcome 對映：success/analysis_done → done、failed/timeout → failed、cancelled → skipped', () => {
    const of = (outcome: string) =>
      byStage(computeStageSnapshot(files(), NO_VERDICTS, {}, { mode: 'full', now: NOW, outcome })).exit!.status
    expect(of('success')).toBe('done')
    expect(of('analysis_done')).toBe('done')
    expect(of('already_fixed')).toBe('done')
    expect(of('failed')).toBe('failed')
    expect(of('timeout')).toBe('failed')
    expect(of('spawn_error')).toBe('failed')
    expect(of('cancelled')).toBe('skipped')
    expect(of('skipped_locked')).toBe('skipped')
  })
})

describe('readReviewVerdicts — 與 resume-inventory.sh 的 verdict() 逐條同義', () => {
  test('取最後一個行首 REVIEW_RESULT；值域外與缺檔皆為 missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-snapshot-'))
    const ticket = 'FAQ-1'
    mkdirSync(join(dir, ticket), { recursive: true })
    // 每輪重寫，最後一個才是最新一輪的結論。
    writeFileSync(join(dir, ticket, `${ticket}-reviewer-report.md`), 'REVIEW_RESULT: FAILED\n...\nREVIEW_RESULT: PASSED\n')
    // 值不在 {PASSED, FAILED} → missing（保守當作沒審過）。
    writeFileSync(join(dir, ticket, `${ticket}-adversarial-review.md`), 'REVIEW_RESULT: MAYBE\n')
    // tdd-fidelity-review.md 刻意不建立 → missing。
    expect(readReviewVerdicts(ticket, dir)).toEqual({
      'reviewer-report.md': 'PASSED',
      'adversarial-review.md': 'missing',
      'tdd-fidelity-review.md': 'missing',
    })
  })

  test('行首以外的 REVIEW_RESULT（引用在句中）不算數', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-snapshot-'))
    const ticket = 'FAQ-2'
    mkdirSync(join(dir, ticket), { recursive: true })
    writeFileSync(join(dir, ticket, `${ticket}-reviewer-report.md`), '報告裡提到 REVIEW_RESULT: PASSED 這一行的格式\n')
    expect(readReviewVerdicts(ticket, dir)['reviewer-report.md']).toBe('missing')
  })
})
