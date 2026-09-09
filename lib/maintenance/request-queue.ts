import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TechUser } from '../user-resolution/tech-user.ts'

// 維護模式期間的認領請求佇列（2026-09-09 使用者定案）：維護中不再對 Bug／
// 需求單認領零副作用直接拒絕（見 mode-store.ts 舊版 MAINTENANCE_MESSAGE 的
// 行為），改成照收、記下 ticket／認領人，FIFO 排隊；維護結束時依收到順序
// 逐一重新丟回 claimBugTicket／claimDemandTicket **完整重跑一次**（Notion
// 候選重驗、鎖、既有併發 FIFO 佇列全部照舊套用，不另外做簡化版判斷）——
// 收下當下零驗證、真正驗證留到要 spawn 前，跟 pipeline-queue.ts 對「排隊
// 期間工單狀態可能已變」的既有處理精神一致（見該檔 skipReason 的 TOCTOU
// 註解）。
//
// 只有 head 行程（cluster-head.ts）需要這份佇列：claim.ts／demand-claim.ts
// 的認領入口只跑在 head 上，worker 自己的維護旗標只管 /jobs 要不要接單，
// 不受理認領（見 mode-store.ts 檔頭「belt-and-braces」說明）。
//
// 避免循環 import：cluster-head.ts 要在維護關閉時觸發重新處理，但 claim.ts
// 已經 import cluster-head.ts（拿 isMaintenanceModeOn／dispatchBug 等）——若
// 本檔直接 import claim.ts 再讓 cluster-head.ts import 本檔，會形成
// cluster-head → request-queue → claim → cluster-head 的循環。改用注入式的
// processor 註冊：claim.ts／demand-claim.ts 在模組載入當下各自註冊「重新
// 完整跑一次自己的 claimXxxTicket」callback，本檔完全不知道 claim.ts 的存在，
// cluster-head.ts 只需要 import 本檔的 drainMaintenanceQueue()。
//
// 工廠函式 + 模組底部單例（比照 spawn-create-mr.ts 的 bugQueue／
// spawn-demand-pipeline.ts 的 demandQueue 包一層具名函式匯出的既有慣例）：
// 核心邏輯吃 stateFile 參數，讓 request-queue.test.ts 可以用隔離的暫存檔
// 完整測試，不用碰正式部署讀寫的 logs/maintenance-request-queue.json。

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const STATE_FILE = join(LOG_DIR, 'maintenance-request-queue.json')
const TICKET_RE = /^(FAQ|ALDREQ)-\d+$/

const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'

export type MaintenanceQueueKind = 'bug' | 'demand'

export type MaintenanceQueueEntry = {
  kind: MaintenanceQueueKind
  ticket: string
  techUser: TechUser
  enqueuedAt: string
}

export type MaintenanceEnqueueResult =
  /** position = 1-based 排隊順位；ahead = 前面還有幾張單（= position - 1）。 */
  | { status: 'queued'; position: number; ahead: number }
  | { status: 'already_queued'; position: number; ahead: number }

export type MaintenanceProcessor = (entry: MaintenanceQueueEntry) => Promise<void>

function isValidTechUser(u: unknown): u is TechUser {
  const o = u as Partial<TechUser> | null
  return !!o && typeof o.notion_user_name === 'string' && typeof o.email === 'string' && typeof o.notion_user_id === 'string'
}

export type MaintenanceRequestQueue = {
  enqueue: (kind: MaintenanceQueueKind, techUser: TechUser, ticket: string) => MaintenanceEnqueueResult
  registerProcessor: (kind: MaintenanceQueueKind, fn: MaintenanceProcessor) => void
  size: () => number
  drainAll: () => Promise<void>
  recoverFromDisk: () => void
}

