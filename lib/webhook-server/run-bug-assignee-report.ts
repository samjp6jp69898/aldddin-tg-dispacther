/**
 * run-bug-assignee-report.ts — 執行 bug-assignee-report.ts 這一個 leaf。
 *
 * 獨立成檔案是為了測試：bug-report-command.ts 的測試（見
 * whitelist-bugreport-routing.test.ts）需要 mock 掉「真的打 Notion API」這
 * 一步，若直接在 bug-report-command.ts 裡呼叫 node:child_process 的
 * execFileSync，測試就得 mock 整個 node:child_process 模組——但 kit-issue.ts
 * 也用 execFileSync（跑 zip），mock.module 是 process 全域生效，兩邊互不知情
 * 各自 mock 同一個內建模組會互相覆蓋（同一個理由見
 * whitelist-kit-routing.test.ts 對 spawn_kit_script.ts 的說明）。獨立成這個
 * 只有這裡會用到的檔案，測試只需要 mock 這一個 leaf，不動 node:child_process。
 */
import { execFileSync } from 'node:child_process'

const REPORT_SCRIPT = '/Users/user/aladdin/aladdin_ai/skills/notion-bug-assignee-report/bug-assignee-report.ts'

export type RunResult = { success: true } | { success: false; stderr: string }

export function runBugAssigneeReportScript(outBase: string): RunResult {
  try {
    // --no-push：這裡的呼叫端（bug-report-send.ts）自己會把三份 CSV 送出去，
    // 若不加這個旗標，leaf 腳本內建的 Telegram 推播（固定推給 Landon）會跟這裡重複推播一次。
    execFileSync('bun', [REPORT_SCRIPT, '--out', outBase, '--no-push'], { stdio: ['ignore', 'ignore', 'pipe'] })
    return { success: true }
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr?: Buffer }).stderr ?? '').slice(0, 1000) : String(err)
    return { success: false, stderr: stderr || '（無 stderr 輸出，僅回傳非 0 exit code）' }
  }
}
