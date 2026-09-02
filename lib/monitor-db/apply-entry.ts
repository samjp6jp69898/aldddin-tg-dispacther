// lib/monitor-db/apply-entry.ts — spool 重放分派器（整合修補批次，接進
// lib/monitor-db/spool/replayer.ts 與 replay-dead.ts 預留的 thin interface：
// `applyEntry(entry: SpoolEntry): Promise<{ ok: boolean; reason?: string }>`。
//
// 兩份 spool 消費者（replayer.ts 的週期重放、replay-dead.ts 的 dead-letter
// 再攝入）都不知道「fn 字串該怎麼呼叫」——那是本模組的職責：按 `entry.fn`
// 路由到 writes.ts 對應的具名函式，`entry.args[0]` 就是該函式第二個參數
// （見 dispatchMonitorWrite / tryWriteOrSpool 落 spool 時的 `args: [input]`
// 慣例，spawn-create-mr.ts / demand-monitor-writes.ts / tg-monitor 的
// mon-db.ts 皆同一約定）。
//
// 重放冪等性完全靠 writes.ts 各函式自身的守衛語意（守衛式 UPDATE / ODKU
// COALESCE / status_rank 單調），本檔不做任何額外的去重或狀態追蹤——同一條
// 目重放任意次數，結果都相同。
import type { MonitorDbExecutor } from './writes.ts'
import type { ReplayDeps } from './spool/replayer.ts'
import type { DeadReplayDeps } from './spool/replay-dead.ts'
import {
  advanceDispatchAttempt,
  createDispatchAttempt,
  fixCancelLateOutcome,
  insertMcpUsage,
  insertStatusLogRow,
  insertTgUnknownSender,
  supersedeOtherDispatchAttempts,
  upsertAgentRun,
  upsertFileOffset,
  upsertMonitorHeartbeat,
  writeCancelFlag,
  writeRunOutcomeAuthoritative,
  writeRunOutcomeProvisional,
  writeRunProgress,
  type StatusLogTable,
} from './writes.ts'

export interface ApplyEntryLike {
  fn: string
  args: unknown[]
}

export interface ApplyEntryResult {
  ok: boolean
  reason?: string
}

/**
 * 按 `entry.fn` 路由到 writes.ts 的具名寫入函式。涵蓋全套 §6.2 具名寫入函式
 * （整合修補批次 item 2 明列：writeRunProgress / writeRunOutcomeAuthoritative /
 * writeRunOutcomeProvisional / writeCancelFlag / dispatch_attempts 三支 /
 * heartbeat / file_offsets；額外收 agent_runs 與 append-only 三張表，
 * 讓分派器對「§6.2 全部具名寫入函式」窮舉，不需要下一個 writer 出現時
 * 再回頭補一個 case）。未知的 `fn` 不拋例外——回 `{ok:false}` 讓呼叫端
 * （replayer 的 dead-letter 計數 / replay-dead 的 remaining）依既有語意處理，
 * 一條壞條目不該讓整個重放迴圈中斷。
 */
