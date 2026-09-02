// deploy/monitor-db/backfill/backfill-sqlite.test.ts — Phase 6 sqlite 回填腳本測試。
//
// 不打真實 MySQL：DB 寫入層一律注入假 pool（FakeMonitorPool，依 SQL 形狀模擬
// INSERT IGNORE / INSERT...WHERE NOT EXISTS 的冪等語意，同構於
// lib/monitor-db/test-support/fake-runs-db.ts 的做法）。
// 不打真實 sqlite 正式檔：mapping 測試用純物件；快照/對數測試用 bun:sqlite 在
// tmp 目錄現場建的臨時 fixture db（VACUUM INTO 走真實 snapshotSqlite()）。
// 禁 sleep/計時：全部同步或 await 確定性呼叫。

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'mysql2/promise'
import {
  AGENT_RUNS_DROPPED_COLUMNS,
  BACKFILL_TABLES,
  buildAgentRunMapper,
  ensureConsistentSnapshot,
  mapEventToMcpUsageRow,
  mapPipelineRunToRunsRow,
  mapStatusLogToRow,
  runBackfill,
  SnapshotMismatchError,
  type SqliteAgentRun,
  type SqliteEvent,
  type SqlitePipelineRun,
  type SqliteStatusLog,
} from './backfill-sqlite.ts'
import { compareCounts, snapshotSqlite } from './lib/sqlite-snapshot.ts'

// ─────────────────────────────────────────────────────────────────────────
// 測試 fixture helpers
// ─────────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'backfill-sqlite-test-'))
}

function pipelineRun(overrides: Partial<SqlitePipelineRun> = {}): SqlitePipelineRun {
  return {
    key: 'FAQ-1000.2026-08-25T01-00-00-000Z',
    kind: 'bug',
    ticket: 'FAQ-1000',
    started_at: '2026-08-25T01:00:00.000Z',
    stdout_path: '/logs/FAQ-1000.2026-08-25T01-00-00-000Z.stdout.log',
    stderr_path: null,
    finished_at: '2026-08-25T01:10:00.000Z',
    outcome: 'success',
    cancelled_at: null,
    triggered_by: 'KHH Landon Lo',
    ...overrides,
  }
}

