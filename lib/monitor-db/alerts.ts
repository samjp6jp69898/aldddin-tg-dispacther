// lib/monitor-db/alerts.ts — §6.8(3) 的營運告警判定（a–f ＋ 追加的 g）。
//
// 背景：計畫 §6.8(3) 列了七條告警 a–g，本模組實作 **a–f**；計畫原本的
// (g)「投影閘門中止」屬 §5.9 的投影閘門本身，**不在這裡**（由該閘門自己負責）。
// 本檔的 (g) 是 **2026-09-02 指揮官追加的另一條**（讀取面靜默降級），與計畫
// 原文的 (g) 是不同的東西，只是恰好也排在第七——不要混淆。
// 判定結果由 `lib/webhook-server/health-monitor.ts` 既有的 60 秒 timer 消費，
// **翻轉才發 TG 給 OPERATOR**（比照該檔既有的 tunnel／token 名冊兩套告警慣例）。
//
// 條件（v3.2 修訂後的版本，不是 v3 原文）：
//   a. head 的 `(head,'server')` 心跳列不可寫或落後 > 5 分鐘；
//      `(head,'tg-monitor')`、`(head,'log-intake')` 各一條同型告警
//      （§11.1 修訂：`monitor_heartbeat` PK 改 `(host, writer)`，三個 head
//       行程各自一列——共用一列時只要任一還活著就永遠不會告警）。
//   b. head 的 spool 深度 > 200 或最舊未 ack 條目 > 15 分鐘
//      （§6.8(b) 修訂：深度＝`logs/spool/` 全部資料檔未 ack 位元組換算的條目數
//       總和，見 spool/depth.ts）。
//   c. tunnel 不通：對名冊每台 enabled worker 跑 `ssh <worker> 'nc -z 127.0.0.1 3307'`。
//   d. 每台 enabled worker 的 `(worker,'worker-agent')` 心跳列**不存在**或
//      落後 > 5 分鐘（§6.8(d) 修訂 + MINOR-3 的 30 分鐘新機寬限期）。
//   e. 任一 worker 主動回報的 spool 深度 > 200；回報本身缺席或落後 > 5 分鐘
//      視為「未知」，WARN 級（§6.8(e) 改為主動回報，MJ-E4）。
//   f. `r1_violation` 計數器 > 0（§6.3；計數來源見 counters.ts，含其範圍限制）。
//   g. **讀取面靜默降級**（2026-09-02 指揮官追加，判準於同日更正）：tg-monitor 的
//      `GET 127.0.0.1:8799/api/read-source` 回
//      `{requested, effective, degraded, requestedValid}`；
//      **判準（總指揮終版裁定）＝三支 OR**：
//        1. `degraded === true`——tg-monitor 自報「要 mysql 卻退回 sqlite」。
//        2. `requestedValid === false`——設定值本身認不得（打錯字，被 fail-safe 吃掉）。
//        3. `normalizeReadSource(requested) !== effective`——**head 側獨立算一次
//           再對照**。前兩支都是「完全信任被監控者的自述」：`degraded` 由
//           tg-monitor `server.ts:1113` 單一處算出，那一處若算錯或漏設，告警就跟著
//           瞎掉。第三支不依賴對方任何自報旗標，補回「真降級但忘設 degraded」
//           這個盲區，而且因為比的是**正規化後**的值，不會重蹈裸字串比對的誤報。
//      **不比對裸字串 `effective !== requested`**（曾是原判準，已移除）：那會對三種
//      **健康**設定誤報——未設（`requested` 為空字串或 `null`）、大小寫不同
//      （`MySQL`）、尾隨空白（`'mysql '`）。第三支比的是正規化後的結果，這三種
//      都會得到與 `effective` 相同的值，誤報歸零。
//      **`requestedValid` 欄位不存在**（對面還是舊版、尚未部署 a4）→ 第 2 支不參與
//      判定（不誤翻轉），第 1、3 支照跑（它們不依賴這個新欄位）。
//      **端點 404／連線拒絕／逾時／回應形狀不對一律判 unknown、跳過不告警**：
//      tg-monitor 尚未載入 Phase 8 的碼之前這條端點根本不存在，不得誤翻轉。
//
// 三條紀律（全部來自本工項的硬約束）：
//   1. **整組只在 `isMonitorDbEnabled()` 為真時評估**——呼叫端負責這道閘。
//      flag=0 時 health-monitor 的行為與本次改動前逐位元組相同，(c) 也不跑
//      （它雖然探的是 tunnel，但屬於本案新增的監控面）。
//   2. **每一次 DB 讀取都套 `withMonitorDeadline`**（§6.7）。SSH 探測則自帶
//      5 秒上界、`execFile` 非同步——**絕不同步 spawn**（同步 spawn 會擋住
//      head 的 event loop，且 Bun 1.2.9 在 handler 內 spawnSync 有 segfault
//      前科，見 tg-monitor ingest.ts 檔頭）。
//   3. **任一條件評估拋錯只 WARN、不中斷其他條件**：出錯的條件從結果中
//      「省略」（不是回 tripped=false）——呼叫端據此保留該條件的前一個狀態，
//      不會把「查不到」誤翻成「已恢復」。

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { RowDataPacket } from 'mysql2/promise'
import { listWorkerMonitorStatuses, type WorkerMonitorStatus } from '../cluster/worker-monitor-status.ts'
import { getMonitorCounter } from './counters.ts'
import { withMonitorDeadline } from './deadline.ts'
import { mysqlDatetimeToIsoOrNull } from './mysql-datetime.ts'
import { getLongLivedMonitorPool } from './runtime.ts'
import { readSpoolDepth } from './spool/depth.ts'
import type { MonitorHeartbeatWriter } from './types.ts'

