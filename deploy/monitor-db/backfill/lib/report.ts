// backfill/lib/report.ts — 回填對數報告的共用結構與輸出。
//
// 驗收要求（指派第 5 點）：每個來源「快照 row count vs 寫入 row count」對數報告；
// 冪等（重跑不重複——INSERT IGNORE / UNIQUE / NOT EXISTS 守衛），重跑時 inserted=0、
// ignored=全數 是預期結果，不是錯誤。

export interface SourceReport {
  /** 來源識別，如 'sqlite.pipeline_runs → runs' */
  source: string
  /** 來源（快照）列數 */
  sourceRows: number
  /** 實際嘗試寫入的列數（過濾/跳過後） */
  attempted: number
  /** 本次真正插入的列數 */
  inserted: number
  /** 因唯一鍵/守衛而略過的列數（重跑時＝先前已寫入的） */
  ignored: number
  /** 依規則不寫入的列數（如超出 VL retention、無法對位），附 notes 說明 */
  skipped: number
  /** dry-run 模式（inserted/ignored 恆 0，attempted＝將寫入數） */
  dryRun: boolean
  notes: string[]
}

export function makeReport(source: string, dryRun: boolean): SourceReport {
  return { source, sourceRows: 0, attempted: 0, inserted: 0, ignored: 0, skipped: 0, dryRun, notes: [] }
}

/** 人讀表格 ＋ 一行 machine-readable JSON（run-backfill.sh 彙總用）。 */
export function printReports(reports: SourceReport[]): void {
  for (const r of reports) {
    const mode = r.dryRun ? ' [dry-run]' : ''
    console.log(
      `${r.source}${mode}: source=${r.sourceRows} attempted=${r.attempted} ` +
        `inserted=${r.inserted} ignored=${r.ignored} skipped=${r.skipped}`,
    )
    for (const n of r.notes) console.log(`  note: ${n}`)
  }
  console.log(`BACKFILL_REPORT_JSON: ${JSON.stringify(reports)}`)
}