/** 建一個含四張表（＋ file_offsets）的臨時 sqlite fixture db，回傳檔案路徑。 */
function createFixtureDb(dir: string, name = 'source.sqlite'): string {
  const dbPath = path.join(dir, name)
  const db = new Database(dbPath)
  db.run(`PRAGMA journal_mode = WAL`)
  db.run(`CREATE TABLE pipeline_runs (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket TEXT NOT NULL, started_at TEXT NOT NULL,
    stdout_path TEXT, stderr_path TEXT, finished_at TEXT, outcome TEXT,
    cancelled_at TEXT, triggered_by TEXT, review_rounds INTEGER, final_review_rounds INTEGER)`)
  db.run(`CREATE TABLE agent_runs (
    path TEXT PRIMARY KEY, ticket TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_create_tokens INTEGER, cost_usd REAL, num_turns INTEGER,
    tool_calls INTEGER, is_error INTEGER NOT NULL DEFAULT 0, result_preview TEXT, file_mtime TEXT NOT NULL)`)
  db.run(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, ts TEXT NOT NULL, event TEXT NOT NULL,
    identity TEXT, source_ip TEXT, method TEXT, path TEXT, tool TEXT, result TEXT,
    agrabah_identifier TEXT, duration_ms INTEGER, reason TEXT, raw TEXT NOT NULL, UNIQUE(service, raw))`)
  db.run(`CREATE TABLE status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, ts TEXT NOT NULL, status TEXT NOT NULL,
    pid INTEGER, detail TEXT)`)
  db.run(`CREATE TABLE file_offsets (path TEXT PRIMARY KEY, inode INTEGER NOT NULL, offset INTEGER NOT NULL)`)

  db.run(
    `INSERT INTO pipeline_runs (key, kind, ticket, started_at, stdout_path, finished_at, outcome, triggered_by)
     VALUES ('FAQ-1.2026-08-25T01-00-00-000Z','bug','FAQ-1','2026-08-25T01:00:00.000Z',
             '/logs/FAQ-1.2026-08-25T01-00-00-000Z.stdout.log','2026-08-25T01:10:00.000Z','success','洋蔥')`,
  )
  db.run(
    `INSERT INTO agent_runs (path, ticket, kind, stage, started_at, ended_at, file_mtime)
     VALUES ('/logs/FAQ-1.2026-08-25T01-00-00-000Z.stdout.log','FAQ-1','bug','create-mr',
             '2026-08-25T01:00:01.000Z','2026-08-25T01:09:00.000Z','2026-08-25T01:09:00.000Z')`,
  )
  db.run(
    `INSERT INTO events (service, ts, event, identity, source_ip, raw)
     VALUES ('admin-dev','2026-08-25T01:00:00.000Z','request','丁丁','1.2.3.4','{"ts":"x"}')`,
  )
  db.run(`INSERT INTO status_log (service, ts, status, pid, detail) VALUES ('dispatcher','2026-08-25T01:00:00.000Z','up',123,NULL)`)
  db.run(`INSERT INTO file_offsets (path, inode, offset) VALUES ('/some/log','1','0')`)
  db.close()
  return dbPath
}

class FakeMonitorPool {
  calls: Array<{ sql: string; params: unknown[] }> = []
  private seen = new Map<string, Set<string>>()

  async execute(sql: string, params: unknown[] = []): Promise<[{ affectedRows: number }, unknown]> {
    this.calls.push({ sql, params })

    const igMatch = /^INSERT IGNORE INTO (\S+) \(([^)]+)\)/.exec(sql)
    if (igMatch) {
      const table = igMatch[1]!
      const cols = igMatch[2]!.split(',').map((c) => c.trim())
      const keyCols = UNIQUE_KEY_COLUMNS[table]
      if (!keyCols) throw new Error(`FakeMonitorPool: 未知 table 的 unique key：${table}`)
      const keyValues = keyCols.map((kc) => params[cols.indexOf(kc)])
      return this.dedupe(table, keyValues)
    }

    const neMatch = /^INSERT INTO (\S+) \(([^)]+)\) SELECT[\s\S]*WHERE NOT EXISTS/.exec(sql)
    if (neMatch) {
      const table = neMatch[1]!
      const naturalCount = (sql.match(/<=>/g) ?? []).length
      const naturalValues = params.slice(params.length - naturalCount)
      return this.dedupe(table, naturalValues)
    }

    throw new Error(`FakeMonitorPool: 無法辨識的 SQL 形狀：${sql}`)
  }

  private dedupe(table: string, keyValues: unknown[]): [{ affectedRows: number }, unknown] {
    const set = this.seen.get(table) ?? new Set<string>()
    this.seen.set(table, set)
    const key = JSON.stringify(keyValues)
    if (set.has(key)) return [{ affectedRows: 0 }, []]
    set.add(key)
    return [{ affectedRows: 1 }, []]
  }
}

const UNIQUE_KEY_COLUMNS: Record<string, string[]> = {
  runs: ['run_id'],
  agent_runs: ['run_id', 'path'],
  mcp_usage: ['service', 'raw'],
}

// ─────────────────────────────────────────────────────────────────────────
// mapPipelineRunToRunsRow — outcome 全分布 × tier × legacy_outcome_raw
// ─────────────────────────────────────────────────────────────────────────

describe('mapPipelineRunToRunsRow', () => {
  test('success/failed/needs_qa_clarification：原值照存，tier=2，source=backfill，legacy_outcome_raw=null', () => {
    for (const outcome of ['success', 'failed', 'needs_qa_clarification']) {
      const r = mapPipelineRunToRunsRow(pipelineRun({ outcome }))
      expect(r.skip).toBe(false)
      expect(r.row!.outcome).toBe(outcome)
      expect(r.row!.outcome_tier).toBe(2)
      expect(r.row!.outcome_source).toBe('backfill')
      expect(r.row!.legacy_outcome_raw).toBeNull()
    }
  })

  test('recovered：tier=2，source=tracker_reconcile（§11.2 指定）', () => {
    const r = mapPipelineRunToRunsRow(pipelineRun({ outcome: 'recovered' }))
    expect(r.row!.outcome).toBe('recovered')
    expect(r.row!.outcome_tier).toBe(2)
    expect(r.row!.outcome_source).toBe('tracker_reconcile')
  })

  test('unknown_failure：tier=1，source=backfill', () => {
    const r = mapPipelineRunToRunsRow(pipelineRun({ outcome: 'unknown_failure' }))
    expect(r.row!.outcome).toBe('unknown_failure')
    expect(r.row!.outcome_tier).toBe(1)
    expect(r.row!.outcome_source).toBe('backfill')
    expect(r.row!.legacy_outcome_raw).toBeNull()
  })

  test("字面值 'empty' 與空字串 → unknown_failure tier=1，legacy_outcome_raw=原字串", () => {
    for (const outcome of ['empty', '']) {
      const r = mapPipelineRunToRunsRow(pipelineRun({ outcome }))
      expect(r.row!.outcome).toBe('unknown_failure')
      expect(r.row!.outcome_tier).toBe(1)
      expect(r.row!.outcome_source).toBe('backfill')
      expect(r.row!.legacy_outcome_raw).toBe(outcome)
    }
  })

  test('其他未知值（如「已通知 …」）→ legacy_unmapped tier=2，legacy_outcome_raw=原文並截 64 字元', () => {
    const raw = '已通知 pkh_samjp6jp69898@photons.com.tw'
    const r = mapPipelineRunToRunsRow(pipelineRun({ outcome: raw }))
    expect(r.row!.outcome).toBe('legacy_unmapped')
    expect(r.row!.outcome_tier).toBe(2)
    expect(r.row!.outcome_source).toBe('backfill')
    expect(r.row!.legacy_outcome_raw).toBe(raw)

    const long = 'x'.repeat(100)
    const r2 = mapPipelineRunToRunsRow(pipelineRun({ outcome: long }))
    expect(r2.row!.legacy_outcome_raw).toBe('x'.repeat(64))
    expect(r2.row!.legacy_outcome_raw!.length).toBe(64)
  })

  test('outcome=timeout：finished_at 重算為 started_at+7200s（不是 10800），不採原值', () => {
    const r = mapPipelineRunToRunsRow(
      pipelineRun({ outcome: 'timeout', started_at: '2026-08-25T10:15:06.779Z', finished_at: '2026-08-25T11:45:06.779Z' }),
    )
    expect(r.row!.outcome).toBe('timeout')
    expect(r.row!.outcome_tier).toBe(2)
    expect(r.row!.finished_at).toBe('2026-08-25 12:15:06.779')
    expect(r.timeoutRecompute).toBeDefined()
    expect(r.timeoutRecompute!.diffSeconds).toBe(1800) // 12:15 - 11:45 = 30min = 1800s
  })

  test('outcome IS NULL 且 finished_at 非 NULL → unknown_failure tier=1 並附 note', () => {
    const r = mapPipelineRunToRunsRow(pipelineRun({ outcome: null, finished_at: '2026-08-25T01:10:00.000Z' }))
    expect(r.skip).toBe(false)
    expect(r.row!.outcome).toBe('unknown_failure')
    expect(r.row!.outcome_tier).toBe(1)
    expect(r.note).toBeTruthy()
  })

  test('outcome IS NULL 且 finished_at IS NULL → skip', () => {
    const r = mapPipelineRunToRunsRow(pipelineRun({ outcome: null, finished_at: null }))
    expect(r.skip).toBe(true)
    expect(r.skipReason).toBeTruthy()
    expect(r.row).toBeUndefined()
  })

  test('run_id 派生穩定性：同一 key 兩次呼叫得到相同 run_id', () => {
    const row = pipelineRun({ key: 'FAQ-9999.2026-08-25T01-00-00-000Z' })
    const r1 = mapPipelineRunToRunsRow(row)
    const r2 = mapPipelineRunToRunsRow(row)
    expect(r1.row!.run_id).toBe(r2.row!.run_id)
    expect(r1.row!.run_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('cancelled_at/triggered_by/legacy_key/host 直接映射', () => {
    const r = mapPipelineRunToRunsRow(
      pipelineRun({ key: 'FAQ-2.2026-08-25T01-00-00-000Z', cancelled_at: '2026-08-25T01:05:00.000Z', triggered_by: 'KHH Landon Lo' }),
    )
    expect(r.row!.legacy_key).toBe('FAQ-2.2026-08-25T01-00-00-000Z')
    expect(r.row!.cancel_requested_at).toBe('2026-08-25 01:05:00.000')
    expect(r.row!.triggered_by_email).toBe('KHH Landon Lo')
    expect(r.row!.host).toBe('unknown_pre_migration')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// agent_runs 對位（bug / demand 兩種、對不到的 skip）
// ─────────────────────────────────────────────────────────────────────────

describe('buildAgentRunMapper', () => {
  const bugRun = pipelineRun({
    key: 'FAQ-1.2026-08-25T01-00-00-000Z',
    ticket: 'FAQ-1',
    kind: 'bug',
    stdout_path: '/logs/FAQ-1.2026-08-25T01-00-00-000Z.stdout.log',
  })
  const demandEarly = pipelineRun({
    key: 'ALDREQ-1.2026-08-20T00-00-00-000Z',
    ticket: 'ALDREQ-1',
    kind: 'demand',
    started_at: '2026-08-20T00:00:00.000Z',
    stdout_path: null,
  })
  const demandLate = pipelineRun({
    key: 'ALDREQ-1.2026-08-21T00-00-00-000Z',
    ticket: 'ALDREQ-1',
    kind: 'demand',
    started_at: '2026-08-21T00:00:00.000Z',
    stdout_path: null,
  })

  function agentRun(overrides: Partial<SqliteAgentRun> = {}): SqliteAgentRun {
    return {
      path: '/logs/agent-traces/ALDREQ-1/2026-08-21T05-00-00-000Z-repo-scope.json',
      ticket: 'ALDREQ-1',
      kind: 'demand',
      stage: 'repo-scope',
      started_at: '2026-08-21T05:00:00.000Z',
      ended_at: '2026-08-21T05:01:00.000Z',
      ...overrides,
    }
  }

  test('kind=bug：path 對 stdout_path 等值找到 → run_id 對應該筆 pipeline_runs', () => {
    const map = buildAgentRunMapper([bugRun, demandEarly, demandLate])
    const r = map(agentRun({ path: bugRun.stdout_path!, ticket: 'FAQ-1', kind: 'bug', stage: 'create-mr' }))
    expect(r.skip).toBe(false)
    expect(r.row!.agent_name).toBe('create-mr')
    expect(r.row!.host).toBe('unknown_pre_migration')
    const direct = mapPipelineRunToRunsRow(bugRun)
    expect(r.row!.run_id).toBe(direct.row!.run_id)
  })

  test('kind=bug：path 對不到任何 stdout_path → skip', () => {
    const map = buildAgentRunMapper([bugRun])
    const r = map(agentRun({ path: '/logs/does-not-exist.stdout.log', kind: 'bug', ticket: 'FAQ-1' }))
    expect(r.skip).toBe(true)
    expect(r.skipReason).toBeTruthy()
  })

  test('kind=demand：取同 ticket、started_at ≤ agent.started_at 中最大者', () => {
    const map = buildAgentRunMapper([bugRun, demandEarly, demandLate])
    // agent started_at 在 demandLate 之後 → 應選 demandLate（較晚但仍 ≤ agent）
    const r = map(agentRun({ started_at: '2026-08-22T00:00:00.000Z' }))
    expect(r.skip).toBe(false)
    const expectDirect = mapPipelineRunToRunsRow(demandLate)
    expect(r.row!.run_id).toBe(expectDirect.row!.run_id)
  })

  test('kind=demand：agent.started_at 早於所有同 ticket pipeline_runs → skip', () => {
    const map = buildAgentRunMapper([demandEarly, demandLate])
    const r = map(agentRun({ started_at: '2026-08-19T00:00:00.000Z' }))
    expect(r.skip).toBe(true)
  })

  test('kind=demand：ticket 完全無對應 pipeline_runs → skip', () => {
    const map = buildAgentRunMapper([bugRun])
    const r = map(agentRun({ ticket: 'ALDREQ-999' }))
    expect(r.skip).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// events / status_log 純映射
// ─────────────────────────────────────────────────────────────────────────

describe('mapEventToMcpUsageRow / mapStatusLogToRow', () => {
  test('event 五欄直接映射，ts 轉 DATETIME(3)', () => {
    const e: SqliteEvent = { service: 'admin-dev', ts: '2026-08-20T09:18:35.778Z', identity: '丁丁', source_ip: '1.2.3.4', raw: '{"a":1}' }
    const row = mapEventToMcpUsageRow(e)
    expect(row).toEqual({ service: 'admin-dev', identity: '丁丁', source_ip: '1.2.3.4', raw: '{"a":1}', ts: '2026-08-20 09:18:35.778' })
  })

  test('status_log：pid/detail 皆有值 → detail_json 為 JSON', () => {
    const s: SqliteStatusLog = { service: 'ngrok', ts: '2026-08-21T01:57:59.751Z', status: 'up', pid: 27834, detail: 'https://x' }
    const row = mapStatusLogToRow(s)
    expect(row.host).toBe('unknown_pre_migration')
    expect(row.detail_json).toBe(JSON.stringify({ pid: 27834, detail: 'https://x' }))
  })

  test('status_log：pid 與 detail 皆 NULL → detail_json 為 NULL', () => {
    const s: SqliteStatusLog = { service: 'toolsmith', ts: '2026-08-21T01:57:59.745Z', status: 'up', pid: null, detail: null }
    const row = mapStatusLogToRow(s)
    expect(row.detail_json).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 快照對數：一致 → 回傳路徑；不一致（重試一次仍不一致）→ 丟 SnapshotMismatchError
// ─────────────────────────────────────────────────────────────────────────

describe('ensureConsistentSnapshot', () => {
  test('對數一致：只呼叫一次 snapshot，回傳快照路徑', () => {
    let snapshotCalls = 0
    const path_ = ensureConsistentSnapshot('/fake/src.sqlite', '/fake/workdir', BACKFILL_TABLES, {
      snapshot: () => {
        snapshotCalls++
      },
      compare: () => BACKFILL_TABLES.map((t) => ({ table: t, live: 1, snapshot: 1, ok: true })),
    })
    expect(snapshotCalls).toBe(1)
    expect(path_).toContain('workdir')
  })

  test('對數不一致：重試一次仍不一致 → 丟 SnapshotMismatchError，snapshot 呼叫 2 次', () => {
    let snapshotCalls = 0
    expect(() =>
      ensureConsistentSnapshot('/fake/src.sqlite', '/fake/workdir', BACKFILL_TABLES, {
        snapshot: () => {
          snapshotCalls++
        },
        compare: () => BACKFILL_TABLES.map((t) => ({ table: t, live: 2, snapshot: 1, ok: false })),
      }),
    ).toThrow(SnapshotMismatchError)
    expect(snapshotCalls).toBe(2)
  })

  test('第一次不一致、重試後一致 → 不丟例外，回傳路徑', () => {
    let compareCalls = 0
    const path_ = ensureConsistentSnapshot('/fake/src.sqlite', '/fake/workdir', BACKFILL_TABLES, {
      snapshot: () => {},
      compare: () => {
        compareCalls++
        const ok = compareCalls >= 2
        return BACKFILL_TABLES.map((t) => ({ table: t, live: 1, snapshot: ok ? 1 : 0, ok }))
      },
    })
    expect(compareCalls).toBe(2)
    expect(path_).toBeTruthy()
  })

  test('對真實 sqlite fixture：VACUUM INTO 快照與正式檔逐表 row count 一致', () => {
    const dir = tmpDir()
    try {
      const srcPath = createFixtureDb(dir)
      const snapshotPath = ensureConsistentSnapshot(srcPath, dir, BACKFILL_TABLES)
      const checks = compareCounts(srcPath, snapshotPath, [...BACKFILL_TABLES])
      expect(checks.every((c) => c.ok)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// runBackfill：dry-run（不寫入）、以及注入假 pool 的冪等寫入（重跑第二次全 ignored）
// ─────────────────────────────────────────────────────────────────────────

describe('runBackfill', () => {
  async function withFixture<T>(fn: (dbPath: string, dir: string) => Promise<T>): Promise<T> {
    const dir = tmpDir()
    try {
      const dbPath = createFixtureDb(dir)
      return await fn(dbPath, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('dry-run：不寫入（inserted/ignored 恆 0），attempted 反映實際會寫入的列數，四個來源都有報告', async () => {
    await withFixture(async (dbPath) => {
      const reports = await runBackfill({ snapshotPath: dbPath, dryRun: true })
      expect(reports).toHaveLength(4)
      for (const r of reports) {
        expect(r.dryRun).toBe(true)
        expect(r.inserted).toBe(0)
        expect(r.ignored).toBe(0)
      }
      const runsReport = reports.find((r) => r.source.includes('runs'))!
      expect(runsReport.sourceRows).toBe(1)
      expect(runsReport.attempted).toBe(1)
      const agentRunsReport = reports.find((r) => r.source.includes('agent_runs'))!
      expect(agentRunsReport.notes.some((n) => n.includes('schema 無對應欄位'))).toBe(true)
      expect(agentRunsReport.notes.some((n) => AGENT_RUNS_DROPPED_COLUMNS.every((c) => n.includes(c)))).toBe(true)
    })
  })

  test('dryRun=false 且未提供 pool → 丟錯（不允許意外寫入）', async () => {
    await withFixture(async (dbPath) => {
      await expect(runBackfill({ snapshotPath: dbPath, dryRun: false })).rejects.toThrow()
    })
  })

  test('冪等：以假 pool 寫入兩次，第二次全部 ignored（inserted=0），SQL 為 INSERT IGNORE / WHERE NOT EXISTS 形狀', async () => {
    await withFixture(async (dbPath) => {
      const fake = new FakeMonitorPool()
      const pool = fake as unknown as Pool

      const first = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })
      for (const r of first) {
        expect(r.inserted).toBe(r.attempted)
        expect(r.ignored).toBe(0)
      }

      const second = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })
      for (const r of second) {
        expect(r.inserted).toBe(0)
        expect(r.ignored).toBe(r.attempted)
      }

      const statusLogCalls = fake.calls.filter((c) => c.sql.includes('service_status_log'))
      expect(statusLogCalls.length).toBeGreaterThan(0)
      for (const c of statusLogCalls) {
        expect(c.sql).toMatch(/^INSERT INTO service_status_log \(/)
        expect(c.sql).toContain('WHERE NOT EXISTS')
        expect(c.sql).toContain('service <=> ?')
        expect(c.sql).toContain('ts <=> ?')
        expect(c.sql).toContain('status <=> ?')
      }

      const runsCalls = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO runs'))
      expect(runsCalls.length).toBeGreaterThan(0)

      const mcpUsageCalls = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO mcp_usage'))
      expect(mcpUsageCalls.length).toBeGreaterThan(0)

      const agentRunsCalls = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO agent_runs'))
      expect(agentRunsCalls.length).toBeGreaterThan(0)
    })
  })
})