/** 心跳落後多久算故障（§6.8(a)(d) 逐字：5 分鐘）。 */
export const HEARTBEAT_STALE_MS = 5 * 60_000
/** spool 深度告警門檻（§6.8(b) 逐字：200 條）。 */
export const SPOOL_DEPTH_THRESHOLD = 200
/** spool 最舊條目告警門檻（§6.8(b) 逐字：15 分鐘）。 */
export const SPOOL_OLDEST_THRESHOLD_MS = 15 * 60_000
/** 新 worker 從第一次出現在名冊起的寬限期（MINOR-3 逐字：30 分鐘）。 */
export const NEW_WORKER_GRACE_MS = 30 * 60_000
/** worker 主動回報落後多久算「未知」（§6.8(e)）。 */
export const WORKER_REPORT_STALE_MS = 5 * 60_000
/** 單台 worker 的 SSH tunnel 探測上界（本工項自訂；失敗＝翻轉條件）。 */
export const SSH_PROBE_TIMEOUT_MS = 5000
/** (g) 讀取面探測的 HTTP 上界（與 SSH 探測、health-monitor 既有 fetch 同值）。 */
export const READ_SOURCE_PROBE_TIMEOUT_MS = 5000

/** tg-monitor 的讀取面自況端點（Phase 8）。只走 loopback。 */
export const READ_SOURCE_URL = 'http://127.0.0.1:8799/api/read-source'

/** head 上三個監控寫入行程，各自一條 §6.8(a) 同型告警。 */
const HEAD_WRITERS: readonly MonitorHeartbeatWriter[] = ['server', 'tg-monitor', 'log-intake']

const ROSTER_PATH = '/Users/user/aladdin/telegram-dispatcher/logs/cluster-workers.json'

/** 心跳全表很小（機器數 × writer 數），一次讀完餵給 (a) 與 (d) 兩組條件，
 * 不對每個 writer／每台 worker 各打一次 SELECT。 */
export const MONITOR_HEARTBEAT_SELECT_SQL = 'SELECT host, writer, ts FROM monitor_heartbeat'

export type AlertLevel = 'error' | 'warn'

export interface MonitorAlert {
  /** 條件的穩定識別字（呼叫端用它記「上一輪是不是也 tripped」）。 */
  key: string
  /** 條件人話名稱，恢復通知用。 */
  label: string
  tripped: boolean
  level: AlertLevel
  /** tripped 時的細節描述（會原樣進 TG 訊息，不含任何憑證）。 */
  detail: string
}

export interface HeartbeatRow {
  host: string
  writer: string
  /** 心跳時間。DB 回的可能是 Date 或字串（依 `dateStrings` 設定），兩種都收。 */
  ts: string | Date | null
}

