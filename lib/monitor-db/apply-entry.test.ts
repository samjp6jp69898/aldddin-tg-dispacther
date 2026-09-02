// lib/monitor-db/apply-entry.test.ts — spool 重放分派器路由測試（不打真實 DB）。
import { describe, expect, test } from 'bun:test'
import { applyEntry } from './apply-entry.ts'
import { FakeRunsDb } from './test-support/fake-runs-db.ts'
import { MON_HOST } from './env.ts'

function ident(overrides: Partial<{ runId: string; ticket: string; kind: 'bug' | 'demand' }> = {}) {
  return { runId: 'run-1', ticket: 'FAQ-1', kind: 'bug' as const, ...overrides }
}

describe('applyEntry — 按 fn 路由到 writes.ts 具名函式', () => {
  test('writeRunProgress：INSERT 一筆 queued 列', async () => {
    const db = new FakeRunsDb()
    const r = await applyEntry(db, { fn: 'writeRunProgress', args: [{ ...ident(), lifecycleRank: 10 }] })
    expect(r).toEqual({ ok: true })
    expect(db.rows.get('run-1')!.lifecycle_rank).toBe(10)
  })

  test('writeRunOutcomeAuthoritative：寫入 tier 2 終態', async () => {
    const db = new FakeRunsDb()
    const r = await applyEntry(db, {
      fn: 'writeRunOutcomeAuthoritative',
      args: [{ ...ident(), outcome: 'success', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:00:00.000Z' }],
    })
    expect(r).toEqual({ ok: true })
    expect(db.rows.get('run-1')!.outcome).toBe('success')
  })

  test('writeRunOutcomeProvisional：寫入 tier 1 暫定終態', async () => {
    const db = new FakeRunsDb()
    const r = await applyEntry(db, {
      fn: 'writeRunOutcomeProvisional',
      args: [{ ...ident(), outcome: 'unknown_no_writer', outcomeSource: 'sweeper', finishedAt: '2026-09-02T00:00:00.000Z' }],
    })
    expect(r).toEqual({ ok: true })
    expect(db.rows.get('run-1')!.outcome_tier).toBe(1)
  })

  test('writeCancelFlag：W4a/W4b 落地', async () => {
    const db = new FakeRunsDb()
    const r = await applyEntry(db, {
      fn: 'writeCancelFlag',
      args: [{ ...ident(), cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'marker' }],
    })
    expect(r).toEqual({ ok: true })
    expect(db.rows.get('run-1')!.cancel_requested_at).not.toBeNull()
  })

  test('fixCancelLateOutcome：唯一第二參數是純字串（runId）的具名函式，args[0] 就是它', async () => {
    const db = new FakeRunsDb()
    await applyEntry(db, { fn: 'writeRunProgress', args: [{ ...ident(), lifecycleRank: 30 }] })
    await applyEntry(db, {
      fn: 'writeRunOutcomeAuthoritative',
      args: [{ ...ident(), outcome: 'infra_failure', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:01:00.000Z' }],
    })
    await applyEntry(db, { fn: 'writeCancelFlag', args: [{ ...ident(), cancelRequestedAt: '2026-09-02T00:02:00.000Z', resolvedBy: 'marker' }] })
    const r = await applyEntry(db, { fn: 'fixCancelLateOutcome', args: ['run-1'] })
    expect(r).toEqual({ ok: true })
    expect(db.rows.get('run-1')!.outcome).toBe('cancelled')
  })

  test('未知 fn：不拋例外，回 {ok:false} 附原因', async () => {
    const db = new FakeRunsDb()
    const r = await applyEntry(db, { fn: 'notARealFunction', args: [{}] })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('notARealFunction')
  })

  test('底層寫入函式拋例外時不外洩，包成 {ok:false, reason}', async () => {
    const throwing = { execute: async () => { throw new Error('boom') } }
    const r = await applyEntry(throwing as any, { fn: 'writeRunProgress', args: [{ ...ident(), lifecycleRank: 10 }] })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('boom')
  })

  test('重放冪等：同一條 writeRunOutcomeAuthoritative 條目重放 3 次，結果不變（守衛語意）', async () => {
    const db = new FakeRunsDb()
    const entry = {
      fn: 'writeRunOutcomeAuthoritative',
      args: [{ ...ident(), outcome: 'success', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:00:00.000Z' }],
    }
    for (let i = 0; i < 3; i++) {
      const r = await applyEntry(db, entry)
      expect(r.ok).toBe(true)
    }
    expect(db.rows.get('run-1')!.outcome).toBe('success')
  })
})

describe('applyEntry — MON_HOST 一致性（sanity）', () => {
  test('模組載入不需要真的連 DB（純路由邏輯）', () => {
    expect(typeof MON_HOST).toBe('string')
  })
})
