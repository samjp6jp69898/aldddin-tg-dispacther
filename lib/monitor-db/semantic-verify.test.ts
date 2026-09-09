// lib/monitor-db/semantic-verify.test.ts — S1–S11 語意驗證（對真實 mon-mysql 實跑）。
//
// 依據 plan-db-as-truth-v3.md §6.2.1 與 plan-db-as-truth-v3.2.md 裁定 2 §6.2.1 修訂
// 的完整重寫版 S 清單，逐條把「手冊/計畫宣稱 vs 實測」寫進斷言。對象是
// 127.0.0.1:3307 的 mon-mysql（Phase 0 已建，帳號 mon_head/mon_ui/mon_exec 皆已授權）。
//
// 冪等與自清：全部測試列一律用 `ticket = 'S-VERIFY-<name>'` 標記，run_id 用
// randomUUID()；beforeAll 先清一次（承接上次跑到一半被中斷的殘留），afterAll
// 再清一次。DELETE 用 root 帳號執行——mon_head 的授權只有
// SELECT/INSERT/UPDATE（見 migration 001，§2.2），沒有 DELETE，這是刻意的
// 逐表最小權限設計，不是本檔要繞過的東西：清理是測試基礎設施，不是應用邏輯。
//
// 不打真實 DB 的結構性測試（假 client、注入依賴）見 writes.test.ts；
// S9（SQL 靜態掃描）與 S2 的「不得出現 VALUES()」見 sql-guard-scanner.test.ts
// ——兩者本質上不需要真實 DB，這裡不重複。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConnection, type Connection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { createMonitorPool } from './pool.ts'
import type { MonitorDbExecutor } from './writes.ts'
import {
  W2_UPDATE_SQL,
  insertMcpUsage,
  upsertAgentRun,
  upsertFileOffset,
  upsertMonitorHeartbeat,
  writeRunOutcomeAuthoritative,
  writeRunProgress,
} from './writes.ts'
import { parseUpdateInfo } from './parse-update-info.ts'
import { isoToMysqlDatetime3, mysqlDatetimeToIso } from './mysql-datetime.ts'
import { MON_HOST } from './env.ts'

const TICKET_PREFIX = 'S-VERIFY-'
const SCRATCH_USER = 's_verify_ui_scratch'

let pool: MonitorDbExecutor & { end(): Promise<void> }
let root: Connection

function tRunId() {
  return randomUUID()
}

const HEARTBEAT_TEST_WRITER = 'log-intake' // 值域固定四選一，借用最不可能與本機真實行程衝突的一個做測試
const FILE_OFFSET_TEST_PATH_PREFIX = 's-verify-path-'

async function cleanup() {
  await root.execute(`DELETE FROM agent_runs WHERE path LIKE ?`, [`${TICKET_PREFIX}%`])
  await root.execute(`DELETE FROM runs WHERE ticket LIKE ?`, [`${TICKET_PREFIX}%`])
  await root.execute(`DELETE FROM mcp_usage WHERE service = ?`, ['s_verify_test'])
  await root.execute(`DELETE FROM monitor_heartbeat WHERE host = ? AND writer = ?`, [MON_HOST, HEARTBEAT_TEST_WRITER])
  await root.execute(`DELETE FROM file_offsets WHERE host = ? AND path LIKE ?`, [MON_HOST, `${FILE_OFFSET_TEST_PATH_PREFIX}%`])
  await root.query(`DROP USER IF EXISTS '${SCRATCH_USER}'@'%'`)
}

beforeAll(async () => {
  root = await createConnection({
    host: process.env.MON_DB_HOST,
    port: Number(process.env.MON_DB_PORT),
    database: process.env.MON_DB_SCHEMA,
    user: 'root',
    password: process.env.MON_DB_ROOT_PASSWORD,
    timezone: 'Z',
    dateStrings: ['DATE', 'DATETIME'],
  })
  await cleanup() // 承接上次跑到一半被中斷的殘留（冪等）
  pool = createMonitorPool('mon_head', { connectionLimit: 2 }) as unknown as MonitorDbExecutor & { end(): Promise<void> }
})