export function createMaintenanceRequestQueue(stateFile: string): MaintenanceRequestQueue {
  const queue: MaintenanceQueueEntry[] = []
  const processors: Partial<Record<MaintenanceQueueKind, MaintenanceProcessor>> = {}
  // persist 啟用旗標：比照 pipeline-queue.ts，只有常駐 server 啟動時呼叫過
  // recoverFromDisk() 才真的寫檔，短命 CLI 行程絕不能落地覆蓋掉常駐 server
  // 的共用快照檔。
  let persistEnabled = false

  function persist(): void {
    if (!persistEnabled) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), entries: queue }, null, 2))
      renameSync(tmp, stateFile)
    } catch (err) {
      console.error(`maintenance-request-queue: 寫入 ${stateFile} 失敗: ${err}`)
    }
  }

  /** 維護中收到一筆 Bug／需求單認領請求：零驗證照收，只記 FIFO 位置。同一張
   * 單（同 kind+ticket）在維護期間重複送出（同事連點）視為已排隊，不重複
   * 佔位。 */
  function enqueue(kind: MaintenanceQueueKind, techUser: TechUser, ticket: string): MaintenanceEnqueueResult {
    const existingIdx = queue.findIndex(e => e.kind === kind && e.ticket === ticket)
    if (existingIdx >= 0) return { status: 'already_queued', position: existingIdx + 1, ahead: existingIdx }
    queue.push({ kind, ticket, techUser, enqueuedAt: new Date().toISOString() })
    persist()
    return { status: 'queued', position: queue.length, ahead: queue.length - 1 }
  }

  /** claim.ts／demand-claim.ts 各自在模組載入當下註冊自己的「重新完整跑一次
   * claimXxxTicket」callback（理由見檔頭循環 import 說明）。同一個 kind 重複
   * 註冊視為覆蓋，正常情況下每個 kind 一輩子只會註冊一次（模組只載入一次）。 */
  function registerProcessor(kind: MaintenanceQueueKind, fn: MaintenanceProcessor): void {
    processors[kind] = fn
  }

  function size(): number {
    return queue.length
  }

  /** 維護結束時呼叫：依 FIFO 原順序逐一出列——每處理一筆才把那一筆從佇列
   * shift 掉並落盤（不是一開始就把整條佇列清空落盤），序列處理、不平行：
   * 一來保留嚴格先進先出的處理順序，二來不會在維護剛結束的瞬間對 Notion
   * 打一整批平行請求。單筆處理丟例外只記 log、不中斷後面的單（防護網壞掉
   * 不該讓整條佇列卡死）。
   *
   * 崩潰安全（對抗性 review 2026-09-09 發現：一開始就 splice 整條佇列會讓
   * 狀態檔立刻變空，之後逐筆處理全部只活在這次呼叫的記憶體堆疊裡——head
   * process 若在中途意外重啟，尚未處理到的單會被靜默弄丟，server.ts 的
   * 重啟安全網其實救不回來）：改成「一次只出列一筆、出列當下立刻 persist」
   * 之後，任何時間點重啟，狀態檔上剩的就是真的還沒處理到的那些單，
   * server.ts 的 recoverMaintenanceQueue()＋補跑安全網才名副其實。最多只會
   * 弄丟『正在處理中的那一筆』（persist 之後、proc 執行完之前當機），同事
   * 重新點一次原本的認領按鈕即可補回。
   *
   * 迴圈次數先用 `n = queue.length` 快照、而不是 `while (queue.length > 0)`：
   * processor 內部（claim.ts 的 claimBugTicket 等）會重新檢查
   * isMaintenanceModeOn()——若維護在這次 drain 跑到一半時又被重新開啟，
   * 剩下還沒處理到的單會被 claimBugTicket 自己重新 enqueue 回佇列尾端（等於
   * 自我修正）；用 `while` 迴圈會把這些剛被推回尾端的單當成「還沒處理過」
   * 繼續往下跑，永遠出不了迴圈。用快照的 `n` 只處理『這次呼叫開始時就已經
   * 在佇列裡』的那批，被推回尾端的單留給下一次維護結束時的 drain 處理——
   * 相對順序可能因此跟這期間真正新收到的請求交錯，不保證絕對全域 FIFO，
   * 這種情況極罕見（維運者在 drain 進行中手動切回維護），不特別處理。 */
  async function drainAll(): Promise<void> {
    const n = queue.length
    for (let i = 0; i < n; i++) {
      const entry = queue.shift()
      if (!entry) break // 理論上不會發生：期間只有本函式自己會消耗佇列前端
      persist()
      const proc = processors[entry.kind]
      if (!proc) {
        console.error(`maintenance-request-queue: ${entry.ticket} 沒有註冊 ${entry.kind} 的 processor，跳過（不應發生，claim.ts／demand-claim.ts 應該都在模組載入時註冊過）`)
        continue
      }
      try {
        await proc(entry)
      } catch (err) {
        console.error(`maintenance-request-queue: 重新處理 ${entry.ticket} 失敗: ${err}`)
      }
    }
  }

  /** server 啟動時撿回上次還沒處理完的佇列（比照 pipeline-queue.ts 的
   * recoverFromDisk：只有常駐 server 啟動時呼叫一次，短命 CLI 行程絕不能
   * 呼叫）。ticket 格式不合法／techUser 欄位不全的條目（狀態檔被竄改/半寫壞）
   * 直接丟棄。 */
  function recoverFromDisk(): void {
    persistEnabled = true
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { entries?: unknown }
      if (Array.isArray(parsed.entries)) {
        for (const raw of parsed.entries) {
          const e = raw as Partial<MaintenanceQueueEntry> | null
          if (e && (e.kind === 'bug' || e.kind === 'demand') && typeof e.ticket === 'string' && TICKET_RE.test(e.ticket) && isValidTechUser(e.techUser) && typeof e.enqueuedAt === 'string') {
            queue.push({ kind: e.kind, ticket: e.ticket, techUser: e.techUser, enqueuedAt: e.enqueuedAt })
          }
        }
      }
    } catch {
      // 檔案不存在或壞掉都當空佇列；下面 persist 會把檔案重寫成目前實況。
    }
    persist()
  }

  return { enqueue, registerProcessor, size, drainAll, recoverFromDisk }
}

// ── 模組單例（head 常駐 server 實際使用的那份，正式狀態檔路徑）──────────
const requestQueue = createMaintenanceRequestQueue(STATE_FILE)

export const enqueueMaintenanceRequest = requestQueue.enqueue
export const registerMaintenanceProcessor = requestQueue.registerProcessor
export const maintenanceQueueSize = requestQueue.size
export const drainMaintenanceQueue = requestQueue.drainAll
export const recoverMaintenanceQueue = requestQueue.recoverFromDisk

/** 排隊中的單輪到並重新處理完畢後通知當初認領的人——原本的 TG/Web UI
 * 互動早已結束，改用 tg-notify.sh 主動私訊（fire-and-forget，理由同
 * spawn-create-mr.ts 的 notifyQueueEvent：tg-notify.sh 本身永遠 exit 0，
 * 失敗只印一行，不阻斷 drain 流程）。 */
export function notifyMaintenanceOutcome(techUser: TechUser, text: string): void {
  execFile('bash', [TG_NOTIFY_SH, '--email', techUser.email, '--text', text], () => {})
}
