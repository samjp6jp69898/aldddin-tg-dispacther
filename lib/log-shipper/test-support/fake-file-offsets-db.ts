// lib/log-shipper/test-support/fake-file-offsets-db.ts — 測試用假 file_offsets 表。
//
// 沿用 lib/monitor-db/test-support/fake-runs-db.ts 的既有寫法（唯讀參考：SQL
// 常數參照相等分派、記憶體模擬 matched/changed），只是換一張表——本檔屬於
// log-shipper 工項的檔案所有權範圍，不動 lib/monitor-db/*。
//
// 額外提供 `throwOnNextExecute`，供測試模擬「upsertFileOffset 自身失敗」
// （DB 呼叫本身拋例外）情境，驗證 shipper.ts 的「記憶體 offset 也不推進」語意。

import type { ResultSetHeader } from 'mysql2/promise'
import * as W from '../../monitor-db/writes.ts'
import type { MonitorDbExecutor } from '../../monitor-db/writes.ts'

export interface FakeFileOffsetRow {
  host: string
  path: string
  inode: number
  offset: number
  event_seq: number
}

class DupEntryError extends Error {
  code = 'ER_DUP_ENTRY'
}

function okHeader(affectedRows: number, extra: Partial<ResultSetHeader> = {}): ResultSetHeader {
  return { affectedRows, fieldCount: 0, insertId: 0, info: '', serverStatus: 0, warningStatus: 0, ...extra } as ResultSetHeader
}

function updateHeader(matched: number, changed: number, warnings = 0): ResultSetHeader {
  return okHeader(matched, { info: `Rows matched: ${matched}  Changed: ${changed}  Warnings: ${warnings}` } as Partial<ResultSetHeader>)
}

export class FakeFileOffsetsDb implements MonitorDbExecutor {
  rows = new Map<string, FakeFileOffsetRow>() // key = `${host}␟${path}`
  calls: Array<{ sql: string; params: unknown[] }> = []
  /** true 時下一次 execute() 直接拋例外（自動歸零，只影響下一次呼叫）。 */
  throwOnNextExecute = false

  private key(host: string, path: string): string {
    return `${host}␟${path}`
  }

  async execute<T = ResultSetHeader>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    if (this.throwOnNextExecute) {
      this.throwOnNextExecute = false
      throw new Error('FakeFileOffsetsDb: 模擬 DB 呼叫失敗')
    }
    this.calls.push({ sql, params })

    if (sql === W.FILE_OFFSET_UPDATE_SQL) return [this.handleUpdate(params) as unknown as T, []]
    if (sql === W.FILE_OFFSET_INSERT_SQL) return [this.handleInsert(params) as unknown as T, []]

    throw new Error(`FakeFileOffsetsDb: 未預期的 SQL：${sql}`)
  }

  private handleUpdate(params: unknown[]): ResultSetHeader {
    const [offset, inode, eventSeq, host, path] = params as [number, number, number, string, string]
    const row = this.rows.get(this.key(host, path))
    if (!row || !(row.event_seq < eventSeq)) return updateHeader(0, 0)
    const changed = row.offset !== offset || row.inode !== inode || row.event_seq !== eventSeq
    row.offset = offset
    row.inode = inode
    row.event_seq = eventSeq
    return updateHeader(1, changed ? 1 : 0)
  }

  private handleInsert(params: unknown[]): ResultSetHeader {
    const [host, path, inode, offset, eventSeq] = params as [string, string, number, number, number]
    const k = this.key(host, path)
    if (this.rows.has(k)) throw new DupEntryError('duplicate file_offsets row')
    this.rows.set(k, { host, path, inode, offset, event_seq: eventSeq })
    return okHeader(1)
  }
}