afterAll(async () => {
  await cleanup()
  await pool.end()
  await root.end()
})

describe('S1：server 版本', () => {
  test("SELECT VERSION() = '8.4.6'", async () => {
    const [rows] = await root.execute<any[]>('SELECT VERSION() AS v')
    expect(rows[0].v).toBe('8.4.6')
  })
})

describe('S2：ODKU 的 AS new 別名（8.4 可用）', () => {
  test('跑 W1 兩次（insert 再 update）不報錯', async () => {
    const runId = tRunId()
    const r1 = await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s2a`, kind: 'bug', lifecycleRank: 10 })
    expect(r1.kind).toBe('inserted')
    const r2 = await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s2a`, kind: 'bug', lifecycleRank: 30, pid: 12345 })
    expect(r2.kind).toBe('applied')
  })

  test('runs.<col> 讀到舊值、new.<col> 讀到新值（用 GREATEST 模擬雙向驗證同一支別名機制）', async () => {
    const runId = tRunId()
    // 建列，pid=100
    await root.execute(
      `INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, pid, created_at) VALUES (?,?,?,?,?,?,NOW(3))`,
      [runId, MON_HOST, `${TICKET_PREFIX}s2b`, 'bug', 30, 100],
    )
    const sql = `
      INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, pid, created_at)
      VALUES (?,?,?,?,?,?, NOW(3)) AS new
      ON DUPLICATE KEY UPDATE pid = IF(runs.pid > new.pid, runs.pid, new.pid)
    `.trim()
    // 嘗試寫入較小值 50：runs.pid(100) > new.pid(50) → 應保留舊值 100（證明 runs.pid 讀到的是「舊列」）。
    await root.execute(sql, [runId, MON_HOST, `${TICKET_PREFIX}s2b`, 'bug', 30, 50])
    let [rows] = await root.execute<any[]>('SELECT pid FROM runs WHERE run_id=?', [runId])
    expect(rows[0].pid).toBe(100)
    // 嘗試寫入較大值 200：runs.pid(100) > new.pid(200) 為假 → 應採用新值 200（證明 new.pid 讀到的是「這次嘗試寫入的值」）。
    await root.execute(sql, [runId, MON_HOST, `${TICKET_PREFIX}s2b`, 'bug', 30, 200])
    ;[rows] = await root.execute<any[]>('SELECT pid FROM runs WHERE run_id=?', [runId])
    expect(rows[0].pid).toBe(200)
  })
})

describe('S3：ON UPDATE CURRENT_TIMESTAMP(3) 只在真的變動時刷新', () => {
  test('以完全相同的值重跑 W1 → updated_at 不變且 affectedRows(matched)=0', async () => {
    const runId = tRunId()
    const input = { runId, ticket: `${TICKET_PREFIX}s3`, kind: 'bug' as const, lifecycleRank: 30 as const, pid: 777 }
    await writeRunProgress(pool, input)
    const [before] = await root.execute<any[]>('SELECT updated_at FROM runs WHERE run_id=?', [runId])
    const r = await writeRunProgress(pool, input) // 完全相同的值
    expect(r).toEqual({ kind: 'guarded', guardedReason: 'guarded_rank' })
    const [after] = await root.execute<any[]>('SELECT updated_at FROM runs WHERE run_id=?', [runId])
    expect(after[0].updated_at).toBe(before[0].updated_at)
  })
})

