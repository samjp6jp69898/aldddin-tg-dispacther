// lib/monitor-db/alerts.ts — §6.8(3) 的六條營運告警判定（a–f）。
//
// 背景：計畫 §6.8(3) 列了七條告警（a–g），本模組實作 a–f；(g)「投影閘門中止」
// 屬 §5.9 的投影閘門本身，不在這裡。判定結果由
// `lib/webhook-server/health-monitor.ts` 既有的 60 秒 timer 消費，**翻轉才發
// TG 給 OPERATOR**（比照該檔既有的 tunnel／token 名冊兩套告警慣例）。
//
// 六條（v3.2 修訂後的版本，不是 v3 原文）：
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
  registeredAt: string
  disabled: boolean
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
  probeTunnel?: (worker: string) => Promise<boolean>
  /** head 記憶體中的 worker 主動回報。 */
  readWorkerStatuses?: () => WorkerMonitorStatus[]
  /** §6.3 計數器讀取。 */
  readR1Violations?: () => number
}

function tsToMs(ts: string | Date | null): number | null {
  if (ts === null || ts === undefined) return null
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts)
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
    .filter((w): w is { name: string; registeredAt?: unknown; disabled?: unknown } => typeof (w as { name?: unknown })?.name === 'string')
    .map(w => ({
      name: w.name,
      registeredAt: typeof w.registeredAt === 'string' ? w.registeredAt : '',
      disabled: w.disabled === true,
    }))
    .filter(w => !w.disabled)
}

/**
 * §6.8(c)：`ssh <worker> 'nc -z 127.0.0.1 3307'`。
 * `execFile`（非同步）＋ 自帶 5 秒上界；`BatchMode=yes` 是必要的補強——沒有它，
 * 金鑰失效時 ssh 會停在密碼提示上，`timeout` 到期前這條探測會佔著一個子行程。
 * 任何非 0 退出、逾時、spawn 失敗一律回 false（＝翻轉條件），不區分成因：
 * 對「tunnel 到底通不通」這個問題，區分不出來就是不通。
 */
function defaultProbeTunnel(worker: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.floor(SSH_PROBE_TIMEOUT_MS / 1000)}`, worker, 'nc -z 127.0.0.1 3307'],
      { timeout: SSH_PROBE_TIMEOUT_MS },
      err => resolve(err === null),
    )
  })
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

  for (const writer of HEAD_WRITERS) {
    const key = `monitor-db:head-heartbeat:${writer}`
    const label = `head 的 ${writer} 監控心跳`
    if (heartbeatError !== null) {
      alerts.push({ key, label, tripped: true, level: 'error', detail: `${label}讀不到：monitor_heartbeat 查詢失敗（${heartbeatError}）` })
      continue
    }
    const row = heartbeats!.find(r => r.host === 'head' && r.writer === writer)
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
          return { worker: w.name, reachable: await probe(w.name) }
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
        detail: `worker ${p.worker} 上 \`nc -z 127.0.0.1 3307\` 不通——該台的 SSH tunnel 斷了，它的監控寫入全部只會落 spool`,
      })
    }

    // ── (d) 每台 worker 的 (worker,'worker-agent') 心跳 ──
    if (heartbeats !== null) {
      for (const w of workers) {
        if (withinGrace(w, now)) continue
        const key = `monitor-db:worker-heartbeat:${w.name}`
        const label = `worker ${w.name} 的 worker-agent 心跳`
        const row = heartbeats.find(r => r.host === w.name && r.writer === 'worker-agent')
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
            (st.dbWritable === false ? '、且該台回報監控 DB 不可寫' : ''),
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

  return alerts
}

/** MINOR-3：新 worker 從第一次出現在名冊起 30 分鐘內不對它發 (d)(e) 告警
 * （它的心跳與回報都還沒來得及建立）。`registeredAt` 解析不出來時**不給**
 * 寬限——寧可誤報一次，也不要讓一個壞掉的時間字串永久豁免一台機器。 */
function withinGrace(worker: RosterWorker, now: number): boolean {
  const registered = Date.parse(worker.registeredAt)
  return Number.isFinite(registered) && now - registered < NEW_WORKER_GRACE_MS
}
