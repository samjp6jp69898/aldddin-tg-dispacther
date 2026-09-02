// backfill/lib/sqlite-snapshot.ts — WAL-aware 的 sqlite 一致性快照。
//
// impl-constraints-addendum.md §4（2026-09-02 前端 session 實測踩坑）：
//   monitor.sqlite 開 WAL 模式，只 `cp` 主檔會【靜默】漏掉尚未 checkpoint 的
//   寫入（實測 review_rounds 欄位在副本上 no such column）。
//   → 回填讀取一律 VACUUM INTO（或 .backup），禁止 cp；
//   → 驗收必含「來源快照 row count 與正式檔一致」的檢查。
//
// 來源檔全程唯讀開啟；快照寫到呼叫端指定的暫存路徑（回填工作目錄，不污染來源）。

import { Database } from 'bun:sqlite'
import { existsSync, rmSync } from 'node:fs'

/** 以 VACUUM INTO 產生一致性快照（快照檔已存在會先刪除——VACUUM INTO 要求目標不存在）。 */
export function snapshotSqlite(srcPath: string, destPath: string): void {
  if (existsSync(destPath)) rmSync(destPath)
  const src = new Database(srcPath, { readonly: true })
  try {
    src.run(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
  } finally {
    src.close()
  }
}

export function tableCount(dbPath: string, table: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.query(`SELECT COUNT(*) AS c FROM "${table.replace(/"/g, '""')}"`).get() as { c: number }
    return row.c
  } finally {
    db.close()
  }
}

export interface SnapshotCountCheck {
  table: string
  live: number
  snapshot: number
  ok: boolean
}

/**
 * 驗收：快照與正式檔逐表 row count 一致（addendum §4）。
 * 註：兩次讀取之間正式檔可能又有新寫入（tg-monitor 常駐 collector 仍在跑），
 * 呼叫端應在快照後【立即】比對；不一致時重試一次快照再比對，仍不一致才 FAIL。
 */
export function compareCounts(livePath: string, snapshotPath: string, tables: string[]): SnapshotCountCheck[] {
  return tables.map((table) => {
    const live = tableCount(livePath, table)
    const snapshot = tableCount(snapshotPath, table)
    return { table, live, snapshot, ok: live === snapshot }
  })
}
