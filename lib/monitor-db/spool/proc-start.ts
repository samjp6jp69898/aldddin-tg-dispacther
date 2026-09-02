// lib/monitor-db/spool/proc-start.ts
//
// pid 重用防護的唯一實作（v3.2【G:MJ-G4】§6.5(e2)）。方向永遠偏向保留檔案 /
// 不接管鎖 / 不判定已終止——三條硬規則，reaper.ts 與 replayer-lock.ts 的呼叫
// 端都不得反過來用：
//   1. 一律 LC_ALL=C ps -p <pid> -o lstart=，禁止在不帶 LC_ALL=C 的情況下解析
//      （本機預設 locale 週幾是中文，Date.parse() 吃不下——v3.2 §6.5(e2) 實測
//      K6）。
//   2. 解析失敗（非 0 退出 / 空輸出 / Date.parse 失敗）一律回 null，呼叫端把
//      null 當成「不知道，視為仍存活」處理（fail-closed）。
//   3. 秒級截斷的比較用嚴格不等式（呼叫端的事，這裡只負責回傳解析值）。
//
// 必須在非 HTTP handler 的上下文呼叫（重放者/回收器的 tick，不是 webhook
// handler）——tg-monitor/lib/ingest.ts:99-103 的既有禁令針對的是 handler 內
// 同步 spawn；這裡的呼叫端固定是長駐行程既有的週期 timer，不受該禁令限制。

import { execFileSync } from 'node:child_process'

/**
 * pid 是否存活。ESRCH → false；其餘任何錯誤（含 EPERM、/bin/ps 找不到等）一律
 * 視為「無法確定死活」→ 回 true（fail-closed，寧可多留一輪，不誤判死亡）。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code !== 'ESRCH'
  }
}

/**
 * 回傳行程啟動時刻（epoch ms，秒級解析度），無法確定時回 null。null 的語意
 * 固定為「不知道」，呼叫端一律當成「寫入者/鎖持有者仍存活」處理。
 *
 * **`TZ: ''` 是必要的，不是可省略的細節**（本輪實測發現，plan-db-as-truth-
 * v3.2.md §6.5(e2) 的偽碼已經這樣寫，這裡踩實）：`ps … -o lstart=` 印出的是
 * **本機時區**的時刻字串（例：本機 TZ 未設時走系統預設 CST/+0800，印出
 * `Wed Sep  2 13:41:56 2026`），但這個格式（無時區縮寫）餵給 `Date.parse()`
 * 時，V8 是當成 **UTC** 解析——兩邊對不上，會系統性偏差整整一個時區的秒數
 * （本機實測偏差 8 小時，見 telegram-dispatcher 分支的驗證紀錄）。強制
 * `TZ=''`（POSIX 語意等同 UTC）讓 `ps` 也印出 UTC 時刻字串，才會與
 * `Date.parse()` 的假設一致。**絕不能省略這個環境變數覆寫**，否則
 * `readProcStartMs` 在非 UTC 時區的機器上會回傳一個系統性錯誤、但語法上完全
 * 合法（不會被 `Number.isNaN` 擋下）的時刻——比直接回傳 null 更危險，因為它
 * 不會觸發任何 fail-closed 路徑，卻會讓 pid 重用判定 / 回收器 / 重放者鎖接管
 * 全部基於錯誤的時間做決策。
 */
export function readProcStartMs(pid: number): number | null {
  let out: string
  try {
    out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: '' },
      timeout: 3000,
    })
  } catch {
    return null // 非 0 退出（含 pid 不存在）也走這裡；呼叫端另以 isPidAlive 區分死活
  }
  const s = out.trim()
  if (!s) return null
  const t = Date.parse(s) // 例：'Wed Sep  2 05:41:56 2026'（TZ='' 強制輸出 UTC，與 Date.parse() 的假設一致）
  return Number.isNaN(t) ? null : t
}

/**
 * 檔名裡的 <startEpochMs> 是毫秒，`ps … lstart=` 只有秒級解析度——比較前先把
 * 毫秒基準向下取整到秒，搭配呼叫端的嚴格不等式（>）使用，讓「pid 重用行程恰
 * 好在檔名同一秒內啟動」這個邊界情況偏向「不判定為已終止」（安全方向）。
 */
export function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}
