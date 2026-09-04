// lib/monitor-db/heartbeat.ts — 長駐行程的 `monitor_heartbeat` 週期心跳（§6.8）。
//
// 缺口背景（2026-09-02 flag=1 實機驗證）：`writes.ts` 的
// `upsertMonitorHeartbeat()` 早就就緒，但**沒有任何生產呼叫者**，
// `monitor_heartbeat` 表恆空——§6.8(1)(2) 的「啟動自檢 + 每 60 秒心跳」與
// §6.8 的「head 自己 DB 不可寫」告警因此全部失效（doctor 看到的是一張空表，
// 分不出「行程死了」與「從來沒人寫過」）。本檔補上這個唯一的呼叫者。
//
// 規格：
//   - §6.8(2)：長駐行程每 60 秒 upsert 一次，形狀 B，守衛
//     `WHERE host=? AND writer=? AND ts < ?`（重放舊心跳不會把時間推回過去）。
//   - §6.8(1)：啟動時也寫一次（本檔在 start 當下立刻打第一拍，不等第一個
//     tick——否則行程啟動後的第一分鐘在 DB 上與「沒啟動」無法區分）。
//   - migration 002：PK 是 `(host, writer)`，`writer` 值域
//     `server | worker-agent | tg-monitor | log-intake`——head 上三個監控寫入
//     行程各自一列，任一行程死掉都看得出來。
//   - 失敗只 WARN + 落 spool（`run_id: null`，屬 2026-09-02 裁定的 per-fn
//     允許清單，見 spool/writer.ts 的 `RUN_SCOPED_SPOOL_FNS`），**絕不影響
//     宿主行程**：本檔任何路徑都不 throw。
//   - 全部在 `isMonitorDbEnabled()` 之後：flag 關閉時連 timer 都不建、不取
//     pool、不碰 `logs/spool/`。
//
// pool／spool 的取得（【G:MN-G7】pool 歸屬表）：
//   - `server` / `worker-agent`：共用 runtime.ts 既有的長駐單例
//     （head=mon_head 8 條、worker=mon_exec 3 條），**不另開連線池**。
//   - `log-intake`：該行程本來就沒有任何 monitor pool，依 pool 歸屬表自己一個
//     `mon_head` / `connectionLimit: 2` 的池，spool 身分是 `log-intake`
//     （runtime.ts 的單例身分只會是 server|worker-agent，對這個行程是錯的）。
//     兩者都 lazy——只有 flag 開啟且真的要寫入時才建立。
import { isMonitorDbEnabled, MON_HOST } from './env.ts'
import { withMonitorDeadline } from './deadline.ts'
import { getLongLivedMonitorPool, getLongLivedMonitorSpoolWriter } from './runtime.ts'
import { upsertMonitorHeartbeat, type MonitorDbExecutor } from './writes.ts'
import { readSpoolStatsForHeartbeat } from './spool/depth.ts'
import { createSpoolWriter, type SpoolWriterHandle } from './spool/writer.ts'
import type { MonitorHeartbeatWriter } from './types.ts'

/** §6.8(2) 逐字：每 60 秒。 */
export const MONITOR_HEARTBEAT_TICK_MS = 60_000

/** log-intake 專屬池的連線數（v3.2【G:MN-G7】pool 歸屬表：mon_head / 2）。 */
const LOG_INTAKE_CONNECTION_LIMIT = 2

export interface MonitorHeartbeatDeps {
  writer: MonitorHeartbeatWriter
  /** 覆寫 executor 取得方式（測試用；不給就依 writer 走上面的預設規則）。 */
  getExecutor?: () => Promise<MonitorDbExecutor | null>
  /** 覆寫 spool 取得方式（測試用）。刻意是函式：不到真的要落 spool 不開檔。 */
  getSpool?: () => SpoolWriterHandle
  /** `spool_depth` / `spool_oldest_ts` 兩個觀察欄的來源；不給就寫 NULL（見下）。 */
  spoolStats?: () => { depth: number | null; oldestTs: string | null }
  /** 單次查詢的逾時預算（§6.7，預設 1000ms）。測試注入小值以確定性驗證逾時路徑。 */
  queryBudgetMs?: number
  now?: () => number
}

