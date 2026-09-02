// lib/cluster/worker-monitor-status.ts — head 端記憶體中的「worker 監控狀態」表
// （plan-db-as-truth-v3.2.md MJ-E4 ＝ MAJOR-F6，§6.8(e)）。
//
// 為什麼是主動回報而不是輪詢：v3 §6.8(e) 原本要把 `{spool_depth, oldest_age_s,
// db_writable}` 塞進 worker 的 `GET /health`，但那是 worker 上**唯一不驗證**的
// 路由（`worker-agent.ts:153`），把運維狀態放進去等於對任何 LAN 上的人公開；
// 而且 v3 「head 本來就每輪打 /health」是事實錯誤——telegram-dispatcher 內
// 沒有任何東西打 worker 的 `/health`。MJ-E4 的裁定：`/health` 一個字不改，
// 改由 worker-agent 每 60 秒主動 `postToHead('/cluster/monitor-status', …)`
// （帶 `x-cluster-token`，走既有認證通道），head 存記憶體，由
// `health-monitor` 的 60 秒 timer 判斷告警。
//
// 為什麼是獨立小檔而不是塞進 cluster-head.ts：寫入者是 `cluster-head.ts` 的
// route，讀取者是 `lib/monitor-db/alerts.ts`（health-monitor 用）。讓 alerts.ts
// 去 import cluster-head.ts 會把整條派工 wiring（dispatcher / sweeper /
// spawn-* / notify）拖進 health-monitor 的 import 圖，也會製造迴圈風險。
// 這張表只是一個 Map，獨立成檔是最小的解耦。
//
// 狀態刻意**不持久化**：head 重啟後表是空的，由各 worker 下一輪（≤60 秒）
// 回報自然填回。空表對告警的語意是「不知道」而不是「正常」——見 alerts.ts
// 對「回報缺席」的處置（寬限期內沉默，寬限期後 WARN 級「未知」，不是 ERROR）。

export interface WorkerMonitorStatus {
  worker: string
  /** worker 本機 spool 未 ack 條目數；回報值不可信（缺欄／型別不對）時 null。 */
  spoolDepth: number | null
  /** worker 本機 spool 最舊未 ack 條目的年齡（秒）。 */
  oldestAgeS: number | null
  /** worker 上一拍 `monitor_heartbeat` 是否真的寫進 DB。 */
  dbWritable: boolean | null
  /** head 收到這筆回報的時刻（epoch ms）——由 head 蓋章，不信任 worker 自報時間。 */
  receivedAt: number
}

const statuses = new Map<string, WorkerMonitorStatus>()

/** 只收有限的數值，其餘（NaN / Infinity / 負數 / 非數字）一律收斂成 null。 */
function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 記一筆 worker 回報。`worker` 的格式驗證由呼叫端（route）負責——本模組不做
 * HTTP 層的事。`receivedAt` 一律由本機時鐘蓋章。
 */
export function recordWorkerMonitorStatus(
  worker: string,
  body: { spool_depth?: unknown; oldest_age_s?: unknown; db_writable?: unknown },
  now: number = Date.now(),
): WorkerMonitorStatus {
  const entry: WorkerMonitorStatus = {
    worker,
    spoolDepth: finiteNonNegative(body.spool_depth),
    oldestAgeS: finiteNonNegative(body.oldest_age_s),
    dbWritable: typeof body.db_writable === 'boolean' ? body.db_writable : null,
    receivedAt: now,
  }
  statuses.set(worker, entry)
  return entry
}

export function getWorkerMonitorStatus(worker: string): WorkerMonitorStatus | null {
  return statuses.get(worker) ?? null
}

export function listWorkerMonitorStatuses(): WorkerMonitorStatus[] {
  return [...statuses.values()]
}

/** 測試專用：清空（模組級狀態跨測試檔共用同一個 bun test process）。 */
export function __resetWorkerMonitorStatusesForTest(): void {
  statuses.clear()
}
