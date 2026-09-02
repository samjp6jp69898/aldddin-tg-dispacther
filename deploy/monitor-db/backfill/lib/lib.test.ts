// backfill/lib 共用模組的單元測試（不需要 MySQL / VictoriaLogs；禁 sleep）。
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { deriveRunId, uuidV5, BACKFILL_RUN_ID_NAMESPACE } from './run-id.ts'
import { parseBackfillArgs } from './cli.ts'
import { loadBackfillEnv, BACKFILL_HOST } from './env.ts'
import { snapshotSqlite, tableCount, compareCounts } from './sqlite-snapshot.ts'
import { makeReport } from './report.ts'

describe('run-id', () => {
  test('同一 legacy_key 派生結果穩定（冪等前提）', () => {
    const a = deriveRunId('FAQ-3096.2026-09-01T07-05-02-406Z')
    const b = deriveRunId('FAQ-3096.2026-09-01T07-05-02-406Z')
    expect(a).toBe(b)
  })

  test('不同 legacy_key 派生不同 run_id', () => {
    expect(deriveRunId('FAQ-1.2026-01-01T00-00-00-000Z')).not.toBe(deriveRunId('FAQ-2.2026-01-01T00-00-00-000Z'))
  })

  test('輸出是合法 UUIDv5（version 5、RFC 4122 variant）', () => {
    const id = deriveRunId('x')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('RFC 4122 已知向量：uuidv5(DNS namespace, "www.example.org")', () => {
    // 已知向量（RFC 4122 附錄／各語言標準庫一致）：
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.org')).toBe(
      '74738ff5-5367-5958-9aee-98fffdcd1876',
    )
  })

  test('namespace 常數不得被改動（改了＝全部回填列換 PK）', () => {
    expect(BACKFILL_RUN_ID_NAMESPACE).toBe('3e0aa7d4-19c5-4b31-9c8a-6f2d5e8b71c9')
  })
})

describe('cli', () => {
  test('--dry-run / --schema / --env-file 與剩餘參數', () => {
    const prev = process.env.MON_DB_SCHEMA
    try {
      const args = parseBackfillArgs(['--dry-run', '--schema', 'pipeline_monitor_backfill_test', '--env-file', '/x', 'extra'])
      expect(args.dryRun).toBe(true)
      expect(args.schema).toBe('pipeline_monitor_backfill_test')
      expect(args.envFile).toBe('/x')
      expect(args.rest).toEqual(['extra'])
      expect(process.env.MON_DB_SCHEMA).toBe('pipeline_monitor_backfill_test')
    } finally {
      if (prev === undefined) delete process.env.MON_DB_SCHEMA
      else process.env.MON_DB_SCHEMA = prev
    }
  })
})

describe('env', () => {
  test('BACKFILL_HOST 是計畫 §11.2 指定值（指揮官 2026-09-02 裁定）', () => {
    expect(BACKFILL_HOST).toBe('unknown_pre_migration')
  })

  test('只補缺的 key、不覆寫既有 process.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-env-'))
    const envFile = join(dir, '.env')
    writeFileSync(envFile, 'MON_DB_HOST=from-file\nMON_DB_PORT=3307\n')
    const prevHost = process.env.MON_DB_HOST
    const prevPort = process.env.MON_DB_PORT
    try {
      process.env.MON_DB_HOST = 'preset'
      delete process.env.MON_DB_PORT
      loadBackfillEnv(envFile)
      expect(process.env.MON_DB_HOST).toBe('preset')
      expect(process.env.MON_DB_PORT).toBe('3307')
    } finally {
      if (prevHost === undefined) delete process.env.MON_DB_HOST
      else process.env.MON_DB_HOST = prevHost
      if (prevPort === undefined) delete process.env.MON_DB_PORT
      else process.env.MON_DB_PORT = prevPort
    }
  })

  test('.env 檔不存在時靜默略過（fail-loud 交給下游）', () => {
    expect(() => loadBackfillEnv('/nonexistent/.env')).not.toThrow()
  })
})

describe('sqlite-snapshot', () => {
  test('VACUUM INTO 快照與來源逐表 row count 一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-snap-'))
    const src = join(dir, 'src.sqlite')
    const dest = join(dir, 'snap.sqlite')
    const db = new Database(src)
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.run("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')")
    db.close()
    snapshotSqlite(src, dest)
    expect(tableCount(dest, 't')).toBe(3)
    const checks = compareCounts(src, dest, ['t'])
    expect(checks).toEqual([{ table: 't', live: 3, snapshot: 3, ok: true }])
  })

  test('快照檔已存在時先刪再拍（可重跑）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-snap2-'))
    const src = join(dir, 'src.sqlite')
    const dest = join(dir, 'snap.sqlite')
    const db = new Database(src)
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    db.close()
    snapshotSqlite(src, dest)
    expect(() => snapshotSqlite(src, dest)).not.toThrow()
  })
})

describe('report', () => {
  test('makeReport 初值', () => {
    const r = makeReport('x → y', true)
    expect(r).toEqual({
      source: 'x → y',
      sourceRows: 0,
      attempted: 0,
      inserted: 0,
      ignored: 0,
      skipped: 0,
      dryRun: true,
      notes: [],
    })
  })
})