export type HeartbeatResult = 'written' | 'spooled' | 'lost' | 'disabled'

// 本行程各 writer 最近一拍的結果。唯一消費者是 worker-agent 的
// `/cluster/monitor-status` 主動回報（§6.8(e) / MJ-E4）——它要回報的
// `db_writable` 就是「上一拍心跳有沒有真的寫進 DB」，這是本行程手上唯一
// 不需要**額外**打一次 DB 就能得到的答案（再打一次 SELECT 1 只是多一個
// 網路來回，且回答的還是不同的問題：可讀 ≠ 可寫）。
const lastResults = new Map<MonitorHeartbeatWriter, HeartbeatResult>()

/** 本行程該 writer 最近一拍的心跳結果；還沒打過任何一拍回 null。 */
export function getLastHeartbeatResult(writer: MonitorHeartbeatWriter): HeartbeatResult | null {
  return lastResults.get(writer) ?? null
}

/** 測試專用：清掉上面那張表（模組級狀態跨測試檔共用同一個 bun test process）。 */
export function __resetLastHeartbeatResultsForTest(): void {
  lastResults.clear()
}


/**
 * 打一拍心跳。**永不 throw**——回傳值只供測試與觀察。
 *
 * `spool_depth` / `spool_oldest_ts`：`beatOnce()` 本身沒有注入 `spoolStats` 時
 * 一律寫 NULL（保持這支函式對檔案系統零依賴，測試才能完全確定性）。
 * production 的三個長駐行程不會走到這條路——`startMonitorHeartbeat()` 會補上
 * `spool/depth.ts` 的讀取器當預設值（見該函式）。那支讀取器就是這段註解原本
 * 說的「獨立工項」：§6.8(b) 定義的「未 ack 位元組換算條目數」現在有公開 API 了。
 */
export async function beatOnce(deps: MonitorHeartbeatDeps): Promise<HeartbeatResult> {
  if (!isMonitorDbEnabled()) return 'disabled'
  const record = (r: HeartbeatResult): HeartbeatResult => {
    lastResults.set(deps.writer, r)
    return r
  }
  const now = deps.now ?? Date.now
  // §6.5(a) 硬規則：時間一律是寫入當下算好的絕對 ISO 字串，不留給重放時求值。
  const ts = new Date(now()).toISOString()
  const stats = safeSpoolStats(deps)
  const input = { writer: deps.writer, ts, spoolDepth: stats.depth, spoolOldestTs: stats.oldestTs }

  let pool: MonitorDbExecutor | null = null
  try {
    pool = await resolveExecutor(deps)
  } catch (err) {
    console.error(`monitor-db heartbeat(${deps.writer}): 取得連線池失敗: ${err}`)
    pool = null
  }

  if (pool) {
    try {
      // §6.7：單次查詢一律套 1000ms deadline。沒有這一層時，tunnel 半開造成
      // 的「query 永不 resolve」會讓下面的 catch 永遠不執行——這一拍既不 WARN
      // 也不落 spool，正是本模組要消滅的靜默失敗（對抗性審查 B1）。
      const target = pool
      await withMonitorDeadline(`upsertMonitorHeartbeat(${deps.writer})`, () => upsertMonitorHeartbeat(target, input), deps.queryBudgetMs)
      return record('written')
    } catch (err) {
      console.error(`monitor-db heartbeat(${deps.writer}): 寫入失敗，改落 spool: ${err}`)
    }
  } else {
    console.error(`monitor-db heartbeat(${deps.writer}): 連線池不可用，改落 spool`)
  }

  try {
    resolveSpool(deps).append({ ts, host: MON_HOST, run_id: null, fn: 'upsertMonitorHeartbeat', args: [input] })
    return record('spooled')
  } catch (spoolErr) {
    // 兩層都失敗：只記錄，絕不外拋（心跳失敗不得影響宿主行程）。
    console.error(`monitor-db heartbeat(${deps.writer}): 落 spool 也失敗，本拍遺失: ${spoolErr}`)
    return record('lost')
  }
}

function safeSpoolStats(deps: MonitorHeartbeatDeps): { depth: number | null; oldestTs: string | null } {
  if (!deps.spoolStats) return { depth: null, oldestTs: null }
  try {
    return deps.spoolStats()
  } catch {
    return { depth: null, oldestTs: null }
  }
}

