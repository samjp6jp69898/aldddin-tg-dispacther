// lib/monitor-db/check-worker-heartbeat.ts — 一次性 CLI：查某台 worker 的
// `monitor_heartbeat`（writer='worker-agent'）距今幾秒，供
// launchd/tunnel-watchdog.sh 判斷反向 SSH tunnel 是否卡死。
//
// 2026-09-09（ALDREQ-812 事故後續，使用者核准）：今天的根因是 head 對某台
// worker 的反向 tunnel（monitor-tunnel.<worker>）進入「TCP port 還在 accept、
// 但實際查詢會卡住/失敗」的半死狀態——這種狀態從 worker 自己的行程內部看
// 不出來（它自己的 pool 也卡住，heartbeat 寫入本身就會失敗、落 spool），
// 必須從 head 這端用「head 直連 DB 讀 worker 的 heartbeat 新不新鮮」來判斷，
// 因為 heartbeat 能不能準時進到 DB，取決於同一條 tunnel 通不通——這正是
// worker 端唯一可觀測、而且 head 讀得到的訊號（跟
// plan-db-as-truth-v3.1.md MAJOR-F4(3) 提過的 doctor 檢查同一個思路：
// 「tunnel 不通但 heartbeat 仍在更新」才是異常；這裡反過來用「heartbeat 沒
// 更新」當 tunnel 不通的證據，同一組因果關係)。
//
// head 自己的 DB 連線走本機直連（不經任何 tunnel），今天實測穩定，可以放心
// 當作判斷基準。「新鮮/過期」的門檻值刻意不在這裡判斷——只吐原始秒數，門檻
// 交給呼叫端（tunnel-watchdog.sh）的單一常數決定，之後要調門檻不用改這支。
//
// 用法：bun check-worker-heartbeat.ts <worker-name>
// 輸出（單行，供 bash 解析，永遠 exit 0——查詢本身失敗不代表 tunnel 有問題，
// 交由呼叫端決定怎麼處理「不知道」這個狀態，不猜）：
//   AGE_SECONDS <n>     心跳存在，距今 n 秒（n 可能是 0 或極小的負值，時鐘
//                       誤差已 clamp 成 0，不代表 tunnel 有問題）
//   NO_ROW              這台 worker 從沒寫過心跳（可能還沒部署完成）
//   DB_ERROR <message>  head 自己查詢就失敗（罕見：head 本機 DB 有問題）——
//                       這不是 tunnel 的證據，呼叫端不應據此判定 tunnel 掛了
import { createMonitorPool } from './pool.ts'

/** `dateStrings:['DATE','DATETIME']`（見 pool.ts）讓 mysql2 回傳
 * `YYYY-MM-DD HH:MM:SS.mmm` 這種空格分隔、無時區標記的字串（容器固定存
 * UTC，見 pool.ts 檔頭）——不是合法 ISO 8601，`new Date()` 直接吃不保證每個
 * 引擎都解得出來。轉成 `T` 分隔＋補 `Z` 才是嚴格 ISO 字串。 */
export function mysqlDatetimeToIso(v: string): string {
  return `${v.replace(' ', 'T')}Z`
}

async function main(): Promise<void> {
  const worker = process.argv[2]
  if (!worker) {
    console.log('DB_ERROR missing worker-name argument')
    return
  }

  let pool: ReturnType<typeof createMonitorPool> | undefined
  try {
    pool = createMonitorPool('mon_head', { connectionLimit: 1 })
    const [rows] = await pool.execute('SELECT ts FROM monitor_heartbeat WHERE host = ? AND writer = ?', [worker, 'worker-agent'])
    const row = (rows as Array<{ ts: string }>)[0]
    if (!row) {
      console.log('NO_ROW')
      return
    }
    const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(mysqlDatetimeToIso(row.ts)).getTime()) / 1000))
    console.log(`AGE_SECONDS ${ageSeconds}`)
  } catch (err) {
    console.log(`DB_ERROR ${String(err).replace(/\s+/g, ' ')}`)
  } finally {
    if (pool) await pool.end().catch(() => {})
  }
}

if (import.meta.main) {
  main()
}
