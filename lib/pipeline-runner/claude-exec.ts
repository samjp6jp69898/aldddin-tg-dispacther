import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const CLAUDE_BIN = '/Users/user/.local/bin/claude'

/**
 * 呼叫 claude -p，prompt 走 stdin 而不是 argv（`-p` 後面不帶值）。
 *
 * 這是從 T34（spec-sufficiency-gate.ts）與 T36（repo-scope-gate.ts／
 * run-demand-pipeline.ts）三處重複出現的呼叫模式抽出來的共用邏輯——原本
 * 三處都各自把 prompt 直接放進 argv（`['-p', prompt, ...]`），T34 changelog
 * 當時就記錄過這是理論風險（OS ARG_MAX，本機實測約 1MB）但『先記錄觀察，
 * 不預先優化』；T36 review 期間發現這個風險不只是理論——執行失敗/逾時時，
 * Node 的錯誤物件 `err.message` 會把整個 argv（含 prompt 全文，可能包含
 * worktree 路徑、內部指示文字）原樣塞進去，一旦這段訊息被直接回傳給
 * Telegram 使用者（run-demand-pipeline.ts 的逾時錯誤處理就這樣做過），會
 * 洩漏不該讓終端使用者看到的內部細節。改用 stdin 傳遞：argv 裡完全不含
 * prompt 內容，兩個問題一次解決（不會撞 ARG_MAX、錯誤訊息也不會夾帶
 * prompt）。實測（見 tasks.json T36 changelog）確認 Bun 的
 * `promisify(execFile)` 回傳值上有 `.child` 可以在 resolve 前存取底層
 * ChildProcess 寫 stdin，這是 Node 官方紀錄的行為（execFile 的
 * `util.promisify.custom` 實作），不是 Bun 特有、不保證的細節。
 */
export async function execClaudeWithStdin(
  args: string[],
  prompt: string,
  opts: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<string> {
  const promise = execFileAsync(CLAUDE_BIN, args, {
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer,
    timeout: opts.timeout,
    env: opts.env,
    cwd: opts.cwd,
  })
  // .child 是 Node child_process.execFile 的 util.promisify.custom 實作
  // 保證會提供的底層 ChildProcess（見上方檔頭註解），resolve 前就能拿到、
  // 寫入 stdin。
  const child = (promise as unknown as { child: import('node:child_process').ChildProcess }).child
  child.stdin?.end(prompt)

  const { stdout } = await promise
  return stdout
}
