// lib/monitor-db/runtime.ts — 長駐行程監控 DB 寫入的單一共用模組（整合修補
// 批次 item 7）。
//
// 背景：2A（bug pipeline，spawn-create-mr.ts）與 2B（demand pipeline，
// demand-monitor-writes.ts）在各自檔案內各自實作了一份「長駐行程 pool／spool
// 單例 + 逾時落 spool」的邏輯（後者的檔頭註解已明說「長駐行程的熱路徑寫入不
// 在本檔——複用 spawn-create-mr.ts 匯出的 dispatchMonitorWrite()」，只是那份
// 實作物理上仍長在 spawn-create-mr.ts 裡，不是一個獨立、與 pipeline 種類無關
// 的共用模組）；demand-monitor-writes.ts 另有一份「短命 CLI 行程」用的
// tryWriteOrSpool，post-run-notify.ts（bug pipeline 的短命 CLI 對應者）則是
// inline 實作同一種邏輯，兩者也是一對重複。兩位負責人都在回報中把這件事標記
// 為「整合期任務」（見兩檔各自檔頭）。本檔把兩組（長駐、短命）各自收斂成
// 單一實作，spawn-create-mr.ts / demand-monitor-writes.ts / post-run-notify.ts
// 改為 import，行為不變。
import { getDeclaredMonitorRole, isMonitorDbEnabled, MON_HOST, type MonitorRole } from './env.ts'
import { createSpoolWriter, type SpoolWriterHandle } from './spool/writer.ts'
import type { MonitorDbExecutor } from './writes.ts'

/**
 * 是否為 worker 行程。2026-09-02 熱修：優先看 env.ts 的顯式宣告（見
 * `declareMonitorRole()`）；只有從未宣告過的呼叫端（短命 CLI／未升級呼叫端／
 * 測試）才退回舊的 `CLUSTER_WORKER_NAME` 環境變數嗅探——長駐進入點
 * （server.ts/worker-agent.ts）一旦宣告，就不再受這個變數的任何殘留污染。
 */
export function isWorkerProcess(): boolean {
  const declared = getDeclaredMonitorRole()
  if (declared !== null) return declared === 'mon_exec'
  return !!(process.env.CLUSTER_WORKER_NAME ?? '').trim()
}

export function monitorRoleForThisHost(): MonitorRole {
  return isWorkerProcess() ? 'mon_exec' : 'mon_head'
}

// ─────────────────────────────────────────────────────────────────────────
// 長駐行程：pool／spool 單例 + fire-and-forget 派送（原 spawn-create-mr.ts
// 的 dispatchMonitorWrite 全套，行為逐位元組相同）。
// ─────────────────────────────────────────────────────────────────────────

const LONG_LIVED_WRITE_TIMEOUT_MS = 1000

let monitorPoolPromise: Promise<MonitorDbExecutor | null> | null = null
let monitorPoolOverride: MonitorDbExecutor | null | undefined
let monitorSpoolWriter: SpoolWriterHandle | null = null
// spool writer 覆寫刻意不接受 null——「spool 完全不可用」這個情境用一個
// .append() 會丟例外的假 handle 模擬即可（dispatchMonitorWrite 的
// fallbackToSpool 本來就有 try/catch），不需要在型別上放行 null 這個永遠
// 回不出 SpoolWriterHandle 的狀態。
let monitorSpoolWriterOverride: SpoolWriterHandle | undefined

/**
 * 測試專用：直接注入假 pool/spool writer，跳過真的 createMonitorPool（真的
 * mysql2 連線）與 createSpoolWriter（真的 fs 檔案）。`pool` 傳 `null` 模擬
 * 「連線失敗」（走 spool 落地路徑）。不含在 `overrides` 裡的 key 維持原狀
 * （呼叫端要清除覆寫、回到正常的 lazy 單例邏輯，請呼叫 `__resetMonitorTestOverrides()`）。
 * 模組級單例跨測試檔共用（同一個 bun test process），每個測試檔用完務必
 * reset，避免污染其他測試檔。
 */
export function __setMonitorTestOverrides(overrides: { pool?: MonitorDbExecutor | null; spool?: SpoolWriterHandle }): void {
  if ('pool' in overrides) {
    monitorPoolOverride = overrides.pool
    monitorPoolPromise = null
  }
  if ('spool' in overrides) {
    monitorSpoolWriterOverride = overrides.spool
    monitorSpoolWriter = null
  }
}

/** 測試專用：清除 __setMonitorTestOverrides 設過的覆寫，回到正常的 lazy 單例邏輯。 */
export function __resetMonitorTestOverrides(): void {
  monitorPoolOverride = undefined
  monitorPoolPromise = null
  monitorSpoolWriterOverride = undefined
  monitorSpoolWriter = null
}