let logIntakePool: MonitorDbExecutor | null = null
let logIntakeSpool: SpoolWriterHandle | null = null

async function resolveExecutor(deps: MonitorHeartbeatDeps): Promise<MonitorDbExecutor | null> {
  if (deps.getExecutor) return deps.getExecutor()
  if (deps.writer !== 'log-intake') return getLongLivedMonitorPool()
  if (!logIntakePool) {
    const { createMonitorPool } = await import('./pool.ts')
    logIntakePool = createMonitorPool('mon_head', { connectionLimit: LOG_INTAKE_CONNECTION_LIMIT })
  }
  return logIntakePool
}

function resolveSpool(deps: MonitorHeartbeatDeps): SpoolWriterHandle {
  if (deps.getSpool) return deps.getSpool()
  if (deps.writer !== 'log-intake') return getLongLivedMonitorSpoolWriter()
  // writer.ts 的 import 本身無副作用（開檔發生在 createSpoolWriter 被呼叫時），
  // 所以只需要延後「呼叫」這一步，不需要動態 import。
  if (!logIntakeSpool) logIntakeSpool = createSpoolWriter({ writer: 'log-intake' })
  return logIntakeSpool
}

export interface MonitorHeartbeatHandle {
  stop(): void
  /** 啟動當下那一拍的 Promise（永不 reject）——production 呼叫端不接它，
   * 存在只是為了讓測試能確定性地等它跑完，不用等待時間。 */
  firstBeat: Promise<HeartbeatResult>
}

const NOOP_HANDLE: MonitorHeartbeatHandle = { stop() {}, firstBeat: Promise.resolve('disabled') }

/**
 * 掛上週期心跳。`isMonitorDbEnabled()=false` 時整段 no-op（不建 timer、不取
 * pool、不碰 spool）。啟動當下立刻打第一拍（§6.8(1) 的啟動自檢），之後每
 * 60 秒一拍。任何失敗都只 WARN，不外拋——呼叫端（server.ts / worker-agent.ts /
 * intake-server.ts）不需要 try/catch。
 *
 * **角色宣告不是本檔的責任**（總指揮 2026-09-02 裁定）：9551686 曾在這裡對
 * `log-intake` 做「未宣告才補宣告」的時序性 fail-safe；af 的 `3782873` 已在
 * `intake-server.ts` 的 module init 最前端加了顯式 `declareMonitorRole('mon_head')`
 * ——進入點顯式宣告是結構保證（先於 serve 與任何 monitor 引用），比繫於
 * 「heartbeat 有沒有先跑」的時序更強。條件補宣告若長期保留，反而會**遮蔽
 * 「進入點忘了宣告」這個缺陷**，裁定改為 fail-loud：沒宣告就讓 `MON_HOST`
 * 維持嗅探值並在資料上顯現，由 doctor／覆核抓出來，本檔不再默默代勞。
 */
export function startMonitorHeartbeat(deps: MonitorHeartbeatDeps, tickMs = MONITOR_HEARTBEAT_TICK_MS): MonitorHeartbeatHandle {
  if (!isMonitorDbEnabled()) return NOOP_HANDLE

  // `spool_depth` / `spool_oldest_ts` 的預設來源（§6.8(b)）。放在這裡而不是
  // `beatOnce()` 裡：三個長駐進入點（server.ts / worker-agent.ts /
  // log-intake 的 intake-server.ts）都只呼叫這一支，一處補齊就三個行程全中，
  // 不需要動到各進入點（其中 `lib/log-shipper/` 這一輪不可改）；而
  // `beatOnce()` 維持對檔案系統零依賴，單元測試不會意外掃到真的 spool 目錄。
  const withDefaults: MonitorHeartbeatDeps = deps.spoolStats ? deps : { ...deps, spoolStats: () => readSpoolStatsForHeartbeat() }

  const firstBeat = beatOnce(withDefaults)
  const timer = setInterval(() => void beatOnce(withDefaults), tickMs)
  return {
    firstBeat,
    stop() {
      clearInterval(timer)
    },
  }
}
