// lib/log-shipper/mount.ts — 把 shipper.ts 的 `runOneCycle()` 掛成常駐迴圈。
//
// shipper.ts 是純 library，檔頭明訂「行程掛載點（setInterval、head 掛
// log-intake、worker 掛 worker-agent）由整合批次落地，本模組只提供
// runOneCycle()，不含任何 sleep/setInterval/自旋重試」。本檔就是那個掛載點，
// head 與 worker 共用——兩邊差異只有 sink 與來源檔清單，由呼叫端注入。
//
// 週期用 shipper.ts 既有的 LOG_SHIP_INTERVAL_MS（【G:MN-G9】head/worker 同值
// 5 秒），不另立常數：那個值與 MAX_BATCHES_PER_CYCLE 的乘積被 shipper.test.ts
// 的純算術測試釘住在每 worker 60 req/min 額度內，改這裡等於偷偷繞過那條測試。
// setInterval 是週期性排程器，不是拿等待去規避競態（硬規則允許的那一類）。
//
// ── 三個結構性選擇 ──────────────────────────────────────────────────────────
// 1. **游標還原失敗就不啟動**：restoreCursorsFromDb 回 null 代表「問不到」，
//    此時不能拿空游標開跑（那會把 151MB 歷史重送一次）。改為本輪跳過、下一輪
//    再試，直到還原成功才建立 shipper。見 cursor-restore.ts 檔頭。
// 2. **re-entrancy 守衛**：一輪還沒跑完就不開下一輪。5 秒的 tick 遇上慢 sink
//    或大批次會疊起來，疊起來的兩輪共用同一份記憶體游標會互相覆寫。
// 3. **永不外拋**：任何失敗只 WARN。log shipping 是觀測面，不該讓它把
//    log-intake 或 worker-agent 這兩個常駐服務拖掛（比照 heartbeat.ts 的處置）。

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isMonitorDbEnabled, MON_HOST } from '../monitor-db/env.ts'
import { getLongLivedMonitorPool } from '../monitor-db/runtime.ts'
import { restoreCursorsFromDb } from './cursor-restore.ts'
import { createLogShipper, LOG_SHIP_INTERVAL_MS, type LogShipper } from './shipper.ts'
import type { LogSink } from './types.ts'

export interface LogShipperMountDeps {
  /** 只用於 log 訊息前綴，例如 'log-intake' / 'worker-agent'。 */
  label: string
  /** 本輪要 tail 的絕對路徑清單。 */
  listSourceFiles: () => Promise<string[]> | string[]
  /**
   * 建立 sink；設定不全（例如 head 缺 MON_VL_*）時回 null＝不啟動，
   * 並且**要自己印出原因**——回 null 卻沒有任何輸出，就是一個沒有觀察者的失敗。
   */
  createSink: () => LogSink | null
}

export interface LogShipperMountHandle {
  stop(): void
  /** 供測試確定性地跑一輪，不用等 timer。production 呼叫端不用它。 */
  tickOnce(): Promise<void>
}

const NOOP_HANDLE: LogShipperMountHandle = { stop() {}, async tickOnce() {} }

export function startLogShipperLoop(
  deps: LogShipperMountDeps,
  tickMs = LOG_SHIP_INTERVAL_MS,
): LogShipperMountHandle {
  if (!isMonitorDbEnabled()) return NOOP_HANDLE

  const maybeSink = deps.createSink()
  if (maybeSink === null) return NOOP_HANDLE
  // 重新綁定成非 null 型別：模組層的 null check 不會流進下面 closure 的型別
  // 收斂（同 worker-agent.ts:71 的既有處置）。
  const sink: LogSink = maybeSink

  let shipper: LogShipper | null = null
  let running = false
  let restoreWarned = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      if (shipper === null) {
        const pool = await getLongLivedMonitorPool()
        if (pool === null) return
        // host 用 MON_HOST：與 shipper.ts 寫 file_offsets 時的預設 host 同源，
        // 兩邊若不同源就會「用 A 的 key 寫、用 B 的 key 讀」，永遠還原不到自己的游標。
        const cursors = await restoreCursorsFromDb(pool, MON_HOST)
        if (cursors === null) {
          if (!restoreWarned) {
            console.error(`${deps.label}: log-shipper 游標還原失敗，本輪不啟動（下一輪重試；只印這一次）`)
            restoreWarned = true
          }
          return
        }
        restoreWarned = false
        shipper = createLogShipper({
          listSourceFiles: deps.listSourceFiles,
          sink,
          executor: pool,
          initialCursors: cursors,
        })
        console.error(`${deps.label}: log-shipper 已掛載，還原 ${Object.keys(cursors).length} 個游標，每 ${tickMs}ms 一輪`)
      }

      const r = await shipper.runOneCycle()
      if (r.aborted) {
        console.error(`${deps.label}: log-shipper 本輪中止（${r.abortReason} @ ${r.abortedPath ?? '?'}），offset 未推進，下一輪重送`)
      }
    } catch (err) {
      console.error(`${deps.label}: log-shipper 迴圈例外（不影響本行程）：${String(err)}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), tickMs)
  return {
    stop() {
      clearInterval(timer)
    },
    tickOnce: tick,
  }
}

/** 比照 lib/cluster/cluster-head.ts 等既有檔的慣例，絕對路徑寫死。 */
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'

/**
 * head 與 worker 共用的來源清單：`logs/` 底下的 `*.log`。
 *
 * **刻意不含 aladdin_mcps 各子專案 logs 目錄下的 audit jsonl**（1d 2026-09-03 裁定，選項 a）。
 * shipper.ts 檔頭原本把 audit jsonl 列為 head 的來源之一，但那批路徑已經有
 * 另一個 `upsertFileOffset` 寫入端——`lib/monitor-db/collectors/audit-ingester.ts`。
 * `file_offsets` 主鍵是 `(host, path)`，沒有欄位能區分兩個游標；兩邊的 `offset`
 * 語意還不同（一個是「已解析進 mcp_usage」、一個是「已送進 VictoriaLogs」），
 * 而守衛 `event_seq <` 的兩個計數器來自不同行程、值域重疊。互相覆寫的後果不是
 * 重複而是**缺口**：audit-ingester 的游標被蓋成較大的值就會跳過尚未解析的稽核
 * 記錄，而且不會有任何東西叫。稽核內容本來就由 audit-ingester 落進 mcp_usage，
 * 不是沒有去處。要納入 VL 需先解決游標命名空間（migration 或 path 前綴），
 * 不由本工項夾帶。
 */
export function listDispatcherLogFiles(): string[] {
  try {
    return readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => join(LOG_DIR, f))
      .sort()
  } catch (err) {
    console.error(`log-shipper: 讀取 ${LOG_DIR} 失敗，本輪來源清單為空：${String(err)}`)
    return []
  }
}