export interface RosterWorker {
  name: string
  /** 名冊的 `url`（如 `http://10.0.0.7:8801`）。**worker 名字不是 DNS 名**——
   * (c) 的 ssh 探測 host 必須由這裡解出（MA-1：拿 name 當 ssh host 會
   * NXDOMAIN → (c) 永久 tripped 且失明），與 run-monitor-tunnel.sh /
   * sync-workers.sh 同一條解析慣例（`new URL(url).hostname`）。 */
  url: string
  registeredAt: string
  disabled: boolean
}

/** (g) `GET /api/read-source` 的回應。`null` ＝ unknown（端點不存在／打不到／
 * 形狀不對），呼叫端一律跳過不告警。 */
export interface ReadSourceStatus {
  /**
   * `MON_READ_SOURCE` 的原始字串，未經解析。**`null` ＝ 該環境變數未設定**
   * ——tg-monitor `server.ts:1107` 是 `requested: raw ?? null`，行程沒有這個
   * 變數時送出的就是 JSON `null`（launchd 經 `run-monitor.sh` 匯出時是空字串，
   * 兩種都代表「沒設」）。不可當成「回應形狀不對」而整條丟掉。
   */
  requested: string | null
  effective: string
  degraded: boolean
  /**
   * `MON_READ_SOURCE` 的設定值本身是否合法（由 tg-monitor 判定——合法值域的權威
   * 在它那邊）。**`null` ＝ 回應裡沒有這個欄位**，代表對面還是舊版（a4 之前），
   * 此時只以 `degraded` 判定，不得因為「讀不到這個欄位」就翻轉。
   */
  requestedValid: boolean | null
}

export interface MonitorAlertDeps {
  now?: () => number
  /** 讀 `monitor_heartbeat` 全表；拋例外＝DB 不可讀（(a) 三條一起 tripped）。 */
  readHeartbeats?: () => Promise<HeartbeatRow[]>
  /** head 本機 spool 深度。 */
  readSpool?: () => { depth: number; oldestTs: string | null }
  /** worker 名冊（只回 enabled 的）。 */
  listWorkers?: () => RosterWorker[]
  /** 對某台 worker 探 tunnel：true＝通。 */
  /** (c) 的 ssh 探測。引數是**由名冊 url 解出的 host**（MA-1），不是 worker
   * 名字——名字不是 DNS 名。 */
  probeTunnel?: (host: string) => Promise<boolean>
  /** head 記憶體中的 worker 主動回報。 */
  readWorkerStatuses?: () => WorkerMonitorStatus[]
  /** §6.3 計數器讀取。 */
  readR1Violations?: () => number
  /** (g) tg-monitor 的讀取面自況；`null` ＝ unknown（跳過不告警）。 */
  readReadSource?: () => Promise<ReadSourceStatus | null>
  /**
   * 名冊**解析成功**時回呼一次，帶本輪 enabled 的 worker 名單。
   *
   * 存在的理由是呼叫端的 key 生命週期：`(c)(d)(e)` 的條件 key 帶 worker 名，
   * 一台 worker 被移出名冊／停用之後，它的條件從此不再被評估——若移除當下該
   * 條件正處於 tripped，呼叫端的翻轉狀態表會**永遠停在 true**，那則告警再也
   * 等不到收尾（維運看到一則沒有下文的警報）。呼叫端需要知道「誰還在名冊裡」
   * 才能安全地清掉退場者的 key。
   *
   * **名冊讀取失敗時刻意不呼叫**——這是本回呼唯一重要的不變式：「讀不到名冊」
   * 與「名冊裡沒有這台」是兩件事，前者絕不能被當成「所有 worker 都退場了」
   * 而把全部 key 清光（那會在名冊檔暫時壞掉時吞掉所有既有告警的收尾）。
   */
  onRosterResolved?: (workerNames: string[]) => void
}

