// lib/monitor-db/counters.ts — §6.3 四個計數器的「可讀面」（行程內 registry）。
//
// 缺口背景：§6.3 規定每次寫入的三態判定要分類到四個計數器
// （`guarded_terminal` / `guarded_rank` / `provisional_superseded` /
// `r1_violation`），其中 **`r1_violation` 必須恆為 0，非零即 ERROR + TG 告警**
// （§6.8(f)）。`writes.ts` 已經正確算出 `WriteOutcome.guardedReason`
// （見 `classifyRunsColdPathW1` 等冷路徑診斷 SELECT），但**沒有任何呼叫端接住
// 那個回傳值**——分類結果算完就被丟掉，§6.8(f) 的告警沒有資料來源。
// 本檔就是那個最小的接住點：寫入點 +1、`health-monitor` 讀。
//
// **刻意的範圍限制（誠實記錄，不假裝是完整方案）**：
//   1. **只有行程內語意**。計數存在記憶體 Map，行程重啟即歸零，也不跨行程
//      聚合。§6.8(f) 的告警掛在 head 的 `server.ts`（health-monitor 所在行程），
//      而 `runs` 的熱路徑寫入正是走同一個行程的 `dispatchMonitorWrite()`
//      ——對「head 自己違反 R1」這個要偵測的情境，行程內計數是足夠的。
//   2. **記錄點只有 `runtime.ts` 的兩個派送函式**（`dispatchMonitorWrite` 與
//      `tryWriteOrSpool`）。這兩點涵蓋 `runs` / `agent_runs` 的全部 pipeline
//      寫入者（長駐 + 短命），也就是 `r1_violation` 唯一可能的來源。
//      **未涵蓋**：`apply-entry.ts` 的 spool 重放路徑、collectors 直接呼叫
//      `writes.ts` 的路徑。要涵蓋它們得改那兩個檔案的每一個呼叫點，成本高於
//      本工項的收益，且那些路徑本身不會產生 `r1_violation`
//      （重放發生在寫入者自己那台機器上，`MON_HOST` 一致）。
//   3. **不落地、不持久化**。§6.3 說「計數器寫進 `logs/monitor-db.log`，由
//      `doctor-monitor.sh` 輸出」——那一半屬於 doctor 的工項，不在本檔範圍。
//      本檔只提供 in-process 的讀取面。

import type { GuardedReason, WriteOutcome } from './types.ts'

/**
 * §6.3 的計數器名稱。四個守衛分類（`GuardedReason`）＋ `provisional_superseded`
 * （BL-C1 修法生效的觀察指標）＋ 兩個成功態（`inserted` / `applied`，讓
 * `r1_violation` 的分母看得見，不是孤立的一個數字）。
 */
export type MonitorCounterName = GuardedReason | 'provisional_superseded' | 'inserted' | 'applied'

const counters = new Map<MonitorCounterName, number>()

export function bumpMonitorCounter(name: MonitorCounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
}

export function getMonitorCounter(name: MonitorCounterName): number {
  return counters.get(name) ?? 0
}

/** 目前所有非零計數（供 health-monitor 的告警訊息與日後 doctor 輸出使用）。 */
export function readMonitorCounters(): Record<string, number> {
  return Object.fromEntries([...counters.entries()].filter(([, v]) => v > 0))
}

function isWriteOutcome(value: unknown): value is WriteOutcome {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'inserted' || kind === 'applied' || kind === 'guarded'
}

/**
 * 記一次寫入結果。輸入刻意是 `unknown`——記錄點是
 * `dispatchMonitorWrite`／`tryWriteOrSpool`，它們的 `call`/`attempt` 回傳型別是
 * `Promise<unknown>`（那兩支對「寫的是哪張表」是無感的）。不是 `WriteOutcome`
 * 形狀的值一律靜默忽略，不猜、不拋——計數失敗絕不能影響寫入路徑本身。
 */
export function noteWriteOutcome(value: unknown): void {
  if (!isWriteOutcome(value)) return
  if (value.kind === 'guarded') {
    bumpMonitorCounter(value.guardedReason ?? 'guarded_other')
    return
  }
  bumpMonitorCounter(value.kind)
  if (value.supersededProvisional === true) bumpMonitorCounter('provisional_superseded')
}

/** 測試專用：歸零（模組級狀態跨測試檔共用同一個 bun test process）。 */
export function __resetMonitorCountersForTest(): void {
  counters.clear()
}
