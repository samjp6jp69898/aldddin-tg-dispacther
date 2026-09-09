// lib/monitor-db/pool.ts — 全案唯一的 mysql2 createPool() 呼叫點。
//
// 【G:MN-G7】任何行程、任何角色、任何連線數的 pool 一律由本檔的
// `createMonitorPool()` 建立，禁止任何檔案自行呼叫 `mysql2.createPool`——
// 否則同一份 writes.ts 在兩個 pool 上會有兩種 affectedRows 語意（有沒有關掉
// CLIENT_FOUND_ROWS）。Phase 1 的靜態測試斷言全 repo `createPool(` 的出現
// 次數恰好 1（就是這一行）。
//
// mysql2 版本【G:MN-G3】pin 死在 3.18.0（package.json 精確版本，不加 ^/~）：
// `flags:['-FOUND_ROWS']` 的語法（見下方）與 ResultSetHeader.info 的存在性都
// 是版本相依行為，本輪只驗證過這一版。
import { createPool, type Pool } from 'mysql2/promise'
import { loadMonitorEnv, type MonitorRole } from './env.ts'

export interface CreateMonitorPoolOptions {
  /** 【G:MN-G10】呼叫端必須明示連線數，不吃 mysql2 的預設 10。 */
  connectionLimit: number
}

/**
 * 建立監控 DB 的 mysql2 連線池。
 *
 * 依據 plan-db-as-truth-v3.2.md §4.6（裁定 2）：
 *   - `flags: ['-FOUND_ROWS']`：明確「移除」mysql2 預設就開啟的
 *     CLIENT_FOUND_ROWS（本輪讀 mysql2 3.18.0 原始碼確認：
 *     `connection_config.js:224-249 getDefaultFlags()` 的 defaultFlags 內含
 *     'FOUND_ROWS'；`:204-221 mergeFlags()` 對每個 default flag，若
 *     user_flags 內含 `-<FLAG>` 就 continue，不 OR 進去——`-FOUND_ROWS` 是
 *     mysql2 支援的「移除預設 flag」語法，不是無效字串）。
 *     關掉之後：形狀 A（ODKU）的 affectedRows 恢復 0/1/2 三值語意
 *     （0 = 命中但被設成現值）；形狀 B（守衛式 UPDATE）改讀
 *     `ResultSetHeader.info` 的 `Rows matched: X  Changed: Y`，不依賴
 *     affectedRows。兩者互不衝突，見 §6.3。
 *   - `timezone: 'Z'` + `dateStrings: ['DATE','DATETIME']`：容器以
 *     `--default-time-zone=+00:00` 存 UTC，client 端也一律當 UTC 處理，
 *     時間欄一律以 ISO 字串往返（S7/S11）。
 *   - `connectTimeout`：只約束建立連線，不涵蓋單一 query 卡住的情況
 *     （見 §6.7／§6.4(2) 的 Promise.race 說明，那是呼叫端的責任）。
 *     §6.7 原文寫的是 500ms；2026-09-09（ALDREQ-812 事故、使用者核准）放寬到
 *     3000ms——worker 連 DB 全部要經反向 SSH tunnel（見
 *     launchd/run-monitor-tunnel.sh），比起同機直連天生多一段 RTT／tunnel
 *     channel 建立的開銷，實測 head 直連穩定在個位數 ms，但 tunnel 那端偶爾
 *     真的在 500ms 內連得上、只是卡在 550～2000ms 之間，跟這裡就會被誤判成
 *     「連不上」而不必要地落 spool。3000ms 仍遠低於下面 §6.7 查詢逾時的
 *     1000ms 預算之外的獨立階段（建立連線與跑查詢是兩段不同的計時，互不影
 *     響對方的預算），也遠低於「pipeline 熱路徑不能被卡住」的容忍上限（背景
 *     pipeline 本身的逾時是分鐘級）。
 *   - `enableKeepAlive: true`、`waitForConnections: false`：pool 耗盡時立即
 *     失敗，不排隊等待（§6.7 熱路徑非阻斷紀律的一部分——這條原則不受上面的
 *     connectTimeout 放寬影響，pool 滿了一樣立刻失敗，不會排隊）。
 */
export function createMonitorPool(role: MonitorRole, opts: CreateMonitorPoolOptions): Pool {
  const env = loadMonitorEnv(role)
  return createPool({
    host: env.host,
    port: env.port,
    database: env.schema,
    user: env.user,
    password: env.password,
    timezone: 'Z',
    dateStrings: ['DATE', 'DATETIME'],
    // 見上方檔頭說明：明確移除 mysql2 預設開啟的 CLIENT_FOUND_ROWS。
    flags: ['-FOUND_ROWS'],
    connectTimeout: 3000,
    enableKeepAlive: true,
    waitForConnections: false,
    connectionLimit: opts.connectionLimit,
  })
}