function tsToMs(ts: string | Date | null): number | null {
  if (ts === null || ts === undefined) return null
  if (ts instanceof Date) {
    const ms = ts.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  // B-1（review-final-A-dispatcher.md）：pool 是 dateStrings，DATETIME 欄讀出
  // 的是 `'YYYY-MM-DD HH:MM:SS.mmm'`（無 `T`/`Z`）——這個 production 唯一會
  // 出現的格式直接餵 `Date.parse()` 會按本機時區解析，Asia/Taipei 上每筆心跳
  // 都「落後 481 分鐘」→ (a)(d) 開機即 tripped 且永不翻轉＝偵測器失明。值本身
  // 是 UTC（pool `timezone:'Z'`），先正規化成 ISO 再解析；非 DB 形狀的輸入
  // （spool oldestTs 等 ISO 字串）原樣通過。
  const iso = mysqlDatetimeToIsoOrNull(ts)
  const ms = Date.parse(iso ?? ts)
  return Number.isFinite(ms) ? ms : null
}

function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)} 分鐘`
}

// ─────────────────────────────────────────────────────────────────────────
// production 預設 deps（每一支都可被測試覆寫）
// ─────────────────────────────────────────────────────────────────────────

async function defaultReadHeartbeats(): Promise<HeartbeatRow[]> {
  const pool = await getLongLivedMonitorPool()
  if (pool === null) throw new Error('monitor pool 不可用')
  const [rows] = await withMonitorDeadline('monitor_heartbeat SELECT', () => pool.execute<RowDataPacket[]>(MONITOR_HEARTBEAT_SELECT_SQL))
  return (rows as RowDataPacket[]).map(r => ({ host: String(r.host), writer: String(r.writer), ts: r.ts as string | Date | null }))
}

/**
 * 名冊只讀不寫（`worker-registry.ts` 是唯一的寫入者）。刻意不共用那個模組的
 * instance：它在建構時就把檔案讀進記憶體並快取，health-monitor 每輪要看的是
 * **檔案當下的內容**（worker 可能剛被 disable／剛登記）。
 */
function defaultListWorkers(): RosterWorker[] {
  const parsed = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as { workers?: unknown }
  if (!Array.isArray(parsed.workers)) return []
  return parsed.workers
    .filter((w): w is { name: string; url?: unknown; registeredAt?: unknown; disabled?: unknown } => typeof (w as { name?: unknown })?.name === 'string')
    .map(w => ({
      name: w.name,
      url: typeof w.url === 'string' ? w.url : '',
      registeredAt: typeof w.registeredAt === 'string' ? w.registeredAt : '',
      disabled: w.disabled === true,
    }))
    .filter(w => !w.disabled)
}

/** MA-1：由名冊 url 解出 ssh 探測 host。名字不是 DNS 名（`host landon2` →
 * NXDOMAIN），解析慣例與 run-monitor-tunnel.sh 逐字同源：`new URL(url).hostname`；
 * 解不出回 null（呼叫端視為 tunnel 不通——同一份 url 也是 tunnel job 自己的
 * 連線目標，url 壞掉時 tunnel job 同樣起不來，「解析不出＝不通」是真話）。 */
export function tunnelProbeHost(worker: RosterWorker): string | null {
  try {
    const host = new URL(worker.url).hostname
    return host || null
  } catch {
    return null
  }
}

/** ssh 目的地：沿用 run-monitor-tunnel.sh 的 `${MON_TUNNEL_SSH_USER:-user}@host`。 */
export function tunnelProbeTarget(host: string): string {
  return `${(process.env.MON_TUNNEL_SSH_USER ?? '').trim() || 'user'}@${host}`
}

/**
 * §6.8(c)：`ssh <user>@<host> 'nc -z 127.0.0.1 3307'`（host 由名冊 url 解出，
 * MA-1——不是 worker 名字）。
 * `execFile`（非同步）＋ 自帶 5 秒上界；`BatchMode=yes` 是必要的補強——沒有它，
 * 金鑰失效時 ssh 會停在密碼提示上，`timeout` 到期前這條探測會佔著一個子行程。
 * 任何非 0 退出、逾時、spawn 失敗一律回 false（＝翻轉條件），不區分成因：
 * 對「tunnel 到底通不通」這個問題，區分不出來就是不通。
 */
function defaultProbeTunnel(host: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.floor(SSH_PROBE_TIMEOUT_MS / 1000)}`, tunnelProbeTarget(host), 'nc -z 127.0.0.1 3307'],
      { timeout: SSH_PROBE_TIMEOUT_MS },
      err => resolve(err === null),
    )
  })
}