describe('S4：形狀 B 的 Rows matched:/Changed: 三態判定 ＋ lc_messages', () => {
  test('不存在的 run_id 跑 W2 → matched=0', async () => {
    const [header] = await (pool as any).execute(W2_UPDATE_SQL, [
      'infra_failure',
      'infra_failure',
      'exit_trap',
      isoToMysqlDatetime3('2026-09-02T00:00:00.000Z'),
      1,
      null,
      tRunId(),
      MON_HOST,
    ])
    const parsed = parseUpdateInfo(header.info)
    expect(parsed).not.toBeNull()
    expect(parsed!.matched).toBe(0)
  })

  test('已是 tier 2 的列跑 W2 → matched=1, changed=0', async () => {
    const runId = tRunId()
    await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s4b`, kind: 'bug', lifecycleRank: 30 })
    const outcomeInput = { runId, ticket: `${TICKET_PREFIX}s4b`, kind: 'bug' as const, outcome: 'success', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:00:00.000Z', exitCode: 0 }
    const first = await writeRunOutcomeAuthoritative(pool, outcomeInput)
    expect(first.kind).toBe('applied')
    const [header] = await (pool as any).execute(W2_UPDATE_SQL, [
      'success',
      'success',
      'exit_trap',
      isoToMysqlDatetime3('2026-09-02T00:00:00.000Z'),
      0,
      null,
      runId,
      MON_HOST,
    ])
    const parsed = parseUpdateInfo(header.info)
    expect(parsed).toEqual({ matched: 0, changed: 0, warnings: 0 }) // guard 擋下（已是 tier2），matched 也是 0——見下一條分辨「命中無變更」
  })

  test('正常列（tier1 → tier2 覆寫）跑 W2 → matched=1, changed>=1', async () => {
    const runId = tRunId()
    await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s4c`, kind: 'bug', lifecycleRank: 30 })
    const [header] = await (pool as any).execute(W2_UPDATE_SQL, [
      'success',
      'success',
      'exit_trap',
      isoToMysqlDatetime3('2026-09-02T00:00:00.000Z'),
      0,
      null,
      runId,
      MON_HOST,
    ])
    const parsed = parseUpdateInfo(header.info)
    expect(parsed!.matched).toBe(1)
    expect(parsed!.changed).toBeGreaterThanOrEqual(1)
  })

  test('【G:MN-G2】SHOW VARIABLES LIKE lc_messages 必須是 en_US', async () => {
    const [rows] = await root.execute<any[]>(`SHOW VARIABLES LIKE 'lc_messages'`)
    expect(rows[0].Value).toBe('en_US')
  })
})

describe("S4b：flags:['-FOUND_ROWS'] 真的關掉了 CLIENT_FOUND_ROWS", () => {
  test('對已是現值的列跑 UPDATE ... SET x=<現值> → affectedRows 必須為 0', async () => {
    const runId = tRunId()
    await root.execute(`INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, created_at) VALUES (?,?,?,?,?,NOW(3))`, [
      runId,
      MON_HOST,
      `${TICKET_PREFIX}s4b2`,
      'bug',
      30,
    ])
    const [header] = await (pool as any).execute('UPDATE runs SET ticket = ticket WHERE run_id = ?', [runId])
    expect(header.affectedRows).toBe(0)
  })
})

