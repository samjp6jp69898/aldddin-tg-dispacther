// lib/pipeline-runner/demand-monitor-writes.ts
//
// demand pipeline 專屬的監控 DB 寫入 plumbing。分兩塊：
//   1. run_id 鑄造／繼承讀取（純函式，spawn-demand-pipeline.ts 用來鑄
//      DemandPayload.runId／retryOfRunId）。
//   2. 短命 CLI 行程（run-demand-pipeline.ts 的 finalize()、trap 側的
//      post-run-demand.ts）各自獨立的 W2 權威寫入——各自一次性 pool/spool，
//      用完即收（§6.7：短命行程要 await，預算 3 秒，逾時落 spool，退出前
//      flush＝關閉 spool 檔＋結束 pool 連線）。
//
// 長駐行程（spawn-demand-pipeline.ts 跑在 head server／worker-agent 裡）的
// 熱路徑寫入**不**在本檔——那條路徑複用 lib/monitor-db/runtime.ts 匯出的
// `dispatchMonitorWrite()`（全案唯一的長駐行程 pool／spool 單例，§4.6
// G:MN-G7；整合修補批次 item 7 前物理上長在 spawn-create-mr.ts，現已收斂
// 進 runtime.ts，spawn-create-mr.ts 改為重新匯出），與 bug pipeline 共用
// 同一份基礎設施，不另建第二個 mon_head/mon_exec pool，見
// spawn-demand-pipeline.ts 檔頭註解。
//
// 依據：
//   - plan-db-as-truth-v3.md §5.2 run_id 鑄造：鑄造機＝執行機，spawn 時
//     鑄造；spawn 前先讀 process.env.MON_RUN_ID，非空即寫進新列的
//     retry_of_run_id（血緣）。
//   - §6.7 熱路徑時間預算（短命行程段落）。
//   - MON_RUN_ID 走 env 不走 argv：spawn-demand-pipeline.ts 用
//     `{ MON_RUN_ID: runId }` 覆寫子行程環境；WRAPPER_SCRIPT 的 EXIT trap
//     與 run-demand-pipeline.ts 同一個 bash shell，直接繼承同一份環境，
//     post-run-demand.ts 因此不需要另外查 DB／讀 marker 檔就能拿到 run_id。
//
// 全部函式一律先過 isMonitorDbEnabled() 短路；未開時不 import 任何
// lib/monitor-db/pool.ts、writes.ts、spool/* 模組、不建立任何連線——
// lazy import（依 env.ts 檔頭的呼叫端規範）。env.ts 本身零副作用，
// 可以安全地在檔案頂層 import（它自己的檔頭註解明講這一點）。
import type { Pool } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { declareMonitorRoleFromLocalEnv, isMonitorDbEnabled } from '../monitor-db/env.ts'
import type { SpoolWriterHandle } from '../monitor-db/spool/writer.ts'
import { monitorRoleForThisHost, SHORT_LIVED_WRITE_BUDGET_MS, tryWriteOrSpool } from '../monitor-db/runtime.ts'

// 整合修補批次 item 7：短命行程「預算內嘗試寫入，逾時/失敗落 spool」核心邏輯
// 已收斂進 lib/monitor-db/runtime.ts（post-run-notify.ts 的同型重複邏輯改為
// 複用同一份），這裡重新匯出沿用舊名，行為不變。
export { tryWriteOrSpool }
const SHORT_LIVED_BUDGET_MS = SHORT_LIVED_WRITE_BUDGET_MS // §6.7：短命行程總預算

/** spawn 時鑄造新 run_id（§5.2：鑄造機＝執行機，spawn 當下鑄造）。 */
export function mintRunId(): string {
  return randomUUID()
}

/**
 * spawn 前讀繼承的 run_id 作為血緣（§5.2）。demand pipeline 目前沒有既有的
 * auto-retry 觸發者（stale-lock-reaper 只重試 bug pipeline，見該檔案），
 * 這裡仍照通用規則讀取——為未來擴充預留，讀取成本為零，也不改變今天的
 * 實際行為（今天恆為 null）。
 */
