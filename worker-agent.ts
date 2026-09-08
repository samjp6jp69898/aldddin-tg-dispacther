// telegram-dispatcher — worker agent 入口（多機派工的 worker 端）。
//
// 部署在 worker 機（同一套 /Users/user/aladdin 目錄慣例，見 README「多機
// 擴容」一節與 deploy/ 腳本），對 LAN 提供輕量 HTTP 介面，讓 head（跑
// server.ts 的那台）把認領到的 Bug/需求單派過來本機執行：
//   GET  /health        存活探測（比照 server.ts /health：不驗證、最小資訊）
//   GET  /capacity      本機兩條 pipeline 的名額實況（head 派工選擇用）
//   GET  /maintenance   本機維護模式現況（2026-09-08 新增，tg-monitor 輪詢用）
//   POST /maintenance   開關本機維護模式（2026-09-08 新增；開著時 /jobs 一律
//                       拒絕新單，見 lib/maintenance/mode-store.ts 檔頭——
//                       獨立於 head 的旗標，不經 head 轉發，tg-monitor 直接
//                       打這台）
//   POST /jobs          接單：直接走本機既有的 submitCreateMr/
//                       submitDemandPipeline（佇列、併發上限、去重、
//                       stale-lock 回收全部沿用單機機制，一行不改）
//   GET  /jobs/:ticket  某張單在本機的實況（鎖/佇列狀態 + stage 進度描述）
//   POST /jobs/:ticket/cancel  取消本機正在跑的那張單（2026-09-04 新增，見
//                       lib/pipeline-runner/local-cancel.ts；演算法比照
//                       tg-monitor/lib/ingest.ts 的 cancelPipeline()）
//   GET  /files         唯讀讀取白名單目錄下的檔案內容（2026-09-04 新增，
//                       task 1：head 的 /api/agent-trace 對 worker 執行的 run
//                       proxy 過來用；見 lib/pipeline-runner/local-trace-read.ts）
//   GET  /jobs/:ticket/stage-files  這張 bug 票的階段產物檔存在與否＋mtime
//                       原始資料（2026-09-04 新增，task 1：head 的
//                       computeBugStages() 組裝用；見
//                       lib/pipeline-runner/local-stage-files.ts）
//   GET  /jobs/:ticket/current-stage  這張 bug 票此刻正在跑哪個 stage／哪位
//                       agent 的即時推定（2026-09-04 新增，task 2：head 的
//                       computeBugStages() 組裝「running」那一列用；見
//                       lib/pipeline-runner/local-current-stage.ts）
// 其餘路徑一律 uniform 401。
//
// 完成回報（事件驅動，不輪詢）：任一背景 pipeline 真的結束（pipeline-queue
// 的 onExited 事件）就 POST head 的 /cluster/job-done，讓 head 清掉派工
// 登記、該單恢復可認領。單次回報失敗會落地待重送佇列，由週期性 timer 補送
// （2026-09-04，見 lib/cluster/job-done-queue.ts）；head 的 remote sweeper
// 仍是最後一道校正防線（見 cluster-head.ts）。
//
// 對使用者的通知不經過 head：pipeline 的 EXIT trap / post-run-notify /
// tg-notify.sh 在本機直接打 Telegram API（.env 隨 aladdin 目錄複製過來，
// 見 launchd/run-worker-agent.sh），跟單機部署完全同一條路。
//
// 重要：worker 機上不要跑 server.ts（那是 head 專用——webhook、tunnel、
// MCP proxy 都只該有一份）。worker 只跑這支 + 它自己的 launchd plist。

import { Hono } from 'hono'
import { join } from 'node:path'
import { getClusterSecret, WORKER_NAME_RE, WORKER_URL_RE } from './lib/cluster/cluster-env.ts'
import { createClusterAuthGuard, CLUSTER_TOKEN_HEADER } from './lib/cluster/cluster-auth.ts'
import { respondUniform401 } from './lib/security/uniform-401.ts'
import { createMaintenanceModeStore } from './lib/maintenance/mode-store.ts'
import {
  submitCreateMr,
  recoverBugQueue,
  getBugQueueStats,
  hasBugTicketActive,
  getBugRunningTickets,
  registerBugPipelineExitListener,
} from './lib/pipeline-runner/spawn-create-mr.ts'
import {
  submitDemandPipeline,
  recoverDemandQueue,
  getDemandQueueStats,
  hasDemandTicketActive,
  getDemandRunningTickets,
  registerDemandPipelineExitListener,
} from './lib/pipeline-runner/spawn-demand-pipeline.ts'
import { createLocalActivity } from './lib/cluster/local-activity.ts'
import { isTicketLocked, describeTicketProgress, getTicketProgressStages } from './lib/pipeline-runner/ticket-progress.ts'
import { ensureTrackerPending, readTrackerRow, writeTrackerFile } from './lib/pipeline-runner/tracker-sync.ts'
import { startStaleLockReaper } from './lib/pipeline-runner/stale-lock-reaper.ts'
import { startMonitorMaintenance, runRestartSweep } from './lib/monitor-db/maintenance.ts'
import { declareMonitorRole, isMonitorDbEnabled } from './lib/monitor-db/env.ts'
import { startMonitorCollectors } from './lib/monitor-db/collectors/index.ts'
import { getLastHeartbeatResult, startMonitorHeartbeat } from './lib/monitor-db/heartbeat.ts'
import { startLogShipperLoop, listDispatcherLogFiles } from './lib/log-shipper/mount.ts'
import { createClusterSink } from './lib/log-shipper/cluster-sink.ts'
import { readSpoolDepth } from './lib/monitor-db/spool/depth.ts'
import { createJobDoneQueue, retryJobDoneQueue } from './lib/cluster/job-done-queue.ts'
import { cancelLocalPipeline } from './lib/pipeline-runner/local-cancel.ts'
import { readLocalTraceFile } from './lib/pipeline-runner/local-trace-read.ts'
import { readLocalStageFiles } from './lib/pipeline-runner/local-stage-files.ts'
import { inferCurrentBugStage } from './lib/pipeline-runner/local-current-stage.ts'
import type { SubmitResult } from './lib/pipeline-runner/pipeline-queue.ts'
import type { TechUser } from './lib/user-resolution/tech-user.ts'
import { isBugMode, type BugMode } from './lib/pipeline-runner/bug-mode.ts'