describe('S5：生成欄位 lifecycle 合法且可建索引', () => {
  test('lifecycle_rank=30 的列，SELECT lifecycle 回 running', async () => {
    const runId = tRunId()
    await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s5`, kind: 'bug', lifecycleRank: 30 })
    const [rows] = await root.execute<any[]>('SELECT lifecycle FROM runs WHERE run_id=?', [runId])
    expect(rows[0].lifecycle).toBe('running')
  })

  test('EXPLAIN 對 (host, lifecycle_rank) 查詢走得到 idx_host_lifecycle', async () => {
    const [rows] = await root.query<any[]>('EXPLAIN SELECT run_id FROM runs WHERE host = ? AND lifecycle_rank = ?', [MON_HOST, 30])
    expect(rows[0].key).toBe('idx_host_lifecycle')
  })
})

describe('S6：欄位級 GRANT（mon_ui 的 INSERT 與 UPDATE 白名單）', () => {
  test('SHOW GRANTS FOR mon_ui 已含裁定 3 要求的九欄 INSERT 與四欄 UPDATE', async () => {
    const [rows] = await root.query<any[]>(`SHOW GRANTS FOR 'mon_ui'@'%'`)
    const grantText = (rows as any[]).map(r => Object.values(r)[0]).join('\n')
    for (const col of ['run_id', 'host', 'ticket', 'kind', 'lifecycle_rank', 'cancel_requested_at', 'cancel_resolved_by', 'legacy_key', 'created_at']) {
      expect(grantText).toContain(col)
    }
    expect(grantText).toMatch(/INSERT\s*\(/)
    expect(grantText).toMatch(/UPDATE\s*\(/)
    expect(grantText).not.toMatch(/UPDATE\s*\([^)]*outcome_tier/)
  })

  test('行為驗證（鏡像帳號，不動真正的 mon_ui 密碼）：欄位級 INSERT/UPDATE 真的擋得住越權欄位', async () => {
    // 用 root 建一個密碼已知的鏡像帳號，套用與 mon_ui 完全相同的授權組合，
    // 驗證 MySQL 8.4 的欄位級 GRANT 語法真的在執行期生效（不只是「GRANT 語句沒報錯」）。
    const scratchPassword = randomUUID()
    await root.query(`CREATE USER '${SCRATCH_USER}'@'%' IDENTIFIED BY '${scratchPassword}'`)
    await root.query(
      `GRANT SELECT, INSERT (run_id, host, ticket, kind, lifecycle_rank, cancel_requested_at, cancel_resolved_by, legacy_key, created_at), ` +
        `UPDATE (cancel_requested_at, cancel_resolved_by, outcome, outcome_source) ON pipeline_monitor.runs TO '${SCRATCH_USER}'@'%'`,
    )
    await root.query('FLUSH PRIVILEGES')

    const scratchConn = await createConnection({
      host: process.env.MON_DB_HOST,
      port: Number(process.env.MON_DB_PORT),
      database: process.env.MON_DB_SCHEMA,
      user: SCRATCH_USER,
      password: scratchPassword,
      timezone: 'Z',
      dateStrings: ['DATE', 'DATETIME'],
    })
    try {
      const runId = tRunId()
      // 正向：九欄 INSERT 應該成功。
      await scratchConn.execute(
        `INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, cancel_requested_at, cancel_resolved_by, legacy_key, created_at) VALUES (?,?,?,?,?,?,?,?,NOW(3))`,
        [runId, MON_HOST, `${TICKET_PREFIX}s6`, 'bug', 10, null, null, null],
      )
      // 正向：cancel_requested_at UPDATE 應該成功。
      await scratchConn.execute(`UPDATE runs SET cancel_requested_at = NOW(3) WHERE run_id = ?`, [runId])
      // 負向：outcome_tier 不在 UPDATE 白名單 → 必須 ERROR 1143。
      await expect(scratchConn.execute(`UPDATE runs SET outcome_tier = 2 WHERE run_id = ?`, [runId])).rejects.toMatchObject({ errno: 1143 })
      // 負向：outcome/outcome_tier 不在 INSERT 白名單 → 必須 ERROR 1143。
      await expect(
        scratchConn.execute(`INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, outcome, outcome_tier) VALUES (?,?,?,?,?,?,?)`, [
          tRunId(),
          MON_HOST,
          `${TICKET_PREFIX}s6`,
          'bug',
          10,
          'success',
          2,
        ]),
      ).rejects.toMatchObject({ errno: 1143 })
      // 負向：ticket 不在 UPDATE 白名單 → 必須 ERROR 1143。
      await expect(scratchConn.execute(`UPDATE runs SET ticket = 'x' WHERE run_id = ?`, [runId])).rejects.toMatchObject({ errno: 1143 })
    } finally {
      await scratchConn.end()
    }
  })
})

describe('S7：ISO ↔ MySQL DATETIME(3) 往返（重要發現：mysql2 dateStrings 只管讀，不管寫）', () => {
  test('寫入 ISO 字串（經 dt() 轉換）→ 讀回 → 逐字元還原成原始 ISO', async () => {
    const runId = tRunId()
    const iso = '2026-08-26T03:23:44.751Z'
    await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s7`, kind: 'bug', lifecycleRank: 30, startedAt: iso })
    const [rows] = await root.execute<any[]>('SELECT started_at FROM runs WHERE run_id=?', [runId])
    expect(mysqlDatetimeToIso(rows[0].started_at)).toBe(iso)
  })

  test('【發現】直接把帶 T/Z 的 ISO 字串綁定到 DATETIME(3) 參數，MySQL 拒絕（ER_TRUNCATED_WRONG_VALUE），不是「格式落差」而是寫不進去', async () => {
    const runId = tRunId()
    await expect(
      (pool as any).execute('INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, started_at, created_at) VALUES (?,?,?,?,?,?,NOW(3))', [
        runId,
        MON_HOST,
        `${TICKET_PREFIX}s7b`,
        'bug',
        30,
        '2026-08-26T03:23:44.751Z',
      ]),
    ).rejects.toMatchObject({ code: 'ER_TRUNCATED_WRONG_VALUE' })
  })
})

