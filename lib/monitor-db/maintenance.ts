// lib/monitor-db/maintenance.ts — 長駐行程的監控 DB 週期維護（整合修補批次
// item 2 + item 8，BL-C5 落地件）。
//
// 兩個獨立的接線點：
//   startMonitorMaintenance() — 週期 setInterval tick：同一 tick 內先重放
//     spool（§6.5(d) 單一重放者 + §6.5(e) 回收器，接上 apply-entry.ts 的
//     production applyEntry），再跑 §6.6 本機 sweeper（「同一 tick 內先重放
//     spool，再跑 sweeper」是降噪、非正確性依據）。
//   runRestartSweep(seen) — 只在啟動時呼叫一次：§5.6 lost_on_restart，
//     `seen` 是 recoverFromDisk() 三組 run_id 陣列的聯集。
//
// head（server.ts）與 worker（worker-agent.ts）各自呼叫一次：spool 目錄與
// 重放者身分（writer='server'｜'worker-agent'）都是本機路徑，天然互不干擾，
// 不需要跨機協調。isMonitorDbEnabled()=false 時兩個函式都是 no-op（不建
// timer、不連 DB），行為與遷移前相同。
import { isMonitorDbEnabled } from './env.ts'
import { getLongLivedMonitorPool, isWorkerProcess } from './runtime.ts'
import { createReplayDeps } from './apply-entry.ts'
import { replayOnce } from './spool/replayer.ts'
import { reclaimSpoolFiles } from './spool/reaper.ts'
import { acquireReplayerLock, releaseReplayerLock } from './spool/replayer-lock.ts'
import { SPOOL_DIR } from './spool/types.ts'
import { defaultIsPidAlive, sweepDeadLocalRuns, sweepLostOnRestart } from './local-sweep.ts'

/** 沒有計畫明文規定的固定值——比照長駐行程既有的週期排程器慣例
 * （心跳 60 秒、tunnel 健康檢查 60 秒）取一個同量級、足夠即時又不過度打
 * DB 的間隔。 */
export const MONITOR_MAINTENANCE_TICK_MS = 30_000

export interface MonitorMaintenanceOpts {
  /** local-activity 三合一（lib/cluster/local-activity.ts 的
   * LocalActivity.isActive），§6.6 sweeper 的第二層判定要用；呼叫端傳入
   * 自己已經建好的實例，本模組不重建一份。 */
  isTicketActive: (ticket: string) => boolean
  /** 本機是否有這個 run_id 的待重放 spool 條目（§6.6 降噪跳過條件）；
   * 不提供時視同永遠沒有。 */
  hasPendingSpoolEntry?: (runId: string) => boolean
}

export interface MonitorMaintenanceHandle {
  stop(): void
}

/**
 * 啟動週期維護 tick。isMonitorDbEnabled()=false 時整段是 no-op（回傳一個
 * stop() 什麼也不做的 handle），連 setInterval 都不建。
 */
export function startMonitorMaintenance(opts: MonitorMaintenanceOpts): MonitorMaintenanceHandle {
  if (!isMonitorDbEnabled()) return { stop() {} }

  const writer = isWorkerProcess() ? 'worker-agent' : 'server'
  const lock = acquireReplayerLock(SPOOL_DIR, writer)
  if (!lock.ok) {
    // §6.5(d)：已有另一個活著的重放者——絕不搶鎖，本行程只做 sweep（sweep
    // 不受「單一重放者」不變式約束，本來就允許多行程各自掃自己的 running 列，
    // 因為 sweeper 的寫入目標是 W3 守衛式 UPDATE，天生冪等且互不衝突）。
    console.error(`monitor-db maintenance: 取得 .replayer.lock 失敗（${lock.reason}）——本行程不重放 spool，只跑本機 sweeper`)
  }

  async function tick(): Promise<void> {
    const pool = await getLongLivedMonitorPool()
    if (!pool) return

    if (lock.ok) {
      try {
        await replayOnce(SPOOL_DIR, createReplayDeps(pool))
      } catch (err) {
        console.error(`monitor-db maintenance: replayOnce 失敗: ${err}`)
      }
      try {
        reclaimSpoolFiles(SPOOL_DIR, { writer, pid: process.pid })
      } catch (err) {
        console.error(`monitor-db maintenance: reclaimSpoolFiles 失敗: ${err}`)
      }
    }

    try {
      await sweepDeadLocalRuns(pool, {
        isPidAlive: defaultIsPidAlive,
        isTicketActive: opts.isTicketActive,
        hasPendingSpoolEntry: opts.hasPendingSpoolEntry,
      })
    } catch (err) {
      console.error(`monitor-db maintenance: sweepDeadLocalRuns 失敗: ${err}`)
    }
  }

  const timer = setInterval(() => void tick(), MONITOR_MAINTENANCE_TICK_MS)
  return {
    stop() {
      clearInterval(timer)
      if (lock.ok) releaseReplayerLock(SPOOL_DIR, process.pid)
    },
  }
}

/**
 * §5.6：一次性重啟 sweep，只在啟動時呼叫（不是週期 tick 的一部分——它跟
 * recoverFromDisk() 的 seen 集合綁在一起，只有那一刻的快照有意義）。
 */
export async function runRestartSweep(seen: ReadonlySet<string>): Promise<void> {
  if (!isMonitorDbEnabled()) return
  const pool = await getLongLivedMonitorPool()
  if (!pool) {
    console.error('monitor-db maintenance: lost_on_restart sweep 略過（監控 DB pool 不可用）')
    return
  }
  try {
    const result = await sweepLostOnRestart(pool, seen)
    if (result.swept.length > 0) {
      console.error(`monitor-db maintenance: lost_on_restart sweep 收掉 ${result.swept.length} 筆（${result.swept.map(s => s.ticket).join(', ')}）`)
    }
  } catch (err) {
    console.error(`monitor-db maintenance: lost_on_restart sweep 失敗: ${err}`)
  }
}