/**
 * `MON_READ_SOURCE` 的解析結果——**head 側獨立實作，語意鏡射 tg-monitor 的
 * `resolveReadSource()`（`tg-monitor/lib/read/source.ts`）**：
 *   trim + 轉小寫；`''`／未設（`null`）→ `'sqlite'`（預設）；
 *   `'sqlite'` → `'sqlite'`；`'mysql'` → `'mysql'`；
 *   **其他任何值 → `'sqlite'`**（對方是 fail-safe 退回，不是拋錯）。
 *
 * ⚠️ **這是刻意的重複實作，不是漂移疏忽**：條件 (g) 的第三支要的就是「不經由
 * 被監控者自述、自己獨立算一次再對照」——共用對方的函式就失去交叉驗證的意義
 * （對方那一處算錯時，兩邊會一起錯）。代價是**對方變更值域時必須同步改這裡**，
 * 這是總指揮裁定接受的成本。同步點只有一個：上面那五行規則。
 */
export function normalizeReadSource(raw: string | null): 'mysql' | 'sqlite' {
  return (raw ?? '').trim().toLowerCase() === 'mysql' ? 'mysql' : 'sqlite'
}

/**
 * (g)：打 tg-monitor 的 `GET /api/read-source`。
 *
 * **fail-open**：任何「問不到答案」的情況（連線拒絕、逾時、非 2xx 含 404、
 * body 不是 JSON、欄位缺或型別不對）一律回 `null` ＝ unknown，呼叫端跳過、
 * 不產生任何告警。理由是明確的：tg-monitor 尚未載入 Phase 8 的碼之前這條端點
 * 根本不存在（404），若把它當成故障，這條告警在整個 Phase 8 上線前會**恆為
 * tripped**，第一則就是誤報、之後又永遠不會翻轉——比沒有這條還糟。
 * 真正的「面板讀不到資料」由 tg-monitor 自己的健康面負責，不是這一條的職責。
 */
