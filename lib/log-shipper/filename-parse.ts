// lib/log-shipper/filename-parse.ts — pipeline log 檔名解析（ticket/kind，§7.4）。
//
// 參考 deploy/monitor-db/backfill/backfill-logs-vl.ts 的既有解析邏輯（唯讀
// 參考，未 import——那支腳本不在本工項的檔案所有權範圍內），在此重新實作一份
// 給即時 shipper 用。格式：`<ticket>.<ISO>.(demand-pipeline.)?(stdout|stderr).log`
// （ISO 形如 2026-09-01T07-05-02-406Z）。其餘 .log（bootstrap.log、
// demand-pipeline.log、cleanup-worktree.log 等雜項）與 audit*.jsonl 一律回傳
// { ticket: null, kind: null }。

const ISO_RAW_SRC = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z'
const DEMAND_LOG_RE = new RegExp(`^(.+)\\.(${ISO_RAW_SRC})\\.demand-pipeline\\.(?:stdout|stderr)\\.log$`)
const BUG_LOG_RE = new RegExp(`^(.+)\\.(${ISO_RAW_SRC})\\.(?:stdout|stderr)\\.log$`)

export interface ParsedLogFilename {
  ticket: string | null
  kind: 'bug' | 'demand' | null
}

/** 傳入 basename（含副檔名）。 */
export function parseLogFilename(basename: string): ParsedLogFilename {
  const demand = DEMAND_LOG_RE.exec(basename)
  if (demand) return { ticket: demand[1] ?? null, kind: 'demand' }
  const bug = BUG_LOG_RE.exec(basename)
  if (bug) return { ticket: bug[1] ?? null, kind: 'bug' }
  return { ticket: null, kind: null }
}
