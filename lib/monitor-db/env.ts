// lib/monitor-db/env.ts — 監控 DB 的環境旗標與本機身分常數。
//
// 依據 plan-db-as-truth-v3.md §9.0(B)（MAJOR-D1 / MAJOR-D2 的共同修法）：
//   - process.env.MON_DB_ENABLED 只有 '1' 視為開啟；未設、空字串、'0' 三種情況
//     全部視為關閉（v2 對這三種值一個字都沒定義，是本輪要補的缺口）。
//   - 呼叫端（server.ts / worker-agent.ts / tg-monitor 等，皆不在本模組所有權
//     範圍內）必須在 isMonitorDbEnabled() 為 true 時才 `await import('./lib/monitor-db/...')`
//     ——本檔本身不做 lazy import（它就是被 lazy import 的目標），但保持零副作用：
//     import 這個模組本身不得觸發任何網路 I/O 或拋出。
//
// 依據 plan-db-as-truth-v3.2.md §4.6 MJ-E1 修訂：
//   `runs` 的所有寫入函式一律不接受呼叫端傳入的 host，改由本檔的 MON_HOST 常數
//   （啟動時決定一次）供給，型別上把 host 從 writes.ts 的參數移除，SQL 層的
//   host 守衛才有意義。

/**
 * 監控 DB 功能旗標。'1' 才是開啟；未設 / '' / '0' 全部視為關閉（MAJOR-D2）。
 */
export function isMonitorDbEnabled(): boolean {
  return process.env.MON_DB_ENABLED === '1'
}

/**
 * 本機在 `runs.host` / `monitor_heartbeat.host` 等欄位裡使用的身分字串。
 *
 * - worker 行程：`worker-agent.ts` 已經有 `CLUSTER_WORKER_NAME`（見
 *   `worker-agent.ts:65`），本模組直接沿用，不另造第二個身分來源。
 * - head 行程（`server.ts` / `log-intake`）：該 env 不存在，固定為字面量 'head'
 *   （plan §11.1 修訂／§6.8(a) 的範例皆以 `(head, 'server')` 稱呼 head 自己）。
 *
 * 在模組載入時求值一次並凍結成常數：同一行程的身分在整個生命週期內不會變。
 */
export const MON_HOST: string = (process.env.CLUSTER_WORKER_NAME ?? '').trim() || 'head'

export type MonitorRole = 'mon_head' | 'mon_ui' | 'mon_exec'

export interface MonitorConnectionEnv {
  host: string
  port: number
  schema: string
  user: string
  password: string
}

/**
 * 讀取本機 `.env` 內的監控 DB 連線設定。
 *
 * 依 MAJOR-F9 的裁定，每一台機器的 `.env` 只會有「該機器該用的那一個帳號」的
 * `MON_DB_USER` / `MON_DB_PASSWORD`（head 是 mon_head、tg-monitor 是 mon_ui、
 * worker 是 mon_exec）——不是一份 `.env` 同時放三組密碼。`expectedRole` 存在時
 * 會斷言 `MON_DB_USER` 與呼叫端宣稱的角色一致，抓錯誤部署（例如某台機器的
 * `.env` 被複製錯）。
 */
export function loadMonitorEnv(expectedRole?: MonitorRole): MonitorConnectionEnv {
  const host = process.env.MON_DB_HOST
  const portRaw = process.env.MON_DB_PORT
  const schema = process.env.MON_DB_SCHEMA
  const user = process.env.MON_DB_USER
  const password = process.env.MON_DB_PASSWORD

  const missing: string[] = []
  if (!host) missing.push('MON_DB_HOST')
  if (!portRaw) missing.push('MON_DB_PORT')
  if (!schema) missing.push('MON_DB_SCHEMA')
  if (!user) missing.push('MON_DB_USER')
  if (!password) missing.push('MON_DB_PASSWORD')
  if (missing.length > 0) {
    throw new Error(`loadMonitorEnv: 缺少必要環境變數：${missing.join(', ')}`)
  }

  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`loadMonitorEnv: MON_DB_PORT 不是合法埠號：${portRaw}`)
  }

  if (expectedRole && user !== expectedRole) {
    throw new Error(
      `loadMonitorEnv: 角色不符——呼叫端要求 '${expectedRole}'，但 .env 的 MON_DB_USER 是 '${user}'。` +
        `這通常代表 .env 被複製到錯的機器，或呼叫端角色寫錯。`,
    )
  }

  return { host: host as string, port, schema: schema as string, user: user as string, password: password as string }
}