const BUG_TICKET_RE = /^FAQ-\d+$/
const DEMAND_TICKET_RE = /^ALDREQ-\d+$/

const maybeSecret = getClusterSecret()
if (maybeSecret === null) {
  // worker 沒有「cluster 停用」的降級模式——它存在的唯一目的就是接 head
  // 派工，沒 secret 等於對 LAN 開一個無認證的 spawn 入口，直接拒絕啟動。
  throw new Error('worker-agent: CLUSTER_SHARED_SECRET 未設定（或長度不足），拒絕啟動（見 launchd/run-worker-agent.sh）')
}
// 重新綁定成 string 型別：模組層的 null check 不會流進下面各 closure 的
// 型別收斂，這一行讓後續所有用點都拿到非 null 型別。
const secret: string = maybeSecret
// 比照 cluster-head.ts 的同名常數（同一套 /Users/user/aladdin 目錄慣例，見
// launchd/run-worker-agent.sh）：worker 機上的 telegram-dispatcher checkout
// 一律在這個固定路徑。
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
// 維護模式（2026-09-08）：本機獨立於 head 的旗標，見 lib/maintenance/mode-store.ts
// 檔頭「belt-and-braces」說明——tg-monitor 直接打這台的 POST /maintenance
// 開關，不經過 head 轉發。
const maintenanceMode = createMaintenanceModeStore(join(LOG_DIR, 'maintenance-mode.json'))
const headUrl = (process.env.CLUSTER_HEAD_URL ?? '').trim().replace(/\/+$/, '')
const workerName = (process.env.CLUSTER_WORKER_NAME ?? '').trim()
const advertiseUrl = (process.env.CLUSTER_WORKER_URL ?? '').trim().replace(/\/+$/, '')
if (!WORKER_URL_RE.test(headUrl)) throw new Error('worker-agent: CLUSTER_HEAD_URL 未設定或格式不對（需 http(s)://host[:port]）')
if (!WORKER_NAME_RE.test(workerName)) throw new Error('worker-agent: CLUSTER_WORKER_NAME 未設定或格式不對（英數 . _ -，≤64 字元）')
if (!WORKER_URL_RE.test(advertiseUrl)) throw new Error('worker-agent: CLUSTER_WORKER_URL 未設定或格式不對（本機對 LAN 的網址，如 http://192.168.1.50:8801）')

// 2026-09-02 熱修（Bug 2）：CLUSTER_WORKER_NAME 已在上面驗過格式，這裡顯式
// 宣告角色——之後 MON_HOST/isWorkerProcess() 一律用宣告值，不再嗅探環境
// 變數（worker 本來就該用這個變數，宣告只是把「怎麼用」收斂成單一入口，
// 與 server.ts 對稱）。
declareMonitorRole('mon_exec')

// ---- 完成回報（事件驅動） + 向 head 登記（啟動時一次 + 每 30 分鐘冪等重送，
// 讓 head 端名冊檔遺失/重建後自癒；週期性排程器，非輪詢等待）----

// 本機活動三合一真相來源（queue ∪ 鎖目錄 ∪ ps wrapper 掃描）：/capacity、
// 接單檢查、/jobs/:ticket、job-done 回報全部以它為準——只看 in-memory queue
// 會對 out-of-band run（timeout 自動重試、reaper 重跑、人工觸發）失明，
// 是對抗性 review 2026-08-31 C-1 的雙跑根因，詳見 local-activity.ts 檔頭。
const localActivity = createLocalActivity({
  queueRunning: { bug: getBugRunningTickets, demand: getDemandRunningTickets },
})