export async function probeReadSource(url: string = READ_SOURCE_URL): Promise<ReadSourceStatus | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(READ_SOURCE_PROBE_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = (await res.json()) as { requested?: unknown; effective?: unknown; degraded?: unknown; requestedValid?: unknown }
    // `requested` 允許 `null`＝「MON_READ_SOURCE 未設」（見 ReadSourceStatus 的
    // 說明）。若這裡跟著要求 string，未設變數的那台會被整條判成 unknown、
    // 條件 g 從此不評估——那是靜默的偵測缺口，不是保守。
    const requested = data.requested === null || data.requested === undefined ? null : data.requested
    if (typeof requested !== 'string' && requested !== null) return null
    if (typeof data.effective !== 'string' || typeof data.degraded !== 'boolean') return null
    // `requestedValid` 是 a4 才加上的欄位：缺欄（舊版）或型別不對一律收斂成
    // `null`＝「這個問題對面答不出來」，由判定端退回只看 `degraded`。
    // 三個字串欄位一律**原文透傳、零正規化**（無 lowercase／trim／enum 解析）：
    // 它們只進診斷訊息，維運要看到的是自己實際打錯的那串字。
    return {
      requested,
      effective: data.effective,
      degraded: data.degraded,
      requestedValid: typeof data.requestedValid === 'boolean' ? data.requestedValid : null,
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────

/**
 * 跑一輪六條件判定。**永不拋例外**——單一條件評估失敗只記 WARN 並把該條件
 * 從結果中省略（呼叫端保留前一狀態，不會誤報「恢復」）。
 *
 * 呼叫端必須自己先確認 `isMonitorDbEnabled()`；本函式不重複那道閘（讓
 * 「flag=0 時完全不評估」這件事在呼叫端一眼可驗）。
 */
export async function evaluateMonitorDbAlerts(deps: MonitorAlertDeps = {}): Promise<MonitorAlert[]> {
  const now = (deps.now ?? Date.now)()
  const alerts: MonitorAlert[] = []

  // 名冊先讀：(c)(d)(e) 三組都以它為候選清單。讀不到 → 那三組整組省略。
  let workers: RosterWorker[] | null = null
  try {
    workers = (deps.listWorkers ?? defaultListWorkers)()
    // 只有解析成功才通知呼叫端（見 onRosterResolved 的不變式）。回呼自己拋錯
    // 不得波及告警評估——它是呼叫端的 key 生命週期維護，不是判定的一部分。
    try {
      deps.onRosterResolved?.(workers.map(w => w.name))
    } catch (cbErr) {
      console.error(`monitor-db alerts: onRosterResolved 回呼拋錯（不影響告警評估）: ${cbErr}`)
    }
  } catch (err) {
    console.error(`monitor-db alerts: 讀取 worker 名冊失敗，本輪跳過 (c)(d)(e): ${err}`)
  }

  // ── (a) head 三個行程的心跳 ＋ (d) 每台 worker 的 worker-agent 心跳 ──
  // 兩組共用同一次 SELECT。查詢失敗＝「head 自己 DB 不可（讀）寫」，(a) 三條
  // 一起 tripped；(d) 這時無從判斷，整組省略（不是誤翻成「都正常」）。
  let heartbeats: HeartbeatRow[] | null = null
  let heartbeatError: string | null = null
  try {
    heartbeats = await (deps.readHeartbeats ?? defaultReadHeartbeats)()
  } catch (err) {
    heartbeatError = err instanceof Error ? err.message : String(err)
    console.error(`monitor-db alerts: monitor_heartbeat 查詢失敗: ${heartbeatError}`)
  }

  // 逐 writer 各自 try/catch：本函式對外宣稱「永不拋例外」，而這個迴圈會碰
  // 注入來的 `readHeartbeats` 回傳值（型別擋不住假 dep 回非陣列、或元素形狀
  // 不對）。少了這層，一個壞掉的 row 會讓整個 evaluateMonitorDbAlerts 拋出，
  // 連帶 (b)~(g) 全部不評估——正是「單一條件失敗不得中斷其他條件」要防的事。
  const heartbeatRows = heartbeats ?? []
  for (const writer of HEAD_WRITERS) {
    const key = `monitor-db:head-heartbeat:${writer}`
    const label = `head 的 ${writer} 監控心跳`
    try {
      if (heartbeatError !== null) {
        alerts.push({ key, label, tripped: true, level: 'error', detail: `${label}讀不到：monitor_heartbeat 查詢失敗（${heartbeatError}）` })
        continue
      }
      const row = heartbeatRows.find(r => r.host === 'head' && r.writer === writer)
      const ms = row ? tsToMs(row.ts) : null
      if (ms === null) {
        alerts.push({ key, label, tripped: true, level: 'error', detail: `${label}在 monitor_heartbeat 沒有可用的列（該行程可能從未成功寫入過）` })
        continue
      }
      const age = now - ms
      alerts.push({
        key,
        label,
        tripped: age > HEARTBEAT_STALE_MS,
        level: 'error',
        detail: `${label}已落後 ${minutes(age)}（門檻 ${minutes(HEARTBEAT_STALE_MS)}），該行程可能已死或其監控 DB 寫入全部失敗`,
      })
    } catch (err) {
      console.error(`monitor-db alerts: (a) ${writer} 的心跳判定拋錯，本輪跳過該條: ${err}`)
    }
  }

  // ── (b) head 的 spool 積壓 ──
  try {
    const spool = (deps.readSpool ?? readSpoolDepth)()
    const oldestMs = spool.oldestTs === null ? null : tsToMs(spool.oldestTs)
    const oldestAge = oldestMs === null ? null : now - oldestMs
    const deep = spool.depth > SPOOL_DEPTH_THRESHOLD
    const stale = oldestAge !== null && oldestAge > SPOOL_OLDEST_THRESHOLD_MS
    alerts.push({
      key: 'monitor-db:head-spool',
      label: 'head 的 monitor spool 積壓',
      tripped: deep || stale,
      level: 'error',
      detail:
        `head 的 logs/spool 未 ack 條目 ${spool.depth} 條` +
        (oldestAge === null ? '' : `、最舊 ${minutes(oldestAge)}`) +
        `（門檻 ${SPOOL_DEPTH_THRESHOLD} 條 / ${minutes(SPOOL_OLDEST_THRESHOLD_MS)}）——監控 DB 寫入正在持續落地失敗`,
    })
  } catch (err) {
    console.error(`monitor-db alerts: (b) spool 深度讀取失敗，本輪跳過: ${err}`)
  }

  if (workers !== null) {
    // ── (c) tunnel 不通 ──（每台一條，平行探測；單台失敗不影響其他台）
    const probe = deps.probeTunnel ?? defaultProbeTunnel
    const probes = await Promise.all(
      workers.map(async w => {
        try {
          // MA-1：ssh 目標是名冊 url 解出的 host，**不是 worker 名字**（名字不是
          // DNS 名，`host landon2` → NXDOMAIN → (c) 永久 tripped 且失明）。
          const host = tunnelProbeHost(w)
          if (host === null) return { worker: w.name, reachable: false, badUrl: w.url }
          return { worker: w.name, reachable: await probe(host), badUrl: null }
        } catch (err) {
          console.error(`monitor-db alerts: (c) worker ${w.name} 的 tunnel 探測拋錯，本輪跳過該台: ${err}`)
          return null
        }
      }),
    )
    for (const p of probes) {
      if (p === null) continue
      alerts.push({
        key: `monitor-db:tunnel:${p.worker}`,
        label: `worker ${p.worker} 的 monitor DB tunnel`,
        tripped: !p.reachable,
        level: 'error',
        detail:
          p.badUrl !== null && p.badUrl !== undefined
            ? `worker ${p.worker} 的名冊 url "${p.badUrl}" 解析不出 host——tunnel job 用同一份 url，同樣起不來（(c) 判不通）`
            : `worker ${p.worker} 上 \`nc -z 127.0.0.1 3307\` 不通——該台的 SSH tunnel 斷了，它的監控寫入全部只會落 spool`,
      })
    }

    // ── (d) 每台 worker 的 (worker,'worker-agent') 心跳 ──
    if (heartbeats !== null) {
      for (const w of workers) {
        // 同 (a)：逐台各自 try/catch，一台的判定拋錯不得中斷其餘各台與後面的條件。
        try {
          if (withinGrace(w, now)) continue
          const key = `monitor-db:worker-heartbeat:${w.name}`
          const label = `worker ${w.name} 的 worker-agent 心跳`
          const row = heartbeatRows.find(r => r.host === w.name && r.writer === 'worker-agent')
          const ms = row ? tsToMs(row.ts) : null
          if (ms === null) {
            alerts.push({
              key,
              label,
              tripped: true,
              level: 'error',
              detail: `${label}在 monitor_heartbeat **沒有列**——該台可能 tunnel 通但憑證錯／匯出白名單漏了／.env 沒 scp（這正是 MAJOR-D13 的盲區）`,
            })
            continue
          }
          const age = now - ms
          alerts.push({
            key,
            label,
            tripped: age > HEARTBEAT_STALE_MS,
            level: 'error',
            detail: `${label}已落後 ${minutes(age)}（門檻 ${minutes(HEARTBEAT_STALE_MS)}）`,
          })
        } catch (err) {
          console.error(`monitor-db alerts: (d) worker ${w.name} 的心跳判定拋錯，本輪跳過該台: ${err}`)
        }
      }
    }

    // ── (e) worker 主動回報的 spool 深度 ──
    try {
      const statuses = (deps.readWorkerStatuses ?? listWorkerMonitorStatuses)()
      for (const w of workers) {
        if (withinGrace(w, now)) continue
        const key = `monitor-db:worker-spool:${w.name}`
        const label = `worker ${w.name} 的 spool 回報`
        const st = statuses.find(s => s.worker === w.name)
        if (st === undefined || now - st.receivedAt > WORKER_REPORT_STALE_MS) {
          // §6.8(e)：回報缺席／落後＝「未知」，WARN 級（不是 ERROR——真正的
          // 「這台死了」由 (c)(d) 兩條 ERROR 級條件負責，這條只講「我不知道」）。
          alerts.push({
            key,
            label,
            tripped: true,
            level: 'warn',
            detail:
              st === undefined
                ? `${label}從未收到（該台可能還沒升級到會回報 /cluster/monitor-status 的版本，或 head 打不到）——其 spool 深度未知`
                : `${label}已落後 ${minutes(now - st.receivedAt)}（門檻 ${minutes(WORKER_REPORT_STALE_MS)}）——其 spool 深度未知`,
          })
          continue
        }
        const depth = st.spoolDepth
        alerts.push({
          key,
          label,
          tripped: depth !== null && depth > SPOOL_DEPTH_THRESHOLD,
          level: 'error',
          detail:
            `worker ${w.name} 回報 spool 未 ack ${depth} 條（門檻 ${SPOOL_DEPTH_THRESHOLD}）` +
            (st.oldestAgeS === null ? '' : `、最舊 ${minutes(st.oldestAgeS * 1000)}`) +
            // 三態逐字對應（a7-D15：null＝不知道，不得說成「不可寫」）：
            // true → 不加字（沒有壞消息就不要製造壞消息）；false → 明說不可寫；
            // null → 明說「未知」，讓維運知道這一格沒有答案，而不是被當成正常。
            (st.dbWritable === false ? '、且該台回報監控 DB 不可寫' : st.dbWritable === null ? '、該台的監控 DB 可寫性未知（尚未有成功心跳）' : ''),
        })
      }
    } catch (err) {
      console.error(`monitor-db alerts: (e) worker 回報讀取失敗，本輪跳過: ${err}`)
    }
  }

  // ── (f) r1_violation ──
  try {
    const violations = (deps.readR1Violations ?? (() => getMonitorCounter('r1_violation')))()
    alerts.push({
      key: 'monitor-db:r1-violation',
      label: 'R1 違反（runs.host 不符）',
      tripped: violations > 0,
      level: 'error',
      detail:
        `本行程累計 ${violations} 次 r1_violation（§6.3 規定必須恆為 0）——有寫入者試圖改別台機器的 runs 列，` +
        'R1「host 只寫自己」的不變式已被違反，請立刻查該 run_id 的來源',
    })
  } catch (err) {
    console.error(`monitor-db alerts: (f) 計數器讀取失敗，本輪跳過: ${err}`)
  }

  // ── (g) 讀取面靜默降級 ──
  try {
    const rs = await (deps.readReadSource ?? probeReadSource)()
    if (rs !== null) {
      // 判準（總指揮終版裁定）＝三支 OR，理由見檔頭 (g)。
      const invalidSetting = rs.requestedValid === false
      // 第三支：head 自己正規化一次再跟對方回報的 effective 對照。不依賴
      // `degraded`／`requestedValid` 任一自報旗標 ⇒ 對方漏設 degraded 也抓得到。
      const expected = normalizeReadSource(rs.requested)
      const crossCheckFailed = expected !== rs.effective
      const shown = rs.requested === null ? '(未設)' : `'${rs.requested}'`
      alerts.push({
        key: 'monitor-db:read-source-degraded',
        label: 'tg-monitor 讀取面來源',
        tripped: rs.degraded === true || invalidSetting || crossCheckFailed,
        level: 'error',
        detail: invalidSetting
          ? `tg-monitor 的 MON_READ_SOURCE 設定值不合法：requested=${shown}，已被 fail-safe 成 effective='${rs.effective}'` +
            `（degraded=${rs.degraded}）——面板上的數字看起來正常，但讀的根本不是你以為的那個來源，請改正設定值`
          : rs.degraded === true
            ? `tg-monitor 的讀取面已靜默降級：requested=${shown}、effective='${rs.effective}'（degraded=true）` +
              '——面板上的數字看起來正常，實際來源已不是要求的那一個'
            : `tg-monitor 的讀取面與設定不符（head 側交叉驗證）：MON_READ_SOURCE=${shown} 依解析規則應得 '${expected}'，` +
              `但 tg-monitor 回報 effective='${rs.effective}' 且 degraded=false——對方可能真降級卻漏設 degraded 旗標，` +
              '請直接查 tg-monitor 的啟動 log 確認實際讀取來源',
      })
    }
    // rs === null ＝ unknown：**刻意不 push 任何條件**，呼叫端因此保留前一狀態，
    // 不會在 tg-monitor 還沒上 Phase 8 的碼時誤翻轉（見 probeReadSource）。
  } catch (err) {
    console.error(`monitor-db alerts: (g) 讀取面探測失敗，本輪跳過: ${err}`)
  }

  return alerts
}

/** MINOR-3：新 worker 從第一次出現在名冊起 30 分鐘內不對它發 (d)(e) 告警
 * （它的心跳與回報都還沒來得及建立）。`registeredAt` 解析不出來時**不給**
 * 寬限——寧可誤報一次，也不要讓一個壞掉的時間字串永久豁免一台機器。 */
function withinGrace(worker: RosterWorker, now: number): boolean {
  const registered = Date.parse(worker.registeredAt)
  return Number.isFinite(registered) && now - registered < NEW_WORKER_GRACE_MS
}
