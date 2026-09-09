// lib/monitor-db/deadline.ts — 長駐行程單次 DB 查詢的逾時預算（§6.7）。
//
// 計畫 plan-db-as-truth-v3.md §6.7 逐字：「writer 的 mysql2 pool：
// `connectTimeout: 500`、`enableKeepAlive: true`、`waitForConnections: false`，
// **每次查詢外層 `Promise.race` 一個 1000ms deadline**，逾時即 `destroy()` 該
// 連線並落 spool。」
// `lib/monitor-db/pool.ts:37-38` 把這件事明確指派給呼叫端：「`connectTimeout: 500`
// 只約束建立連線，不涵蓋單一 query 卡住的情況……那是呼叫端的責任」。
//
// 2026-09-09（ALDREQ-812 事故、使用者核准偏離上面這條 §6.7 逐字值）：
// `connectTimeout` 已從 500ms 放寬到 3000ms（見 pool.ts 該常數旁的完整說明）
// ——worker 連 DB 全部經反向 SSH tunnel，天生比同機直連多一段 RTT，500ms
// 在 tunnel 場景下太容易把「其實連得上、只是慢一點」誤判成「連不上」而白白
// 落 spool。本檔這支「單次查詢 1000ms deadline」維持不變，未受影響——建立
// 連線與查詢執行是兩段各自獨立的計時，互不共用預算。
//
// 為什麼需要一支共用函式：`runtime.ts` 的 `dispatchMonitorWrite` 內嵌了一份
// 同語意的 `Promise.race`，但 collectors／heartbeat 的**對位 SELECT 與非
// dispatch 路徑的寫入**是裸 await（2026-09-02 對抗性審查 B1）。失敗情境是
// head → mon-mysql 的 SSH tunnel 半開（TCP 已建立、對端不再回應）：連線早已
// 在 pool 裡，`connectTimeout` 不生效，query 永不 resolve ⇒ 呼叫端的 catch
// 永遠不執行，既不 WARN 也不落 spool，正是本案要消滅的「靜默失敗」。
//
// **`destroy()` 那一半的誠實聲明**：本模組只做得到 deadline，做不到「逾時即
// destroy 該連線」——`writes.ts` 全部經 `MonitorDbExecutor.execute()`（結構上
// 相容 mysql2 `Pool`）發查詢，連線由 pool 內部取得與歸還，呼叫端手上**沒有
// `PoolConnection` 可以 destroy**。要做到那一半必須把所有寫入函式改成收
// connection（`writes.ts` 既有簽名不得更動）。既有的 `dispatchMonitorWrite`
// 也是同一個處境（只 race、不 destroy），本模組維持同一慣例，不自創第二種。
// 卡住的連線最終由 `waitForConnections: false` + `connectionLimit` 收斂：
// 池子被卡滿之後 `execute()` 會立刻失敗，之後每一次呼叫都會走進 spool 路徑。

/** §6.7 逐字：1000ms。與 `runtime.ts` 的 `LONG_LIVED_WRITE_TIMEOUT_MS` 同值同語意。 */
export const MONITOR_QUERY_DEADLINE_MS = 1000

export class MonitorQueryTimeoutError extends Error {
  constructor(label: string, budgetMs: number) {
    super(`monitor-db 查詢逾時（${label}，${budgetMs}ms）`)
    this.name = 'MonitorQueryTimeoutError'
  }
}

/**
 * 對單一 DB 操作套上 deadline：`op()` 沒有在預算內 settle 就 reject
 * `MonitorQueryTimeoutError`，由呼叫端接住並走各自的 WARN + spool／skip 路徑。
 *
 * 逾時後底層的 promise 仍在跑（無法取消，見上方 destroy 聲明）——這是刻意
 * 接受的：它最終不是成功（結果被丟棄、無副作用問題，寫入都是冪等的守衛式
 * SQL）就是連線被 pool 收掉。重點是**呼叫端一定會在 1000ms 內拿回控制權**。
 *
 * timer 一律在 settle 後 clear，不留下讓行程無法退出的 pending timer。
 */
export async function withMonitorDeadline<T>(
  label: string,
  op: () => Promise<T>,
  budgetMs: number = MONITOR_QUERY_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MonitorQueryTimeoutError(label, budgetMs)), budgetMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
