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

export type MonitorRole = 'mon_head' | 'mon_ui' | 'mon_exec'

/** 長駐進入點（server.ts / worker-agent.ts）可顯式宣告的角色子集——'mon_ui'
 * 是 tg-monitor 自己的獨立行程，不會呼叫 declareMonitorRole()。 */
export type DeclarableMonitorRole = 'mon_head' | 'mon_exec'

let declaredRole: DeclarableMonitorRole | null = null

/**
 * 本機在 `runs.host` / `monitor_heartbeat.host` 等欄位裡使用的身分字串。
 *
 * 2026-09-02 熱修事故（Bug 2）：舊版無條件用
 * `process.env.CLUSTER_WORKER_NAME` 是否非空來嗅探角色/host——head 的 `.env`
 * 一旦殘留這個變數（不管什麼原因），head 就會被誤判成 worker，MON_HOST 也
 * 會被寫成別台機器的名字，`runs.host` 的 R1 host 守衛因此可能整個錯位。
 * 修法：改成「未宣告時維持舊嗅探行為（相容短命 CLI 行程／未升級呼叫端／
 * 測試——它們本來就沒有 declareMonitorRole() 可呼叫，只能靠環境變數認出
 * 自己在哪台機器）；一旦進入點呼叫 declareMonitorRole()，一律以宣告值為準，
 * 完全不再看這個環境變數」。
 *
 * `let`（非 `const`）：declareMonitorRole() 呼叫時原地覆寫，ESM 的 live
 * binding 保證所有已經 `import { MON_HOST }` 的呼叫端在下一次讀取時都拿到
 * 新值——不需要改任何消費端的 import 或用法。
 */
export let MON_HOST: string = (process.env.CLUSTER_WORKER_NAME ?? '').trim() || 'head'

/**
 * 進入點顯式宣告本行程的監控 DB 角色。必須在任何觸發 monitor-db 讀寫的程式
 * 碼路徑之前呼叫一次（server.ts / worker-agent.ts 在檔案頂層、import 完成
 * 後立刻呼叫）——之後 `MON_HOST` 與 `isWorkerProcess()`（runtime.ts）一律
 * 用宣告值，不再嗅探 `CLUSTER_WORKER_NAME`。
 *
 * `role='mon_exec'` 才讀 `CLUSTER_WORKER_NAME` 並驗非空（worker 本來就得靠
 * 這個變數自報身分，沒有其他來源）；`role='mon_head'` 固定 `MON_HOST='head'`，
 * 完全不看這個變數——這正是杜絕「head .env 殘留 CLUSTER_WORKER_NAME」污染
 * 的結構性隔離。
 */
export function declareMonitorRole(role: DeclarableMonitorRole): void {
  if (declaredRole !== null && declaredRole !== role) {
    throw new Error(`declareMonitorRole: 本行程已宣告過角色 '${declaredRole}'，不可再宣告成 '${role}'（同一行程只能宣告一次）`)
  }
  declaredRole = role
  if (role === 'mon_exec') {
    const raw = (process.env.CLUSTER_WORKER_NAME ?? '').trim()
    if (!raw) {
      throw new Error("declareMonitorRole: role='mon_exec' 但 process.env.CLUSTER_WORKER_NAME 未設定或空白")
    }
    MON_HOST = raw
  } else {
    MON_HOST = 'head'
  }
}

/** 目前已宣告的角色；未呼叫過 declareMonitorRole() 時回 null（短命 CLI／
 * 測試／tg-monitor 等不宣告的呼叫端）。供 runtime.ts 的 isWorkerProcess()
 * 與 doctor-monitor.sh 的角色檢查使用。 */
export function getDeclaredMonitorRole(): DeclarableMonitorRole | null {
  return declaredRole
}

/** 測試專用：重置宣告狀態與 MON_HOST，回到「嗅探環境變數」的預設行為。 */
export function __resetDeclaredMonitorRoleForTest(): void {
  declaredRole = null
  MON_HOST = (process.env.CLUSTER_WORKER_NAME ?? '').trim() || 'head'
}

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