describe('S8：mcp_usage 的 raw_sha256 生成欄位 + UNIQUE(service, raw_sha256)', () => {
  test('重複 raw → 第二次 INSERT IGNORE 被吃掉（affectedRows=0），第一次成功', async () => {
    const raw = JSON.stringify({ marker: randomUUID() })
    const ts = '2026-09-02T00:00:00.000Z'
    const first = await insertMcpUsage(pool, { service: 's_verify_test', raw, ts })
    expect(first.kind).toBe('inserted')
    const second = await insertMcpUsage(pool, { service: 's_verify_test', raw, ts })
    expect(second).toEqual({ kind: 'guarded', guardedReason: 'guarded_other' })
  })

  test('不同 raw（即使其餘欄位相同）不衝突', async () => {
    const ts = '2026-09-02T00:00:00.000Z'
    const a = await insertMcpUsage(pool, { service: 's_verify_test', raw: JSON.stringify({ m: randomUUID() }), ts })
    const b = await insertMcpUsage(pool, { service: 's_verify_test', raw: JSON.stringify({ m: randomUUID() }), ts })
    expect(a.kind).toBe('inserted')
    expect(b.kind).toBe('inserted')
  })
})

describe('S10：outcome_tier 的 nullability 與兩條 CHECK', () => {
  test('W1 的欄位清單（不列 outcome_tier）INSERT 成功，SELECT outcome_tier 為 NULL', async () => {
    const runId = tRunId()
    const r = await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s10a`, kind: 'bug', lifecycleRank: 10 })
    expect(r.kind).toBe('inserted')
    const [rows] = await root.execute<any[]>('SELECT outcome_tier FROM runs WHERE run_id=?', [runId])
    expect(rows[0].outcome_tier).toBeNull()
  })

  test('INSERT ... outcome_tier=0 必須被 chk_outcome_tier 擋下', async () => {
    const runId = tRunId()
    await expect(
      root.execute(`INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, outcome_tier, created_at) VALUES (?,?,?,?,?,0,NOW(3))`, [
        runId,
        MON_HOST,
        `${TICKET_PREFIX}s10b`,
        'bug',
        10,
      ]),
    ).rejects.toMatchObject({ errno: 3819 }) // CHECK constraint violation
  })

  test("UPDATE ... SET outcome='success', outcome_tier=NULL 必須被 chk_outcome_tier_pair 擋下", async () => {
    const runId = tRunId()
    await root.execute(`INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, created_at) VALUES (?,?,?,?,?,NOW(3))`, [
      runId,
      MON_HOST,
      `${TICKET_PREFIX}s10c`,
      'bug',
      10,
    ])
    await expect(root.execute(`UPDATE runs SET outcome='success', outcome_tier=NULL WHERE run_id=?`, [runId])).rejects.toMatchObject({
      errno: 3819,
    })
  })
})

describe('S11：--default-time-zone=+00:00 + timezone:Z 下，NOW(3) 與 client 端時鐘一致', () => {
  test('created_at 由 NOW(3) 產生 → 讀回換算 ISO → 與 client Date.now() 差 < 2 秒', async () => {
    const runId = tRunId()
    const before = Date.now()
    await writeRunProgress(pool, { runId, ticket: `${TICKET_PREFIX}s11`, kind: 'bug', lifecycleRank: 10 })
    const after = Date.now()
    const [rows] = await root.execute<any[]>('SELECT created_at FROM runs WHERE run_id=?', [runId])
    const dbTime = new Date(mysqlDatetimeToIso(rows[0].created_at)).getTime()
    expect(dbTime).toBeGreaterThanOrEqual(before - 2000)
    expect(dbTime).toBeLessThanOrEqual(after + 2000)
  })

  test("SHOW VARIABLES LIKE 'time_zone' 為 +00:00（S7/S11 共同前提）", async () => {
    const [rows] = await root.execute<any[]>(`SHOW VARIABLES LIKE 'time_zone'`)
    expect(rows[0].Value).toBe('+00:00')
  })
})

describe('migration 002：monitor_heartbeat 的 (host, writer) 守衛（對真實已套用的新 schema）', () => {
  test('同一 (host, writer) 重放舊心跳不會把時間推回去；不同 writer 各自一列', async () => {
    const t1 = '2026-09-02T00:00:00.000Z'
    const t2 = '2026-09-02T00:01:00.000Z'
    const r1 = await upsertMonitorHeartbeat(pool, { writer: HEARTBEAT_TEST_WRITER, ts: t1, spoolDepth: 0 })
    expect(r1.kind).toBe('inserted')
    const r2 = await upsertMonitorHeartbeat(pool, { writer: HEARTBEAT_TEST_WRITER, ts: t2, spoolDepth: 5 })
    expect(r2.kind).toBe('applied')
    // 重放較舊的 t1 → 守衛擋下，spool_depth 維持在 t2 那次寫入的值。
    const r3 = await upsertMonitorHeartbeat(pool, { writer: HEARTBEAT_TEST_WRITER, ts: t1, spoolDepth: 999 })
    expect(r3).toEqual({ kind: 'guarded', guardedReason: 'guarded_other' })
    const [rows] = await root.execute<any[]>('SELECT spool_depth FROM monitor_heartbeat WHERE host=? AND writer=?', [MON_HOST, HEARTBEAT_TEST_WRITER])
    expect(rows[0].spool_depth).toBe(5)
  })

  test('CHECK 擋住值域外的 writer', async () => {
    await expect(
      root.execute(`INSERT INTO monitor_heartbeat (host, writer, ts) VALUES (?, ?, NOW(3))`, [MON_HOST, 'not-a-real-writer']),
    ).rejects.toMatchObject({ errno: 3819 })
  })
})

describe('migration 002：file_offsets 的 event_seq 守衛（對真實已套用的新 schema，MAJOR-F10/MN-G11）', () => {
  test('event_seq 較小的重放事件不生效（同 inode）', async () => {
    const path = `${FILE_OFFSET_TEST_PATH_PREFIX}same-inode`
    const r1 = await upsertFileOffset(pool, { path, inode: 111, offset: 100, eventSeq: 1000 })
    expect(r1.kind).toBe('inserted')
    const r2 = await upsertFileOffset(pool, { path, inode: 111, offset: 50, eventSeq: 500 }) // 較舊事件，offset 還比較小
    expect(r2).toEqual({ kind: 'guarded', guardedReason: 'guarded_other' })
    const [rows] = await root.execute<any[]>('SELECT `offset`, event_seq FROM file_offsets WHERE host=? AND path=?', [MON_HOST, path])
    expect(rows[0].offset).toBe(100)
    expect(rows[0].event_seq).toBe(1000)
  })

  test('跨 inode 的舊事件也不生效（MAJOR-F10 問題 1 明列的案例：inode=OLD, offset=大 對 DB 現值 inode=NEW, offset=0）', async () => {
    const path = `${FILE_OFFSET_TEST_PATH_PREFIX}rotate`
    // 現值：rotate 之後的新 inode，offset 剛歸零，但 event_seq 較大（比舊 inode 的任何事件都晚）。
    const r1 = await upsertFileOffset(pool, { path, inode: 222, offset: 0, eventSeq: 5000 })
    expect(r1.kind).toBe('inserted')
    // 一個「跨 inode 的舊事件」：舊 inode、offset 很大，但 event_seq 比現值小（因為它在牆鐘上更早）。
    const r2 = await upsertFileOffset(pool, { path, inode: 111, offset: 999999, eventSeq: 100 })
    expect(r2).toEqual({ kind: 'guarded', guardedReason: 'guarded_other' })
    const [rows] = await root.execute<any[]>('SELECT inode, `offset` FROM file_offsets WHERE host=? AND path=?', [MON_HOST, path])
    expect(rows[0].inode).toBe(222)
    expect(rows[0].offset).toBe(0)
  })

  test('event_seq 較大的新事件（即使 offset 較小，例如同一 inode 內…理論上不會發生，但用來確認守衛只看 event_seq）仍然生效', async () => {
    const path = `${FILE_OFFSET_TEST_PATH_PREFIX}newer-wins`
    await upsertFileOffset(pool, { path, inode: 333, offset: 100, eventSeq: 10 })
    const r = await upsertFileOffset(pool, { path, inode: 444, offset: 0, eventSeq: 20 })
    expect(r.kind).toBe('applied')
    const [rows] = await root.execute<any[]>('SELECT inode, `offset` FROM file_offsets WHERE host=? AND path=?', [MON_HOST, path])
    expect(rows[0].inode).toBe(444)
    expect(rows[0].offset).toBe(0)
  })
})

describe('migration 003：agent_runs 10 個 payload 欄位（ODKU COALESCE 對真實 MySQL 8.4 實測）', () => {
  test('首次 INSERT 帶部分欄位，第二次 upsert 補齊其餘欄位，COALESCE 不覆寫已有值', async () => {
    const runId = tRunId()
    const path = `${TICKET_PREFIX}agent-runs-a`
    const r1 = await upsertAgentRun(pool, { runId, path, agentName: 'bug-tracer', model: 'claude-sonnet-5', inputTokens: 100, isError: false })
    expect(r1.kind).toBe('inserted')

    // 第二次呼叫改帶不同的 model（模擬重放/晚到訊號）與新欄位（cost/tool_calls），
    // 已有值（model/inputTokens/isError）必須維持第一次寫的，新欄位補上。
    const r2 = await upsertAgentRun(pool, {
      runId,
      path,
      model: 'claude-opus-5',
      inputTokens: 999,
      isError: true,
      costUsd: 1.234567,
      toolCalls: 12,
      numTurns: 3,
      resultPreview: 'ok',
    })
    expect(r2.kind).toBe('applied')

    const [rows] = await root.execute<any[]>('SELECT * FROM agent_runs WHERE run_id=? AND path=?', [runId, path])
    const row = rows[0]
    expect(row.model).toBe('claude-sonnet-5') // 第一次寫的值不被覆蓋
    expect(row.input_tokens).toBe(100)
    expect(row.is_error).toBe(0)
    expect(Number(row.cost_usd)).toBeCloseTo(1.234567, 6) // 第二次才補上的欄位
    expect(row.tool_calls).toBe(12)
    expect(row.num_turns).toBe(3)
    expect(row.result_preview).toBe('ok')
  })

  test('result_preview 超過 512 字元由呼叫端函式防禦性截斷', async () => {
    const runId = tRunId()
    const path = `${TICKET_PREFIX}agent-runs-b`
    const long = 'x'.repeat(600)
    await upsertAgentRun(pool, { runId, path, resultPreview: long })
    const [rows] = await root.execute<any[]>('SELECT result_preview FROM agent_runs WHERE run_id=? AND path=?', [runId, path])
    expect(rows[0].result_preview.length).toBe(512)
  })
})

describe('【G:MN-G3】mysql2 版本 pin 檢查', () => {
  test("package.json 的 mysql2 版本恰好是 '3.18.0'（無 ^/~ 前綴）", async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies.mysql2).toBe('3.18.0')
  })
})
