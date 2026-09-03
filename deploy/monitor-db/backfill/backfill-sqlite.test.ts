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
import { deriveRunId } from './lib/run-id.ts'
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
    review_rounds: null,
    final_review_rounds: null,
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
    `INSERT INTO pipeline_runs
       (key, kind, ticket, started_at, stdout_path, stderr_path, finished_at, outcome, triggered_by,
        review_rounds, final_review_rounds)
     VALUES ('FAQ-1.2026-08-25T01-00-00-000Z','bug','FAQ-1','2026-08-25T01:00:00.000Z',
             '/logs/FAQ-1.2026-08-25T01-00-00-000Z.stdout.log',
             '/logs/FAQ-1.2026-08-25T01-00-00-000Z.stderr.log',
             '2026-08-25T01:10:00.000Z','success','洋蔥',2,3)`,
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

// ─────────────────────────────────────────────────────────────────────────
// 既存防撞守衛（guard）測試專用最小 fixture——內容由呼叫端逐案指定，
// 三案（有重疊 / 無重疊 / 級聯）彼此不共用同一份資料，符合 D14 一次一個故障。
// ─────────────────────────────────────────────────────────────────────────

interface GuardPipelineRun {
  key: string
  ticket: string
  stdoutPath: string | null
  /** 預設 'success'；傳 null 模擬「仍在跑」（需同時傳 finishedAt: null）。 */
  outcome?: string | null
  /** 預設 '2026-08-25T01:10:00.000Z'；傳 null 模擬「仍在跑」（需同時傳 outcome: null）。 */
  finishedAt?: string | null
}

interface GuardAgentRun {
  path: string
  ticket: string
  startedAt: string
  endedAt: string | null
}

function createGuardFixtureDb(dir: string, pipelineRuns: GuardPipelineRun[], agentRuns: GuardAgentRun[] = []): string {
  const dbPath = path.join(dir, 'source.sqlite')
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

  const insertRun = db.query(
    `INSERT INTO pipeline_runs (key, kind, ticket, started_at, stdout_path, finished_at, outcome, triggered_by)
     VALUES (?, 'bug', ?, '2026-08-25T01:00:00.000Z', ?, ?, ?, NULL)`,
  )
  for (const pr of pipelineRuns) {
    const finishedAt = pr.finishedAt === undefined ? '2026-08-25T01:10:00.000Z' : pr.finishedAt
    const outcome = pr.outcome === undefined ? 'success' : pr.outcome
    insertRun.run(pr.key, pr.ticket, pr.stdoutPath, finishedAt, outcome)
  }

  const insertAgent = db.query(
    `INSERT INTO agent_runs (path, ticket, kind, stage, started_at, ended_at, file_mtime)
     VALUES (?, ?, 'bug', 'create-mr', ?, ?, ?)`,
  )
  for (const ar of agentRuns) insertAgent.run(ar.path, ar.ticket, ar.startedAt, ar.endedAt, ar.startedAt)

  db.close()
  return dbPath
}

class FakeMonitorPool {
  calls: Array<{ sql: string; params: unknown[] }> = []
  private seen = new Map<string, Set<string>>()
  /**
   * `runs.legacy_key → run_id` 的目前狀態，供既存防撞守衛的唯讀查詢使用。
   * 建構時可預先塞入「模擬 live 路徑已經寫過的列」（legacyKey/runId 不等於
   * deriveRunId(legacyKey)）；`execute()` 每次真的成功 INSERT IGNORE INTO runs
   * 時也會把 (legacy_key, run_id) 併進來——這樣同一個 pool 實例在第二次
   * runBackfill() 呼叫時，query() 能如實反映「第一輪回填自己寫過的列」，
   * 才能測「重跑冪等」情境（不需要額外手動配置）。
   */
  private legacyKeyToRunId = new Map<string, string>()

  constructor(preExistingRuns: Array<{ legacyKey: string; runId: string }> = []) {
    for (const r of preExistingRuns) this.legacyKeyToRunId.set(r.legacyKey, r.runId)
  }

