// backfill/lib/db.ts — 回填的 DB 連線與冪等寫入 helper。
//
// pool 一律經 createMonitorPool()（【G:MN-G7】全案唯一 createPool 呼叫點），
// 角色 mon_head、connectionLimit 1（plan v3.2 §4.6 pool 歸屬表：離線 CLI＝1）。
// schema 由 MON_DB_SCHEMA 決定——測試以 --schema / 環境變數指向臨時 schema，
// 正式回填才指向 pipeline_monitor（由指揮官在 Phase 6 時點通知後執行）。

import type { Pool, ResultSetHeader } from 'mysql2/promise'
import { createMonitorPool } from '../../../../lib/monitor-db/pool.ts'

export function openBackfillPool(): Pool {
  return createMonitorPool('mon_head', { connectionLimit: 1 })
}

/**
 * INSERT IGNORE 單列。回傳 inserted（true＝真的插入；false＝唯一鍵已存在被略過）。
 * pool 帶 flags:['-FOUND_ROWS']，INSERT IGNORE 命中重複時 affectedRows=0。
 */
export async function insertIgnoreRow(
  pool: Pool,
  table: string,
  columns: string[],
  values: unknown[],
): Promise<boolean> {
  const sql = `INSERT IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  const [header] = await pool.execute<ResultSetHeader>(sql, values)
  return header.affectedRows >= 1
}

/**
 * 無唯一鍵的 append-only 表（service_status_log 等 auto-increment PK）用的
 * 守衛式冪等插入：INSERT … SELECT … WHERE NOT EXISTS(<自然鍵比對>)。
 * 自然鍵由呼叫端指定（如 service+ts+status）。單執行緒離線回填下無競態
 * （§11.2：一次性、離線、單執行緒）。
 */
export async function insertIfNotExists(
  pool: Pool,
  table: string,
  columns: string[],
  values: unknown[],
  naturalKeyColumns: string[],
  naturalKeyValues: unknown[],
): Promise<boolean> {
  const where = naturalKeyColumns.map((c) => `${c} <=> ?`).join(' AND ')
  const sql =
    `INSERT INTO ${table} (${columns.join(', ')}) ` +
    `SELECT ${columns.map(() => '?').join(', ')} FROM DUAL ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${where})`
  const [header] = await pool.execute<ResultSetHeader>(sql, [...values, ...naturalKeyValues])
  return header.affectedRows >= 1
}

/** 逐表 row count（對數報告用）。 */
export async function countRows(pool: Pool, table: string, whereSql = '', params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS c FROM ${table} ${whereSql}`, params)
  return Number(rows[0].c)
}

/**
 * 既存防撞守衛：唯讀查詢 mysql `runs` 表 `legacy_key → run_id` 全集。
 *
 * 背景：`runs` 的 PK 只有 `run_id`，`legacy_key` 非唯一鍵；live 寫入路徑用
 * `randomUUID()` 鑄 `run_id`，回填路徑用 `deriveRunId(legacy_key)` 導出
 * `run_id`——兩者對同一支歷史 run 算出的 `run_id` 不同，`INSERT IGNORE`
 * 因此不會偵測到重複，雙軌重疊的 run 會被插成兩列且零警告。
 *
 * 回傳 `run_id`（不只 `legacy_key` 存在與否）是為了讓呼叫端能區分兩種
 * 「已存在」：(1) `run_id` 與 `deriveRunId(legacy_key)` 相符 → 這是回填腳本
 * 自己前一輪跑出來的列（重跑冪等），不是衝突，正常流程處理即可（INSERT IGNORE
 * 自然回報 ignored，agent_runs 仍可對上）；(2) `run_id` 不符 → 真的是 live
 * 路徑鑄出來的另一支列，屬於雙軌重疊，才需要 skip 並級聯 skip agent_runs。
 * 只查 `legacy_key` 存在與否會把這兩種情境誤判為同一種。
 *
 * 本函式**只讀**，呼叫端在回填 runs 之前先呼叫本函式建 Map，據以在寫入迴圈
 * 開始前判斷每一列的歸屬；本函式與所有寫入語句嚴格分離，不得在同一次
 * 呼叫裡夾帶任何寫入。
 */
export async function fetchExistingRunIdsByLegacyKey(pool: Pool): Promise<Map<string, string>> {
  const [rows] = await pool.query<any[]>(`SELECT legacy_key, run_id FROM runs WHERE legacy_key IS NOT NULL`)
  return new Map(rows.map((r: any) => [String(r.legacy_key), String(r.run_id)]))
}