/** kind 的名額實況：running 取「queue 認得的」與「本機實際活動」的聯集
 * 大小（寧可保守少接單，不可超賣）。limit/queued 仍來自 queue。 */
function effectiveStats(kind: 'bug' | 'demand'): { limit: number; running: number; queued: number } {
  const base = kind === 'bug' ? getBugQueueStats() : getDemandQueueStats()
  return { ...base, running: Math.max(base.running, localActivity.activeTickets(kind).size) }
}

async function postToHead(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${headUrl}${path}`, {
      method: 'POST',
      headers: { [CLUSTER_TOKEN_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 接單前向 head 抓一份完整 tracker 覆蓋本機（2026-09-03）。
 *
 * 背景見 tracker-sync.ts「整檔同步」段落：worker 機上這份檔案不存在時，
 * /create-mr Step 0.1 會把每一張單都判成 not claimable，pipeline 幾十秒
 * 就 SKIPPED 退出，head 那端只看得到「派出去、幾秒後 job-done」。
 *
 * 全程降級不阻斷：head 打不到、回 503、內容形狀不對、或本機正有人在寫
 * （writeTrackerFile 搶不到 tracker.sh 那把檔級鎖）都只記 log，沿用本機
 * 既有那份繼續接單——拿不到最新副本頂多是狀態舊，硬把接單擋掉才是把
 * 單機時期就能跑的情境也一起弄壞。
 *
 * 逾時 3 秒：這一段落在 head 端 postJob 的 6 秒預算內（見 worker-client.ts
 * 逾時預算註解，該預算原本只含 ensureTrackerPending 的 1–3 秒 Notion 查詢）。
 * LAN 上 200KB 量級的 JSON 實測遠低於此；逾時就走上面的降級路徑。
 */
async function pullTrackerFromHead(ticket: string): Promise<void> {
  try {
    const res = await fetch(`${headUrl}/cluster/tracker`, {
      headers: { [CLUSTER_TOKEN_HEADER]: secret },
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) {
      console.error(`worker-agent: ${ticket} 接單前拉 head tracker 失敗（HTTP ${res.status}），沿用本機那份`)
      return
    }
    const body = (await res.json()) as { ok?: boolean; content?: unknown }
    if (body?.ok !== true || typeof body.content !== 'string') {
      console.error(`worker-agent: ${ticket} 接單前拉 head tracker 回應格式不對，沿用本機那份`)
      return
    }
    const outcome = writeTrackerFile(body.content)
    if (outcome !== 'ok') {
      console.error(`worker-agent: ${ticket} 接單前寫入 head tracker 副本未完成（${outcome}），沿用本機那份`)
    }
  } catch (err) {
    console.error(`worker-agent: ${ticket} 接單前拉 head tracker 例外，沿用本機那份: ${err}`)
  }
}

// job-done 回報可靠送達（2026-09-04）：單次 postToHead 失敗時落地待重送佇列
// （tmp+rename，比照 pipeline-queue.ts 既有慣例），由下面的週期性 timer 定期
// 補送，worker 重啟時 loadFromDisk() 撿回——見 job-done-queue.ts 檔頭「已知
// 現況」背景說明（原本失敗只 catch 回傳 false，回報永久遺失，是「已無執行
// 活動但未收到 job-done 回報」誤報訊息的根因）。
const jobDoneQueue = createJobDoneQueue(join(LOG_DIR, 'job-done-queue.json'))

function jobDoneBody(entry: { ticket: string; worker: string; trackerRow?: string }): Record<string, unknown> {
  return { ticket: entry.ticket, worker: entry.worker, ...(entry.trackerRow ? { trackerRow: entry.trackerRow } : {}) }
}

function reportJobDone(ticket: string): void {
  // C-1 修正：回報前先確認這張單在本機已無**任何**活動——wrapper 的 EXIT
  // trap 內 post-run-notify 可能已對 timeout 自動重試 spawn 了下一輪 run
  // （它在別的 process，queue 看不到，但 ps/鎖看得到）。此時回報 job-done
  // 會讓 head 清登記、單子回到可認領池，與還活著的重試 run 形成雙跑。
  // 跳過回報＝head 登記保留，之後由 sweeper 向本機 /jobs/:ticket 查證
  // （同樣走三合一判定）決定去留。
  if (localActivity.isActive(ticket)) {
    console.error(`worker-agent: ${ticket} 結束但本機仍有該單的其他活動（可能為自動重試），跳過 job-done 回報`)
    return
  }
  // 終態隨回報一起帶回 head（2026-09-03）：/create-mr Step 8 寫的是本機這份
  // tracker，head 那份不會自己知道。只有 bug 單走 tracker（ALDREQ 的認領與
  // 狀態完全在 Notion，tracker.sh 也只認 FAQ- 行）。讀不到就不帶這個欄位，
  // head 端維持原本只清登記的行為。
  const trackerRow = BUG_TICKET_RE.test(ticket) ? readTrackerRow(ticket) : null
  const entry = { ticket, worker: workerName, trackerRow: trackerRow ?? undefined }
  void postToHead('/cluster/job-done', jobDoneBody(entry)).then(ok => {
    if (ok) return
    console.error(`worker-agent: job-done 回報失敗（${ticket}），已落地待重送佇列，下一輪 tick 重試`)
    jobDoneQueue.enqueue(entry)
  })
}

registerBugPipelineExitListener(reportJobDone)
registerDemandPipelineExitListener(reportJobDone)

const JOB_DONE_RETRY_TICK_MS = 60_000

/** 週期性補送待重送佇列（見 job-done-queue.ts 的 retryJobDoneQueue）——不是
 * 用等待解決正確性問題：head 短暫失聯是外部失敗，這是對它的確定性重試排程，
 * 跟本檔既有的 registerWithHead 30 分鐘 timer、monitor-status 60 秒 timer
 * 同一類週期性排程器。 */
async function retryQueuedJobDoneReports(): Promise<void> {
  const { attempted, succeeded } = await retryJobDoneQueue(jobDoneQueue, entry => postToHead('/cluster/job-done', jobDoneBody(entry)))
  if (attempted > 0) console.error(`worker-agent: job-done 待重送佇列本輪嘗試 ${attempted} 筆，成功補送 ${succeeded} 筆`)
}
setInterval(() => void retryQueuedJobDoneReports(), JOB_DONE_RETRY_TICK_MS)

async function registerWithHead(): Promise<void> {
  const ok = await postToHead('/cluster/register', { name: workerName, url: advertiseUrl })
  console.error(ok ? `worker-agent: 已向 head（${headUrl}）登記為 ${workerName}` : `worker-agent: 向 head（${headUrl}）登記失敗，30 分鐘後自動重試`)
}
void registerWithHead()
setInterval(() => void registerWithHead(), 30 * 60_000)

// ---- 本機既有機制的啟動收尾（比照 server.ts）----

startStaleLockReaper()

// job-done 待重送佇列：撿回重啟前還沒送達的回報（trap 沒機會寫入佇列的極端
// 情況——例如整機斷電——除外），並立即嘗試補送一輪，不等第一次 60 秒 tick。
const queuedJobDoneReports = jobDoneQueue.loadFromDisk()
if (queuedJobDoneReports.length > 0) {
  console.error(`worker-agent: 撿回 ${queuedJobDoneReports.length} 筆重啟前未送達的 job-done 回報，立即嘗試補送`)
  void retryQueuedJobDoneReports()
}

const bugRecovered = recoverBugQueue()
const demandRecovered = recoverDemandQueue()
if (
  bugRecovered.started.length + bugRecovered.requeued.length + bugRecovered.skipped.length + demandRecovered.started.length + demandRecovered.requeued.length + demandRecovered.skipped.length >
  0
) {
  console.error(
    `worker-agent: 排隊恢復 bug(started=${bugRecovered.started.length}, requeued=${bugRecovered.requeued.length}, skipped=${bugRecovered.skipped.length}) demand(started=${demandRecovered.started.length}, requeued=${demandRecovered.requeued.length}, skipped=${demandRecovered.skipped.length})`,
  )
}

// 【plan-db-as-truth-v3.md §5.6，BL-C5】seen = 六組 run_id 陣列的聯集，只跑
// 一次（不是週期 tick），理由與 server.ts 同位置註解相同。
void runRestartSweep(
  new Set([
    ...bugRecovered.started,
    ...bugRecovered.requeued,
    ...bugRecovered.skipped,
    ...demandRecovered.started,
    ...demandRecovered.requeued,
    ...demandRecovered.skipped,
  ]),
)

// 監控 DB 週期維護（整合修補批次 item 2 + item 8）：同一 tick 內重放本機
// spool（worker 是自己 spool 目錄唯一的重放者，§6.5(d)）+ §6.6 本機
// sweeper。直接複用上面已建好的 localActivity（queue ∪ 鎖目錄 ∪ ps 三合一，
// 不重建第二份）。isMonitorDbEnabled()=false 時內部直接 no-op。
startMonitorMaintenance({ isTicketActive: ticket => localActivity.isActive(ticket) })

// 【plan §9 Phase 4】collectors：agent trace / bug stdout → agent_runs。worker
// 只掛這一個——`mcp_usage` 的稽核 jsonl 只在 head 上，且 mon_exec 沒有那張表
// 的權限（§11.1 授權對映）。isMonitorDbEnabled()=false 時內部整段 no-op。
startMonitorCollectors({ role: 'mon_exec' })

// 【plan §6.8(1)(2)】monitor_heartbeat：啟動時打一拍 + 每 60 秒一拍
// （writer='worker-agent'，PK 是 (host, writer)，每台 worker 自己一列）。
// 失敗只 WARN + 落 spool；isMonitorDbEnabled()=false 時整段 no-op。
startMonitorHeartbeat({ writer: 'worker-agent' })

// 【plan §7.2/§7.4，Phase 7 整合】worker 端的 log shipping 常駐迴圈。
// library（lib/log-shipper/shipper.ts）2026-09-02 就完成了，但在此之前**沒有
// 任何行程呼叫過 runOneCycle()**——VictoriaLogs 一直沒有新資料，那不是驗證
// 缺口而是整合工項從未開始，2026-09-03 補上。head 那一份掛在 intake-server.ts。
//
// sink 走 cluster-sink → head 的 9429（經 SSH tunnel 的 127.0.0.1:9429，
// 與監控 DB 的 3307 同一條隧道，doctor-worker 的「監控 DB」節就在驗這兩個埠）。
// 不直寫 VictoriaLogs：worker 上沒有 MON_VL_* 憑證，而且 §3.3(e) 的 host 覆寫
// 與 LRU 去重都在 intake 那一側，繞過它等於繞過那兩層。
startLogShipperLoop({
  label: 'worker-agent',
  listSourceFiles: listDispatcherLogFiles,
  // 直接用模組層那個已收斂成 string 的 `secret`：本行程在 :63 就對缺 secret
  // 拒絕啟動了，這裡再檢查一次是永遠不會成立的死碼。
  createSink: () => createClusterSink({ worker: workerName, clusterSecret: secret }),
})

// 【plan-db-as-truth-v3.2.md MJ-E4 ＝ MAJOR-F6，§6.8(e)】每 60 秒把本機的監控
// 自況主動回報給 head（head 存記憶體，由它的 health-monitor 判斷告警）。
//
// 為什麼是主動回報：v3 原本要把這三個欄位塞進本機 `GET /health`，但那是本機
// 唯一不驗證的路由（下面 :/health），且「head 本來就每輪打 /health」是事實
// 錯誤。改走已認證的 postToHead 之後，`/health` 一個字不用改，head 也不需要
// 新增任何輪詢工項。
//
// 紀律：這支跑在**自己的 timer 內**，絕不掛進 `/jobs` 熱路徑（那條路徑不得
// 有任何 DB／網路 I/O）。`isMonitorDbEnabled()` 關閉時連 timer 都不建——
// flag=0 時本行程的行為與本次改動前完全相同。
const MONITOR_STATUS_TICK_MS = 60_000

/** 心跳結果 → `db_writable` 的三態：`null`（還沒打過任何一拍＝不知道）／
 * `true`（上一拍真的寫進 DB）／`false`（上一拍落 spool 或整個遺失）。 */
function toTriState(result: ReturnType<typeof getLastHeartbeatResult>): boolean | null {
  return result === null ? null : result === 'written'
}

async function reportMonitorStatus(): Promise<void> {
  try {
    const spool = readSpoolDepth()
    // `oldest_age_s`：由 worker 自己換算（head 只會拿它跟門檻比大小，不做
    // 跨機時鐘校正——兩端時鐘偏移的影響因此只落在這一個數字上，不會污染
    // head 蓋章的 receivedAt）。
    const oldestAgeS = spool.oldestTs === null ? null : Math.max(0, Math.round((Date.now() - Date.parse(spool.oldestTs)) / 1000))
    const ok = await postToHead('/cluster/monitor-status', {
      worker: workerName,
      spool_depth: spool.depth,
      oldest_age_s: oldestAgeS,
      // 「上一拍心跳有沒有真的寫進 DB」——本行程手上唯一不需要多打一次 DB
      // 就能得到的可寫性證據（見 heartbeat.ts 的 getLastHeartbeatResult）。
      //
      // **`null` ＝ 還沒打過任何一拍，也就是「不知道」**（a7-D15：null 必須貫穿，
      // 不得在任何一段被壓成 false/0）。本函式在 :220 開機當下就跑第一輪，與
      // `startMonitorHeartbeat()` 的首拍是競跑的——舊寫法 `=== 'written'` 會把
      // 這個必然發生的起步期回報成 `false`＝「該台監控 DB 不可寫」，那是**捏造的
      // 壞消息**，會讓 (e) 的告警文字冤枉一台其實好好的機器。
      db_writable: toTriState(getLastHeartbeatResult('worker-agent')),
    })
    if (!ok) console.error('worker-agent: monitor-status 回報失敗（head 打不到），下一輪重試')
  } catch (err) {
    // best-effort：回報失敗絕不影響本行程任何其他職責。
    console.error(`worker-agent: monitor-status 回報時發生例外: ${err}`)
  }
}

if (isMonitorDbEnabled()) {
  void reportMonitorStatus()
  setInterval(() => void reportMonitorStatus(), MONITOR_STATUS_TICK_MS)
}

// ---- HTTP 介面 ----

const app = new Hono()
const guard = createClusterAuthGuard(secret)

app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.text('Bad Request', 400)
  console.error(`worker-agent unhandled error: ${err}`)
  return c.text('Internal Server Error', 500)
})

// 比照 server.ts /health 的紀律：不驗證（LAN 監控/doctor 腳本探測用），
// 內容只有存活資訊，不出現 worker 名稱、ticket、名額等業務細節。
app.get('/health', c => c.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }))

app.get('/capacity', guard, c => {
  // ?ticket=：head 派工前順路問「這張單在本機有沒有活動」（C-1 healing 的
  // 資料來源），一次請求兩個答案，不佔用額外的認領熱路徑預算。
  const probe = c.req.query('ticket')
  const ticket = probe !== undefined && (BUG_TICKET_RE.test(probe) || DEMAND_TICKET_RE.test(probe)) ? probe : null
  return c.json({
    worker: workerName,
    bug: effectiveStats('bug'),
    demand: effectiveStats('demand'),
    ...(ticket !== null ? { ticket: { ticket, active: localActivity.isActive(ticket) } } : {}),
  })
})

// 維護模式（2026-09-08，tg-monitor 手動控制）：GET 給 tg-monitor 輪詢顯示
// 現況（worker 在遠端機器，tg-monitor 沒有本機檔案可讀，跟 head 那份用
// listWorkers() 直讀 JSON 檔的做法不同，見 lib/maintenance/mode-store.ts
// 檔頭）；POST 切換，效果只影響下面 /jobs 這一台，不會被 head 轉發。
app.get('/maintenance', guard, c => c.json({ on: maintenanceMode.isOn() }))

app.post('/maintenance', guard, async c => {
  const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null
  if (!body || typeof body.on !== 'boolean') return c.json({ ok: false, reason: 'bad_request' }, 400)
  maintenanceMode.setOn(body.on)
  console.error(`worker-agent: 維護模式已${body.on ? '開啟' : '關閉'}（${workerName}）`)
  return c.json({ ok: true, on: body.on })
})

// body 欄位驗證（值會流進 tg-notify.sh 參數與落盤的 queue.json）：head 端
// 這些值來自 tech-users.csv，worker 端對等地上一道廉價格式閘——不含控制
// 字元、長度有界；email 另驗基本樣式。
const SAFE_TEXT_RE = /^[^\x00-\x1f\x7f]{1,128}$/
const EMAIL_RE = /^[^\s@\x00-\x1f\x7f]{1,64}@[^\s@\x00-\x1f\x7f]{1,190}$/

/** triggeredBy 來自網路 body：只收白名單欄位、逐一驗格式，不把整個物件
 * 原樣往 submit 傳（防夾帶）。格式不合直接當沒帶（通知屬 best-effort）。 */
function sanitizeTriggeredBy(raw: unknown): TechUser | undefined {
  const o = raw as { notion_user_id?: unknown; notion_user_name?: unknown; email?: unknown } | null
  if (!o || typeof o.notion_user_name !== 'string' || typeof o.email !== 'string') return undefined
  if (!SAFE_TEXT_RE.test(o.notion_user_name) || !EMAIL_RE.test(o.email)) return undefined
  return {
    notion_user_id: typeof o.notion_user_id === 'string' && SAFE_TEXT_RE.test(o.notion_user_id) ? o.notion_user_id : '',
    notion_user_name: o.notion_user_name,
    email: o.email,
  }
}

/** monitor DB `dispatch_attempts.dispatch_id`（UUIDv4，head 端鑄造，見
 * lib/cluster/worker-client.ts 的 JobRequest.dispatchId 註解）的格式檢查。 */
const DISPATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** body 帶的 dispatchId 格式不對就當沒帶——這欄目前只是協定層佔位（見下方
 * /jobs handler 註解），格式錯誤不該擋接單。 */
function sanitizeDispatchId(raw: unknown): string | null {
  return typeof raw === 'string' && DISPATCH_ID_RE.test(raw) ? raw : null
}

/** SubmitResult 的 `runId` 只在 started/queued 兩個變體上存在（見
 * lib/pipeline-runner/pipeline-queue.ts 的型別註解），其餘變體（already_running、
 * ok:false）完全沒有這個欄位——用 `in` 窄化而不是直接存取，避免對 union
 * 的非共同屬性硬存取。demand 路徑（submitDemandPipeline）目前還沒有鑄
 * run_id，這裡會自然回 null，跟「還沒有」的協定語意一致。 */
function extractRunId(result: SubmitResult): string | null {
  return 'runId' in result && typeof result.runId === 'string' ? result.runId : null
}

app.post('/jobs', guard, async c => {
  // 維護模式（2026-09-08）：排在最前面，body 驗證之前——維護期間這台自己
  // 絕不 spawn 任何背景流程，不管 head 傳了什麼都直接拒絕。
  //
  // ⚠️ 注意這只保證「這台不執行」，不保證「這張單完全沒人執行」：
  // dispatch.ts 的 dispatchBug/dispatchDemand 把這個 503 當成一般的
  // full/rejected/unreachable 拒絕理由處理，會 clear 派工登記、退回本機
  // （submitLocal()）——跟現有「worker 名額已滿」「worker 連不上」「worker
  // 被停用」踩到同一條 fallback，行為一致，不是新問題。也就是說：只單獨
  // 開這一台的維護模式、head 本身沒開，這張單會改在 head 執行，不會停在候選
  // 池不受理。要達成「這張單完全不受理」，head 自己的維護模式旗標
  // （cluster-head.ts 的 isMaintenanceModeOn()）也要一起開——tg-monitor 的
  // 一鍵切換本來就是 head + 全部 worker 一起打，就是為了避免只開這一台。
  if (maintenanceMode.isOn()) return c.json({ ok: false, reason: 'maintenance' }, 503)
  const body = (await c.req.json().catch(() => null)) as
    | { kind?: string; ticket?: string; resume?: boolean; mode?: unknown; triggeredBy?: unknown; assigneeEmail?: string; dispatchId?: unknown }
    | null
  if (!body || typeof body.ticket !== 'string') return c.json({ ok: false, reason: 'bad_request' }, 400)
  // mode（plan-pipeline-modes-v1 §2.2）：值域封閉，會進 claude -p 的 prompt
  // 位置參數——來自網路的值不在 BUG_MODES 內就整個請求拒絕，不「當沒帶」
  // （當沒帶會把同事選的「只做問題分析」靜默跑成一鍵，比 400 更糟）。
  if (body.mode !== undefined && !isBugMode(body.mode)) return c.json({ ok: false, reason: 'bad_request' }, 400)
  const mode = body.mode as BugMode | undefined
  const triggeredBy = sanitizeTriggeredBy(body.triggeredBy)
  // §5.3：head 隨請求帶 dispatch_id，本機鑄 run_id 時把它一併寫進
  // runs.dispatch_id（形狀 A COALESCE 補空欄），讓
  // dispatch_attempts.dispatch_id = runs.dispatch_id 可以精確 join（整合修補
  // 批次 item 6：submitCreateMr/submitDemandPipeline 已開放接受這個參數）。
  const dispatchId = sanitizeDispatchId(body.dispatchId)

  // C-1 修正：這張單在本機已有任何活動（含 out-of-band run）→ 不接單、
  // 不 spawn，回 already_running 讓 head 把登記表回填指向本機。絕不能讓
  // 新 run 撞上活 run（新 run 早退時的 EXIT trap 會 release 活 run 的鎖並
  // 清它的 worktree）。
  if (localActivity.isActive(body.ticket)) {
    // out-of-band run：這張單本機已有活動，不是這次 /jobs 呼叫鑄的 run，
    // 依 §5.4 回應註解「已在跑」不附這次呼叫的 run_id。
    return c.json({ ok: true, status: 'already_running', run_id: null })
  }

  if (body.kind === 'bug') {
    if (!BUG_TICKET_RE.test(body.ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
    const stats = effectiveStats('bug')
    if (stats.queued > 0 || stats.running >= stats.limit) return c.json({ ok: false, reason: 'full' }, 409)
    // 比照 head 端 claim.ts：spawn 前先確保本機 tracker 有這張單（/create-mr
    // Step 0 的存在性檢查讀的是「執行機」的 tracker，不是 head 的）。
    // ensure-pending 之前先把 head 那份完整抓下來覆蓋——tracker.sh 對「檔案
    // 不存在」是直接 exit 1，ensureTrackerPending 會靜默失敗，Step 0.1 就
    // 判 not claimable（2026-09-03 事故，見 tracker-sync.ts 檔內說明）。
    await pullTrackerFromHead(body.ticket)
    ensureTrackerPending(body.ticket)
    const result = submitCreateMr(body.ticket, { resume: body.resume === true, mode, triggeredBy, dispatchId: dispatchId ?? undefined })
    // §5.4：submitCreateMr 現在會在 started/queued 兩種狀態鑄 run_id 並疊加進
    // SubmitResult（見 pipeline-queue.ts 的 SubmitResult.runId 註解）——直接
    // 透傳給 head，不需要另外維護 in-process Map<ticket, runId>。
    return c.json({ ...result, run_id: extractRunId(result) }, result.ok ? 200 : 500)
  }

  if (body.kind === 'demand') {
    if (!DEMAND_TICKET_RE.test(body.ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
    if (typeof body.assigneeEmail !== 'string' || !EMAIL_RE.test(body.assigneeEmail)) return c.json({ ok: false, reason: 'bad_request' }, 400)
    const stats = effectiveStats('demand')
    if (stats.queued > 0 || stats.running >= stats.limit) return c.json({ ok: false, reason: 'full' }, 409)
    const result = submitDemandPipeline(body.ticket, body.assigneeEmail, triggeredBy, dispatchId ?? undefined)
    // demand 路徑（submitDemandPipeline）目前尚未鑄 run_id（見該檔案），
    // extractRunId 會自然回 null；等它補上就自動生效，這裡不需要再改。
    return c.json({ ...result, run_id: extractRunId(result) }, result.ok ? 200 : 500)
  }

  return c.json({ ok: false, reason: 'bad_request' }, 400)
})

app.get('/jobs/:ticket', guard, c => {
  const ticket = c.req.param('ticket')
  if (!BUG_TICKET_RE.test(ticket) && !DEMAND_TICKET_RE.test(ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
  const locked = isTicketLocked(ticket)
  // queueState 的語意升級為「本機活動狀態」：queue 認得的照實回 running/
  // queued；queue 看不到但鎖/ps 看得到的 out-of-band run 回 'running'——
  // head 的 sweeper 靠這個判斷「還在跑」，失明會導致誤清登記（C-1）。
  const fromQueue = BUG_TICKET_RE.test(ticket) ? hasBugTicketActive(ticket) : hasDemandTicketActive(ticket)
  const queueState = fromQueue ?? (localActivity.isActive(ticket) ? 'running' : null)
  return c.json({
    ticket,
    locked,
    queueState,
    progress: locked ? describeTicketProgress(ticket) : null,
    stages: locked ? getTicketProgressStages(ticket) : [],
  })
})

// 取消本機正在跑的一張單（2026-09-04 新增，同一套 auth guard）：演算法見
// lib/pipeline-runner/local-cancel.ts 檔頭——ps 快照找出 wrapper pid、展開
// 子孫、最深先 SIGTERM，1.5 秒後 wrapper 補 TERM，5 秒後殘留補 KILL。回應
// 形狀比照 tg-monitor 的 /api/pipelines/cancel（CancelPipelineResult）。
app.post('/jobs/:ticket/cancel', guard, async c => {
  const ticket = c.req.param('ticket')
  const kind = BUG_TICKET_RE.test(ticket) ? 'bug' : DEMAND_TICKET_RE.test(ticket) ? 'demand' : null
  if (!kind) return c.json({ ok: false, reason: 'bad_request' }, 400)
  const r = await cancelLocalPipeline(kind, ticket)
  console.error(`worker-agent: cancel ${kind} ${ticket}: ${JSON.stringify(r)}`)
  return c.json(r, r.ok ? 200 : 409)
})

// 唯讀讀取白名單目錄下的檔案內容（2026-09-04 新增，task 1）：head 的
// tg-monitor `/api/agent-trace` 對 worker 執行的 run proxy 過來用。白名單
// 規則逐字比照 tg-monitor/lib/services.ts 的 isAllowedTracePath，見
// lib/pipeline-runner/local-trace-read.ts 檔頭——不接受這個白名單以外的路徑，
// 拒絕就是拒絕，不嘗試「猜測使用者真正想讀哪個檔案」之類的寬鬆化。
app.get('/files', guard, c => {
  const path = c.req.query('path') ?? ''
  const r = readLocalTraceFile(path)
  if (!r.ok) {
    const status = r.reason === 'not_allowed' ? 403 : r.reason === 'missing' ? 404 : 500
    return c.json({ ok: false, reason: r.reason, detail: r.detail }, status)
  }
  return c.json({ ok: true, content: r.content })
})

// 這張 bug 票的階段產物檔存在與否＋mtime（2026-09-04 新增，task 1）：head 的
// computeBugStages() 組裝階段檢核表用，不論這張票目前有沒有鎖（跟
// GET /jobs/:ticket 的 stages 欄位不同——那個只在 locked 時才有值，服務的是
// TG bot「還在跑」的即時進度；這支給歷史 run 的檢核表用，鎖釋放後檔案仍在，
// 一樣要能讀到）。見 lib/pipeline-runner/local-stage-files.ts 檔頭。
app.get('/jobs/:ticket/stage-files', guard, c => {
  const ticket = c.req.param('ticket')
  if (!BUG_TICKET_RE.test(ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
  return c.json({ ok: true, ...readLocalStageFiles(ticket) })
})

// 這張 bug 票此刻正在跑哪個 stage／哪位 agent（2026-09-04 新增，task 2）：
// head 的 computeBugStages() 靠這支端點把 running 那一列標出來——本機
// inferCurrentBugStage() 掃的是本機 `~/.claude/projects/...` transcript，只有
// 執行機自己讀得到，見 lib/pipeline-runner/local-current-stage.ts 檔頭。
// `startedAt` 必須是這次 run 的 started_at（ISO 字串），用來錨定應該掃哪一份
// transcript——格式不對就當沒帶（安全回退成 stage:null，不擋請求）。
app.get('/jobs/:ticket/current-stage', guard, c => {
  const ticket = c.req.param('ticket')
  if (!BUG_TICKET_RE.test(ticket)) return c.json({ ok: false, reason: 'bad_request' }, 400)
  const startedAt = c.req.query('startedAt') ?? ''
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) return c.json({ ok: false, reason: 'bad_request' }, 400)
  return c.json({ ok: true, stage: inferCurrentBugStage(ticket, startedAt) })
})

app.all('*', c => respondUniform401(c))

const port = Number(process.env.CLUSTER_WORKER_PORT ?? 8801)
console.error(`worker-agent: ${workerName} 監聽 0.0.0.0:${port}，head=${headUrl}`)

export default {
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
}