export function readInheritedRunId(): string | null {
  const v = (process.env.MON_RUN_ID ?? '').trim()
  return v || null
}

// ── 短命行程（run-demand-pipeline.ts／post-run-demand.ts 各自獨立 CLI）───
// 要 await，總預算 3 秒，逾時落 spool 後退出；退出前一律 flush（關閉 spool
// 檔＋結束 pool 連線）。每次呼叫各自建立、各自收尾，行程本來就是一次性的。

export interface WriteDemandOutcomeAuthoritativeInput {
  runId: string
  ticket: string
  outcome: string
  outcomeSource: string
  finishedAt: string
  exitCode?: number | null
}

/**
 * W2：demand 結構化終態的權威寫入。給 run-demand-pipeline.ts 的 finalize()
 * （結構化 DemandOutcome → demandOutcomeToRunsOutcome() 映射值）與
 * post-run-demand.ts（trap 側、exit code 分類）共用，各自傳自己的
 * writer 身分（spool 檔各自獨立，互不干擾）。
 *
 * 全程 best-effort：任何一步失敗（含建 pool/spool 本身失敗）只記 log，
 * 絕不拋出——不能讓監控寫入失敗連坐拖垮 demand pipeline 的主流程收尾。
 */
export async function writeDemandOutcomeAuthoritative(
  input: WriteDemandOutcomeAuthoritativeInput,
  opts: { writerName: 'cli' | 'post-run-demand' },
): Promise<void> {
  if (!isMonitorDbEnabled()) return
  let pool: Pool | undefined
  let spool: SpoolWriterHandle | undefined
  try {
    // 2026-09-04 修正（ALDREQ-834 事故：見 env.ts declareMonitorRoleFromLocalEnv
    // 註解）：本函式的兩個實際呼叫端（post-run-demand.ts 的 trap 側、
    // run-demand-pipeline.ts 的 finalize()）不是固定只在 head 機器上跑——
    // lib/cluster/dispatch.ts 的派工機制對 bug/demand 用同一套機制，兩種票
    // 都可能被派去 worker 執行。在這裡（本函式是兩者共用、實際觸發
    // monitor-db 讀寫的最早執行點）依本機 `.env` 的 MON_DB_USER 宣告對應
    // 角色，不用猜。放在 try 內：本函式的「全程 best-effort、絕不拋出」承諾
    // 涵蓋這一步（呼叫端 post-run-demand.ts 沒有自己的 try/catch，靠的正是
    // 這裡的保證）。
    declareMonitorRoleFromLocalEnv()
    const { createMonitorPool } = await import('../monitor-db/pool.ts')
    const { createSpoolWriter } = await import('../monitor-db/spool/writer.ts')
    const { writeRunOutcomeAuthoritative } = await import('../monitor-db/writes.ts')
    pool = createMonitorPool(monitorRoleForThisHost(), { connectionLimit: 1 })
    spool = createSpoolWriter({ writer: opts.writerName })
    const args = {
      runId: input.runId,
      ticket: input.ticket,
      kind: 'demand' as const,
      outcome: input.outcome,
      outcomeSource: input.outcomeSource,
      finishedAt: input.finishedAt,
      exitCode: input.exitCode ?? null,
    }
    await tryWriteOrSpool({
      budgetMs: SHORT_LIVED_BUDGET_MS,
      pool,
      spool,
      runId: input.runId,
      fn: 'writeRunOutcomeAuthoritative',
      args: [args],
      attempt: p => writeRunOutcomeAuthoritative(p, args),
      onFailLabel: `W2 demand outcome（${opts.writerName}）`,
    })
  } catch (err) {
    console.error(`demand-monitor-writes: writeDemandOutcomeAuthoritative 建立連線/spool 失敗（run_id=${input.runId}）: ${err}`)
  } finally {
    if (spool) {
      try {
        spool.close()
      } catch (err) {
        console.error(`demand-monitor-writes: spool.close() 失敗: ${err}`)
      }
    }
    if (pool) {
      try {
        await pool.end()
      } catch (err) {
        console.error(`demand-monitor-writes: pool.end() 失敗: ${err}`)
      }
    }
  }
}