  async query(sql: string, params: unknown[] = []): Promise<[Array<{ legacy_key: string; run_id: string }>, unknown]> {
    this.calls.push({ sql, params })
    if (/^SELECT legacy_key, run_id FROM runs WHERE legacy_key IS NOT NULL$/.test(sql.trim())) {
      return [[...this.legacyKeyToRunId.entries()].map(([legacy_key, run_id]) => ({ legacy_key, run_id })), []]
    }
    throw new Error(`FakeMonitorPool.query: 無法辨識的 SQL 形狀：${sql}`)
  }

  async execute(sql: string, params: unknown[] = []): Promise<[{ affectedRows: number }, unknown]> {
    this.calls.push({ sql, params })

    const igMatch = /^INSERT IGNORE INTO (\S+) \(([^)]+)\)/.exec(sql)
    if (igMatch) {
      const table = igMatch[1]!
      const cols = igMatch[2]!.split(',').map((c) => c.trim())
      const keyCols = UNIQUE_KEY_COLUMNS[table]
      if (!keyCols) throw new Error(`FakeMonitorPool: 未知 table 的 unique key：${table}`)
      const keyValues = keyCols.map((kc) => params[cols.indexOf(kc)])
      const result = this.dedupe(table, keyValues)
      if (table === 'runs' && result[0].affectedRows >= 1) {
        const runIdIdx = cols.indexOf('run_id')
        const legacyKeyIdx = cols.indexOf('legacy_key')
        const runId = runIdIdx >= 0 ? (params[runIdIdx] as string) : undefined
        const legacyKey = legacyKeyIdx >= 0 ? (params[legacyKeyIdx] as string | null) : undefined
        if (runId !== undefined && legacyKey) this.legacyKeyToRunId.set(legacyKey, runId)
      }
      return result
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

  test('stderr_path/review_rounds/final_review_rounds：來源有值 → 直接映射（migration 004 補欄）', () => {
    const r = mapPipelineRunToRunsRow(
      pipelineRun({ stderr_path: '/logs/FAQ-2.2026-08-25T01-00-00-000Z.stderr.log', review_rounds: 2, final_review_rounds: 3 }),
    )
    expect(r.row!.stderr_path).toBe('/logs/FAQ-2.2026-08-25T01-00-00-000Z.stderr.log')
    expect(r.row!.review_rounds).toBe(2)
    expect(r.row!.final_review_rounds).toBe(3)
  })

  test('stderr_path/review_rounds/final_review_rounds：來源缺值 → NULL，不造數', () => {
    const r = mapPipelineRunToRunsRow(pipelineRun({ stderr_path: null, review_rounds: null, final_review_rounds: null }))
    expect(r.row!.stderr_path).toBeNull()
    expect(r.row!.review_rounds).toBeNull()
    expect(r.row!.final_review_rounds).toBeNull()
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

// ─────────────────────────────────────────────────────────────────────────
// 既存防撞守衛（總指揮裁定新增）：live 路徑用 randomUUID 鑄 run_id、回填路徑用
// deriveRunId(legacy_key) 導出 run_id——雙軌重疊的同一支歷史 run 因 run_id 不同，
// INSERT IGNORE 偵測不到重複，會被插成兩列且零警告（實測重疊：FAQ-4771/FAQ-4855）。
// 三案分開、互不共用 fixture（D14 一次一個故障）。
// ─────────────────────────────────────────────────────────────────────────

describe('既存防撞守衛（runs.legacy_key 命中 mysql 既有集合 → skip，並級聯 agent_runs）', () => {
  test('(a) 有重疊：sqlite key 命中 mysql runs.legacy_key → 該列 skip，統計數字正確、且完全不進寫入層', async () => {
    const dir = tmpDir()
    try {
      const overlapKey = 'FAQ-4771.2026-08-20T00-00-00-000Z'
      const dbPath = createGuardFixtureDb(dir, [{ key: overlapKey, ticket: 'FAQ-4771', stdoutPath: '/logs/FAQ-4771.stdout.log' }])
      // run_id 刻意跟 deriveRunId(overlapKey) 不同——代表 live 路徑用 randomUUID() 鑄的另一支列，真衝突。
      const fake = new FakeMonitorPool([{ legacyKey: overlapKey, runId: '11111111-1111-5111-8111-111111111111' }])
      const pool = fake as unknown as Pool

      const [runsReport] = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })

      expect(runsReport.sourceRows).toBe(1)
      expect(runsReport.skipped).toBe(1)
      expect(runsReport.attempted).toBe(0)
      expect(runsReport.inserted).toBe(0)
      expect(runsReport.notes).toContain(`已存在於 mysql（live 寫入）：key=${overlapKey}`)
      expect(runsReport.notes.some((n) => n.includes('既存防撞守衛：略過 1 列'))).toBe(true)

      const runsInsertCalls = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO runs'))
      expect(runsInsertCalls.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('(b) 無重疊：零誤 skip，行為與現行完全相同（正常映射、正常寫入）', async () => {
    const dir = tmpDir()
    try {
      const key = 'FAQ-9001.2026-08-21T00-00-00-000Z'
      const dbPath = createGuardFixtureDb(dir, [{ key, ticket: 'FAQ-9001', stdoutPath: '/logs/FAQ-9001.stdout.log' }])
      // 既存集合裡有值，但與這列的 key 完全不重疊。
      const fake = new FakeMonitorPool([{ legacyKey: 'FAQ-0000.2026-01-01T00-00-00-000Z', runId: '22222222-2222-5222-8222-222222222222' }])
      const pool = fake as unknown as Pool

      const [runsReport] = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })

      expect(runsReport.sourceRows).toBe(1)
      expect(runsReport.skipped).toBe(0)
      expect(runsReport.attempted).toBe(1)
      expect(runsReport.inserted).toBe(1)
      // a7-D42：實測 0 要明講是實測值，不是沉默、更不是未評估。
      expect(runsReport.notes.some((n) => n.includes('既存防撞守衛：略過 0 列') && n.includes('此數字為實測值'))).toBe(true)
      expect(runsReport.notes.some((n) => n.includes('未評估'))).toBe(false)

      const runsInsertCalls = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO runs'))
      expect(runsInsertCalls.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('(d) a7-D42：無 pool（--dry-run 不連 MySQL）→ 守衛印「未評估」，不得印成 0', async () => {
    const dir = tmpDir()
    try {
      const key = 'FAQ-9002.2026-08-22T00-00-00-000Z'
      const dbPath = createGuardFixtureDb(dir, [{ key, ticket: 'FAQ-9002', stdoutPath: '/logs/FAQ-9002.stdout.log' }])

      const [runsReport] = await runBackfill({ snapshotPath: dbPath, dryRun: true }, { pool: undefined })

      // 未評估 ≠ 實測 0：必須有「未評估」字樣與「僅真跑時可得」警語，且不得出現「略過 N 列」的實測措辭。
      expect(runsReport.notes.some((n) => n.includes('既存防撞守衛：未評估') && n.includes('僅真跑時可得'))).toBe(true)
      expect(runsReport.notes.some((n) => n.includes('既存防撞守衛：略過'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('(c) 級聯 skip：重疊 run 帶 agent_runs → agent_runs 也被跳過，且無孤兒列（寫入的 agent_runs 全部能 join 回寫入的 runs）', async () => {
    const dir = tmpDir()
    try {
      const overlapKey = 'FAQ-4855.2026-08-22T00-00-00-000Z'
      const cleanKey = 'FAQ-4856.2026-08-22T01-00-00-000Z'
      const dbPath = createGuardFixtureDb(
        dir,
        [
          { key: overlapKey, ticket: 'FAQ-4855', stdoutPath: '/logs/FAQ-4855.stdout.log' },
          { key: cleanKey, ticket: 'FAQ-4856', stdoutPath: '/logs/FAQ-4856.stdout.log' },
        ],
        [
          { path: '/logs/FAQ-4855.stdout.log', ticket: 'FAQ-4855', startedAt: '2026-08-22T00:00:01.000Z', endedAt: '2026-08-22T00:09:00.000Z' },
          { path: '/logs/FAQ-4856.stdout.log', ticket: 'FAQ-4856', startedAt: '2026-08-22T01:00:01.000Z', endedAt: '2026-08-22T01:09:00.000Z' },
        ],
      )
      // run_id 刻意跟 deriveRunId(overlapKey) 不同——代表 live 路徑用 randomUUID() 鑄的另一支列，真衝突。
      const fake = new FakeMonitorPool([{ legacyKey: overlapKey, runId: '33333333-3333-5333-8333-333333333333' }])
      const pool = fake as unknown as Pool

      const [runsReport, agentRunsReport] = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })

      // run 層：重疊列被跳過，未重疊列正常寫入。
      expect(runsReport.skipped).toBe(1)
      expect(runsReport.attempted).toBe(1)
      expect(runsReport.inserted).toBe(1)

      // agent_runs 層：重疊 run 對應的 agent_run 被級聯跳過（統一機制，skipReason 附上歸因），未重疊的正常寫入。
      expect(agentRunsReport.sourceRows).toBe(2)
      expect(agentRunsReport.skipped).toBe(1)
      expect(agentRunsReport.attempted).toBe(1)
      expect(agentRunsReport.inserted).toBe(1)
      expect(
        agentRunsReport.notes.some(
          (n) => n.includes('agent_run 級聯跳過') && n.includes('已存在於 mysql（live 寫入）') && n.includes(overlapKey),
        ),
      ).toBe(true)
      expect(agentRunsReport.notes.some((n) => n.includes('parent run 不在 target，級聯略過 1 列 agent_runs'))).toBe(true)

      // 驗收斷言：無孤兒列——實際寫入的 agent_runs.run_id 必須全部屬於實際寫入的 runs.run_id 集合。
      const insertedRunIds = new Set(
        fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO runs')).map((c) => c.params[0] as string),
      )
      const insertedAgentRunIds = fake.calls
        .filter((c) => c.sql.startsWith('INSERT IGNORE INTO agent_runs'))
        .map((c) => c.params[0] as string)

      expect(insertedAgentRunIds.length).toBe(1)
      for (const runId of insertedAgentRunIds) {
        expect(insertedRunIds.has(runId)).toBe(true)
      }
      // 且被守衛跳過的 run 的 run_id（其 agent_run 若誤寫入即為孤兒）完全沒有出現在寫入的 agent_runs 裡。
      const skippedRunId = deriveRunId(overlapKey)
      expect(insertedAgentRunIds).not.toContain(skippedRunId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 統一級聯機制的姊妹缺口修復（總指揮 2026-09-03 真 DB 全鏈路實測回報）：
// 舊版級聯只認 guardSkippedKeys，「仍在跑」（outcome/finished_at 皆 NULL）等
// mapPipelineRunToRunsRow 自身語意 skip 沒有被級聯，臨時 schema 實測出 4 筆
// 孤兒 agent_runs（run_id＝被 skip 的 still-running pipeline runs 的導出 UUID）。
// 現改為以 presentKeys（統一「target 中該 key 是否實際存在」判準）驅動級聯，
// 一個機制蓋掉所有「parent 不在 target」情形。與既存防撞守衛案分開（D14）。
// ─────────────────────────────────────────────────────────────────────────

describe('統一級聯機制：parent 不在 target 一律 skip agent_runs（不限於既存防撞守衛）', () => {
  test('仍在跑（outcome 與 finished_at 皆 NULL）的 pipeline_run 帶 agent_run → 級聯 skip，無孤兒列', async () => {
    const dir = tmpDir()
    try {
      const stillRunningKey = 'FAQ-5001.2026-08-23T00-00-00-000Z'
      const dbPath = createGuardFixtureDb(
        dir,
        [{ key: stillRunningKey, ticket: 'FAQ-5001', stdoutPath: '/logs/FAQ-5001.stdout.log', outcome: null, finishedAt: null }],
        [{ path: '/logs/FAQ-5001.stdout.log', ticket: 'FAQ-5001', startedAt: '2026-08-23T00:00:01.000Z', endedAt: '2026-08-23T00:09:00.000Z' }],
      )
      const fake = new FakeMonitorPool() // 無既存防撞守衛干擾，純粹測「仍在跑」這條路徑
      const pool = fake as unknown as Pool

      const [runsReport, agentRunsReport] = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })

      // run 層：仍在跑 → skip（既有語意，這裡只是前提條件，不是本次修的內容）。
      expect(runsReport.skipped).toBe(1)
      expect(runsReport.attempted).toBe(0)

      // agent_runs 層（本次修的姊妹缺口）：對應的 agent_run 必須被級聯 skip，不能誤寫成孤兒列。
      expect(agentRunsReport.sourceRows).toBe(1)
      expect(agentRunsReport.skipped).toBe(1)
      expect(agentRunsReport.attempted).toBe(0)
      expect(agentRunsReport.inserted).toBe(0)
      expect(agentRunsReport.notes.some((n) => n.includes('agent_run 級聯跳過') && n.includes('仍在跑'))).toBe(true)

      // 驗收斷言：完全沒有 agent_runs 的 INSERT IGNORE 呼叫（沒有孤兒列）。
      const agentRunsInsertCalls = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO agent_runs'))
      expect(agentRunsInsertCalls.length).toBe(0)

      // 且「仍在跑」run 的導出 UUID 完全沒有出現在任何寫入呼叫的 run_id 位置（無孤兒可 join）。
      const orphanRunId = deriveRunId(stillRunningKey)
      const anyInsertedRunIds = fake.calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO')).map((c) => c.params[0] as string)
      expect(anyInsertedRunIds).not.toContain(orphanRunId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('重跑冪等：round1 已插入的 run，round2（同一個 pool）其 agent_runs 仍能對上（不誤殺）', async () => {
    const dir = tmpDir()
    try {
      const key = 'FAQ-6001.2026-08-24T00-00-00-000Z'
      const dbPath = createGuardFixtureDb(
        dir,
        [{ key, ticket: 'FAQ-6001', stdoutPath: '/logs/FAQ-6001.stdout.log' }],
        [{ path: '/logs/FAQ-6001.stdout.log', ticket: 'FAQ-6001', startedAt: '2026-08-24T00:00:01.000Z', endedAt: '2026-08-24T00:09:00.000Z' }],
      )
      const fake = new FakeMonitorPool() // 空白起點，模擬第一次真的回填
      const pool = fake as unknown as Pool

      const [round1Runs, round1AgentRuns] = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })
      expect(round1Runs.inserted).toBe(1)
      expect(round1Runs.skipped).toBe(0)
      expect(round1AgentRuns.inserted).toBe(1)
      expect(round1AgentRuns.skipped).toBe(0)

      // round2：同一個 pool（帶著 round1 真的寫入的 legacy_key→run_id），模擬「重跑」。
      const [round2Runs, round2AgentRuns] = await runBackfill({ snapshotPath: dbPath, dryRun: false }, { pool })

      // runs 層：run_id 與回填自己導出的值相符 → 不是既存防撞守衛的衝突對象，照常走
      // INSERT IGNORE，回報 ignored 而不是 skipped（不能被守衛誤殺）。
      expect(round2Runs.skipped).toBe(0)
      expect(round2Runs.attempted).toBe(1)
      expect(round2Runs.inserted).toBe(0)
      expect(round2Runs.ignored).toBe(1)

      // agent_runs 層（本次要保住的行為）：不誤殺——仍然 attempted，INSERT IGNORE 對回
      // 同一個 run_id，回報 ignored 而不是被級聯 skip。
      expect(round2AgentRuns.skipped).toBe(0)
      expect(round2AgentRuns.attempted).toBe(1)
      expect(round2AgentRuns.ignored).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
