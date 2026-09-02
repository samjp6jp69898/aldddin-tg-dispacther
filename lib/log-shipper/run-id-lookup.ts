// lib/log-shipper/run-id-lookup.ts — (host, stdout_path) → run_id 查詢。
//
// 派工規格：「run_id 由注入的 lookup `(host, stdout_path) => run_id|null` 提供
// （實作為對 runs 的 SELECT，executor 注入；對不到留空，不用檔名時戳猜）」。
// 本檔提供預設實作（唯讀 SELECT，不寫 runs），shipper.ts 的呼叫端仍可自行
// 注入其他函式（測試用假查找）。

import type { RowDataPacket } from 'mysql2/promise'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

export const RUN_ID_LOOKUP_SQL = 'SELECT run_id FROM runs WHERE host = ? AND stdout_path = ? ORDER BY created_at DESC LIMIT 1'

export type RunIdLookup = (host: string, stdoutPath: string) => Promise<string | null>

/**
 * 對不到（查無列）回 null——呼叫端據此讓 run_id 留空，不猜測。
 * 查詢本身拋例外也回 null 並吞掉：run_id 是 best-effort 補充欄，不應該讓
 * 整輪 shipping 因為這條 SELECT 掛掉而中止（那是 sink/DB offset 寫入才有的
 * 「本輪結束」語意，見 shipper.ts §4）。
 */
export function createRunIdLookup(executor: MonitorDbExecutor): RunIdLookup {
  return async (host, stdoutPath) => {
    try {
      const [rows] = await executor.execute<RowDataPacket[]>(RUN_ID_LOOKUP_SQL, [host, stdoutPath])
      const row = (rows as RowDataPacket[])[0] as { run_id?: string } | undefined
      return row?.run_id ?? null
    } catch {
      return null
    }
  }
}