export async function applyEntry(pool: MonitorDbExecutor, entry: ApplyEntryLike): Promise<ApplyEntryResult> {
  try {
    const input = entry.args[0]
    switch (entry.fn) {
      case 'writeRunProgress':
        await writeRunProgress(pool, input as Parameters<typeof writeRunProgress>[1])
        return { ok: true }
      case 'writeRunOutcomeAuthoritative':
        await writeRunOutcomeAuthoritative(pool, input as Parameters<typeof writeRunOutcomeAuthoritative>[1])
        return { ok: true }
      case 'writeRunOutcomeProvisional':
        await writeRunOutcomeProvisional(pool, input as Parameters<typeof writeRunOutcomeProvisional>[1])
        return { ok: true }
      case 'writeCancelFlag':
        await writeCancelFlag(pool, input as Parameters<typeof writeCancelFlag>[1])
        return { ok: true }
      case 'fixCancelLateOutcome':
        // 唯一第二參數是純字串（runId）而非物件的具名函式，args 慣例仍是
        // `[input]`，這裡的 input 就是那個字串。
        await fixCancelLateOutcome(pool, input as string)
        return { ok: true }
      case 'createDispatchAttempt':
        await createDispatchAttempt(pool, input as Parameters<typeof createDispatchAttempt>[1])
        return { ok: true }
      case 'advanceDispatchAttempt':
        await advanceDispatchAttempt(pool, input as Parameters<typeof advanceDispatchAttempt>[1])
        return { ok: true }
      case 'supersedeOtherDispatchAttempts':
        await supersedeOtherDispatchAttempts(pool, input as Parameters<typeof supersedeOtherDispatchAttempts>[1])
        return { ok: true }
      case 'upsertMonitorHeartbeat':
        await upsertMonitorHeartbeat(pool, input as Parameters<typeof upsertMonitorHeartbeat>[1])
        return { ok: true }
      case 'upsertFileOffset':
        await upsertFileOffset(pool, input as Parameters<typeof upsertFileOffset>[1])
        return { ok: true }
      case 'upsertAgentRun':
        await upsertAgentRun(pool, input as Parameters<typeof upsertAgentRun>[1])
        return { ok: true }
      case 'insertMcpUsage':
        await insertMcpUsage(pool, input as Parameters<typeof insertMcpUsage>[1])
        return { ok: true }
      case 'insertTgUnknownSender':
        await insertTgUnknownSender(pool, input as Parameters<typeof insertTgUnknownSender>[1])
        return { ok: true }
      case 'insertStatusLogRow': {
        // insertStatusLogRow(pool, table, columns, values) 是三參數函式，
        // args 慣例包不進單一物件，呼叫端落 spool 時把後三個位置參數包成
        // 一個 tuple：args: [[table, columns, values]]（見本檔匯出的
        // `packStatusLogArgs` 供呼叫端使用，保持約定單一入口）。
        const [table, columns, values] = input as [StatusLogTable, string[], unknown[]]
        await insertStatusLogRow(pool, table, columns, values)
        return { ok: true }
      }
      default:
        return { ok: false, reason: `apply-entry: 未知的 fn：${entry.fn}` }
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 供 insertStatusLogRow 的呼叫端組出符合上面 case 'insertStatusLogRow' 約定的 args。 */
export function packStatusLogArgs(table: StatusLogTable, columns: string[], values: unknown[]): [[StatusLogTable, string[], unknown[]]] {
  return [[table, columns, values]]
}

const DB_REACHABLE_BUDGET_MS = 1000

/**
 * §6.5(g)：重放者每輪先跑一次 SELECT 1（1000ms 上界）。逾時／失敗一律回
 * false（連不上 ≠ 失敗，只是還沒輪到——由呼叫端 replayOnce 整輪跳過，不動
 * 游標、不加任何 attempts）。
 */
export async function isMonitorDbReachable(pool: MonitorDbExecutor): Promise<boolean> {
  try {
    await Promise.race([
      pool.execute('SELECT 1'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('SELECT 1 逾時')), DB_REACHABLE_BUDGET_MS)),
    ])
    return true
  } catch {
    return false
  }
}

/**
 * production 接線：把本檔的 applyEntry 綁上真正的 pool，滿足 replayer.ts
 * `ReplayDeps` 的 thin interface（該檔檔頭註解：「由 lib/monitor-db/writes.ts
 * 提供，尚未存在」——本函式就是那個「提供」）。呼叫端（server.ts /
 * worker-agent.ts 的週期 timer）只需要 `createReplayDeps(pool)` 就能直接餵給
 * `replayOnce(dir, deps)` / `drainAll(dir, deps)`。
 */
export function createReplayDeps(pool: MonitorDbExecutor, opts: { now?: () => number } = {}): ReplayDeps {
  return {
    isDbReachable: () => isMonitorDbReachable(pool),
    applyEntry: entry => applyEntry(pool, entry),
    now: opts.now,
  }
}

/** 同上，供 replay-dead.ts 的 `replayDeadFile(filePath, deps)` 使用
 * （deploy/monitor-db/replay-dead.sh 的整合入口，CLI 逐一呼叫）。 */
export function createDeadReplayDeps(pool: MonitorDbExecutor): DeadReplayDeps {
  return { applyEntry: entry => applyEntry(pool, entry) }
}
