import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
/**
 * agent trace（tg-monitor 用）：帶 opts.trace 時，把這一次 claude -p 呼叫的
 * prompt、參數、完整 stdout 事件陣列（含每輪 assistant 訊息、tool_use/tool_result、
 * 以及 result 事件裡的 usage / modelUsage / total_cost_usd）原樣落地到
 * logs/agent-traces/<ticket>/<startedAt>-<stage>.json。失敗（timeout、非 0 exit）
 * 也會寫一份帶 error 欄位的 trace。純旁路、best-effort：落地失敗只 console.error，
 * 不影響回傳值與既有呼叫端行為。不帶 trace 時行為與原本完全相同。
 */
const TRACE_DIR = '/Users/user/aladdin/telegram-dispatcher/logs/agent-traces'

export type ClaudeTrace = { ticket: string; stage: string }

function writeTrace(trace: ClaudeTrace, body: Record<string, unknown>) {
  // bun test 會設 NODE_ENV=test；測試（如 repo-scope-gate.test.ts 會真打 claude）
  // 不該在正式 trace 目錄留下假票號的檔案。
  if (process.env.NODE_ENV === 'test') return
  try {
    const dir = join(TRACE_DIR, trace.ticket.replace(/[^A-Za-z0-9_-]/g, '_'))
    mkdirSync(dir, { recursive: true })
    const stamp = String(body.startedAt).replace(/[:.]/g, '-')
    const safeStage = trace.stage.replace(/[^A-Za-z0-9_-]/g, '_')
    writeFileSync(join(dir, `${stamp}-${safeStage}.json`), JSON.stringify({ ticket: trace.ticket, stage: trace.stage, ...body }), 'utf8')
  } catch (err) {
    console.error(`agent trace 落地失敗（${trace.ticket}/${trace.stage}）: ${err}`)
  }
}

export async function execClaudeWithStdin(
  args: string[],
  prompt: string,
  opts: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv; cwd?: string; trace?: ClaudeTrace },
): Promise<string> {
  const startedAt = new Date().toISOString()
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

  try {
    const { stdout } = await promise
    if (opts.trace) {
      let events: unknown = null
      try {
        events = JSON.parse(stdout)
      } catch {}
      writeTrace(opts.trace, { startedAt, endedAt: new Date().toISOString(), cwd: opts.cwd ?? null, args, prompt, events, rawStdout: events === null ? stdout : undefined })
    }
    return stdout
  } catch (err) {
    if (opts.trace) {
      const e = err as { message?: string; stdout?: string; stderr?: string; code?: unknown; killed?: boolean }
      writeTrace(opts.trace, { startedAt, endedAt: new Date().toISOString(), cwd: opts.cwd ?? null, args, prompt, events: null, error: { message: e?.message, code: e?.code, killed: e?.killed, stderr: String(e?.stderr ?? '').slice(0, 4000), stdout: String(e?.stdout ?? '').slice(0, 4000) } })
    }
    throw err
  }
}
