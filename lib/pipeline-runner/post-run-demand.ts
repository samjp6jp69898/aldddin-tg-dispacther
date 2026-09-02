// lib/pipeline-runner/post-run-demand.ts
//
// demand pipeline 的 EXIT trap 收尾（監控 DB 化，plan-db-as-truth-v3.md §9
// Phase 2「demand 終態（trap 側，v1/v2 都缺實作）」列）。掛進
// spawn-demand-pipeline.ts 的 WRAPPER_SCRIPT EXIT trap，跟 bug-lock.sh
// release 同一個 shell 呼叫序列裡執行：
//   bun post-run-demand.ts "$1" "$EC"    ($1=ticket, $EC=timeout/bun 那行的結束碼)
//
// 這裡只是安全網：run-demand-pipeline.ts 本身的 try/finally 幾乎涵蓋了全部
// 正常路徑（含拋例外時的 unexpected-error 分支），都會呼叫
// demand-finalize.ts 的分類邏輯配合 demand-monitor-writes.ts 的
// writeDemandOutcomeAuthoritative() 寫下真正的結構化終態（W2，tier 2）。這裡
// 只補「run-demand-pipeline.ts 這個行程本身被 timeout/SIGKILL 中途打斷、
// 完全沒機會跑到 finally」這一種情況：
//   - exitCode===0（正常結束）→ 什麼都不寫，finalize() 已經是權威來源。
//   - exitCode===124（GNU timeout 逾時砍掉）→ 'timeout'。
//   - 其餘非 0 → 'infra_failure'（分類語意比照 classify-result.ts:83-84 的
//     既有慣例，demand 沒有 stdout JSON 可解析，只能靠 exit code）。
// 即使 finalize() 已經寫過更精確的結構化值，W2 的守衛
// （outcome IS NULL OR outcome_tier < 2）保證這裡的補寫不會覆蓋它
// （guarded_terminal，先到先定）。
//
// run_id 來源：MON_RUN_ID 環境變數。spawn-demand-pipeline.ts 在 spawn 當下
// 用 `{ MON_RUN_ID: runId }` 顯式覆寫子行程環境；trap 跟
// run-demand-pipeline.ts 是同一個 bash shell（不是 subshell），直接繼承
// 同一份環境，不需要另外查 DB／讀 active-pipeline marker 檔。
import { isMonitorDbEnabled } from '../monitor-db/env.ts'
import { writeDemandOutcomeAuthoritative } from './demand-monitor-writes.ts'

export function classifyTrapExitCode(exitCode: number): 'timeout' | 'infra_failure' | null {
  if (exitCode === 0) return null
  if (exitCode === 124) return 'timeout'
  return 'infra_failure'
}

async function main(): Promise<void> {
  const [ticket, exitCodeRaw] = process.argv.slice(2)
  if (!ticket || exitCodeRaw === undefined) return
  if (!isMonitorDbEnabled()) return

  const runId = (process.env.MON_RUN_ID ?? '').trim()
  if (!runId) return // 拿不到 run_id：沒有可寫的列身分，交給 §6.6 本機 sweeper 兜底

  const exitCode = Number(exitCodeRaw)
  if (!Number.isInteger(exitCode)) return
  const outcome = classifyTrapExitCode(exitCode)
  if (!outcome) return // exitCode===0：finalize() 是權威來源，這裡不補寫

  await writeDemandOutcomeAuthoritative(
    { runId, ticket, outcome, outcomeSource: 'post-run-demand-trap', finishedAt: new Date().toISOString(), exitCode },
    { writerName: 'post-run-demand' },
  )
}

if (import.meta.main) {
  main()
}