export function getLongLivedMonitorPool(): Promise<MonitorDbExecutor | null> {
  if (monitorPoolOverride !== undefined) return Promise.resolve(monitorPoolOverride)
  if (!isMonitorDbEnabled()) return Promise.resolve(null)
  if (!monitorPoolPromise) {
    monitorPoolPromise = (async () => {
      try {
        const { createMonitorPool } = await import('./pool.ts')
        return createMonitorPool(isWorkerProcess() ? 'mon_exec' : 'mon_head', { connectionLimit: isWorkerProcess() ? 3 : 8 })
      } catch (err) {
        console.error(`monitor-db: 建立連線池失敗（isMonitorDbEnabled=true 但連線失敗，本輪寫入將落 spool）: ${err}`)
        return null
      }
    })()
  }
  return monitorPoolPromise
}

export function getLongLivedMonitorSpoolWriter(): SpoolWriterHandle {
  if (monitorSpoolWriterOverride !== undefined) return monitorSpoolWriterOverride
  if (!monitorSpoolWriter) {
    monitorSpoolWriter = createSpoolWriter({ writer: isWorkerProcess() ? 'worker-agent' : 'server' })
  }
  return monitorSpoolWriter
}

/**
 * 非阻斷派送一次監控 DB 寫入：`call(pool)` 在 1000ms 預算內完成才算數，逾時或
 * 任何失敗（含 pool 建立失敗）一律落 spool（§6.5 硬規則：`run_id` 在寫入
 * 當下就必須是確定值，`input.runId` 由呼叫端保證）。`fn` 是 spool 條目的具名
 * 函式標籤，對應 `lib/monitor-db/writes.ts` 匯出的同名函式，重放者以
 * `writesFn(pool, entry.args[0])` 的形式呼叫（`args` 固定是單元素陣列，元素
 * 就是 `input` 本身）。呼叫端永遠不 await 這個函式——回傳 `Promise<void>`
 * 只是為了讓測試能確定性地等它跑完（`await`），不是要呼叫端真的接住它；
 * production 呼叫點一律不接回傳值。
 */
export function dispatchMonitorWrite<A extends { runId: string }>(fn: string, input: A, call: (pool: MonitorDbExecutor) => Promise<unknown>): Promise<void> {
  return (async () => {
    const enabled = isMonitorDbEnabled() || monitorPoolOverride !== undefined
    if (!enabled) return
    const fallbackToSpool = (reason: unknown) => {
      try {
        getLongLivedMonitorSpoolWriter().append({ ts: new Date().toISOString(), host: MON_HOST, run_id: input.runId, fn, args: [input] })
      } catch (spoolErr) {
        console.error(`monitor-db: ${fn}(run_id=${input.runId}) 寫入與落 spool 都失敗，本次寫入遺失: ${reason} / ${spoolErr}`)
      }
    }
    const pool = await getLongLivedMonitorPool()
    if (!pool) {
      fallbackToSpool('monitor pool 不可用')
      return
    }
    try {
      await Promise.race([
        call(pool),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`monitor-db 寫入逾時（${LONG_LIVED_WRITE_TIMEOUT_MS}ms）`)), LONG_LIVED_WRITE_TIMEOUT_MS)),
      ])
    } catch (err) {
      fallbackToSpool(err)
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────
// 短命行程（run-demand-pipeline.ts finalize()／post-run-demand.ts／
// post-run-notify.ts 各自獨立 CLI）：要 await，總預算 3 秒，逾時落 spool
// 後退出；退出前一律 flush（原 demand-monitor-writes.ts 的 tryWriteOrSpool，
// 行為逐位元組相同）。
// ─────────────────────────────────────────────────────────────────────────

export const SHORT_LIVED_WRITE_BUDGET_MS = 3000

/**
 * 核心「預算內嘗試寫入，逾時／失敗落 spool」邏輯，抽成獨立、可注入假
 * pool／spool 的函式（供單元測試用 FakeRunsDb + 假 spool writer 直接驗證
 * 這條邏輯，不需要真的建立 mysql2 pool／spool 檔）。
 */
export async function tryWriteOrSpool(opts: {
  budgetMs: number
  pool: MonitorDbExecutor
  spool: SpoolWriterHandle
  runId: string
  fn: string
  args: unknown[]
  attempt: (pool: MonitorDbExecutor) => Promise<unknown>
  onFailLabel: string
}): Promise<void> {
  try {
    await Promise.race([
      opts.attempt(opts.pool),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${opts.onFailLabel}: 逾時`)), opts.budgetMs)),
    ])
  } catch (err) {
    try {
      opts.spool.append({ ts: new Date().toISOString(), host: MON_HOST, run_id: opts.runId, fn: opts.fn, args: opts.args })
    } catch (spoolErr) {
      // 兩層都失敗：只記 log，不拋出（呼叫端一律 best-effort，不能讓監控寫入
      // 拖垮或中斷主流程）。最終由 §6.6 本機 sweeper 兜底暫定終態。
      console.error(`monitor-db runtime: ${opts.onFailLabel} DB 寫入與落 spool 都失敗（run_id=${opts.runId}）: db=${err} spool=${spoolErr}`)
    }
  }
}
