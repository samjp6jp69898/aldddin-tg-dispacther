import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawnDetachedProcess, notifyQueueEvent, makeQueueSkipReason } from './spawn-create-mr.ts'
import { DEMAND_CONCURRENCY_LIMIT, createConcurrencyLimiter } from './concurrency-limiter.ts'
import { createPipelineQueue, type QueueEntry, type QueueTriggeredBy, type SubmitResult } from './pipeline-queue.ts'
import { markPipelineActive, clearPipelineActive } from './active-pipeline-marker.ts'
import { getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SPAWN_ERROR_LOG = join(LOG_DIR, 'spawn-errors.log')
const RUN_DEMAND_PIPELINE_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/run-demand-pipeline.ts'
const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'

// review 發現：run-demand-pipeline.ts 內部每個外部呼叫都各自有 timeout，
// 但整支腳本本身沒有一個外層總時限——跟 create-mr 的 WRAPPER_SCRIPT 用
// `timeout 7200` 包住整條 pipeline、且用 bash EXIT trap 保證『不管 claude -p
// 是正常結束還是被 timeout 殺，鎖都會釋放』不同，這裡原本只靠 TypeScript
// try/finally，一旦這支 Bun 腳本本身被外部機制強制終止（SIGKILL 不可被
// try/finally 攔截），鎖永遠不會釋放。已改成比照 spawn-create-mr.ts 的
// WRAPPER_SCRIPT 模式：bash 包一層 `timeout` + EXIT trap，鎖釋放交給 bash
// trap 做最後一道安全網（run-demand-pipeline.ts 內部的 try/finally release
// 仍是主要路徑，正常結束時就會執行；trap 只在它沒機會執行時補上，
// bug-lock.sh release 對已釋放的鎖是 no-op，兩邊都呼叫無害）。
const TICKET_RE = /^ALDREQ-\d+$/
const OUTER_TIMEOUT_SECONDS = 7200 // 跟 create-mr 的既有值一致，run-demand-pipeline.ts 內部各步驟 timeout 加總的最壞情況遠低於這個值

const WRAPPER_SCRIPT = `
trap '
  EC=$?
  bash ${BUG_LOCK_SH} release "$1" >/dev/null 2>&1
  if [ "$EC" -ne 0 ]; then
    bash ${TG_NOTIFY_SH} --email "$2" --text "⚠️ $1 需求 pipeline 異常終止（exit=$EC，可能是被逾時強制中止），請人工檢查 logs/demand-pipeline.log 與工作目錄 worktrees/$1/。" >/dev/null 2>&1
  fi
' EXIT
timeout ${OUTER_TIMEOUT_SECONDS} bun ${RUN_DEMAND_PIPELINE_TS} "$1" "$2"
`

// 需求 pipeline 的全域併發上限跟 Bug pipeline（T26，N=5）不共用同一個計數器，
// 用獨立的計數器。上限常數（N=6，2026-08-27 使用者定案）2026-08-28 搬到
// concurrency-limiter.ts 集中管理（同時供 tg-monitor 經 CLI 讀取），歷史脈絡
// 見該檔註解。
const concurrencyLimiter = createConcurrencyLimiter(DEMAND_CONCURRENCY_LIMIT)

/**
 * T36：claim 成功後 fire-and-forget 觸發 run-demand-pipeline.ts（見該檔案
 * 檔頭註解說明完整流程），外層包一層 bash timeout + EXIT trap（見上方
 * WRAPPER_SCRIPT 註解）。介面比照 submitCreateMr（T11/T26；2026-08-28 起
 * 額滿改排隊，不再拒絕）：有名額直接 spawn，額滿排入 FIFO 佇列；spawn 本身
 * 失敗（磁碟/fd 用盡等）要接住，不讓已佔用的名額卡死、也不讓例外一路炸穿到
 * claim 端變成使用者收不到任何回覆。
 *
 * review 發現：跟 spawn-create-mr.ts 的 TICKET_RE 對等的格式防護原本漏掉
 * ——這裡不是唯一防線（demand-claim.ts 的 stillCandidate 檢查已經先擋過
 * 一次），但 run-demand-pipeline.ts 本身是可獨立執行的 CLI 進入點，缺這道
 * 防護會讓「脫離 demand-claim.ts 呼叫鏈直接呼叫」的情境完全沒有格式檢查，
 * 已補上，防禦深度跟 Bug pipeline 對等。
 */
// 2026-08-28（使用者定案）：額滿改排隊，結構比照 spawn-create-mr.ts——
// spawnDemandPipelineNow 只負責真正起背景流程，額度與 FIFO 佇列交給
// demandQueue（見 pipeline-queue.ts 檔頭註解）。
type DemandPayload = { assigneeEmail: string }

function spawnDemandPipelineNow(entry: QueueEntry<DemandPayload>, onExit: () => void): { ok: true; pid: number | undefined } | { ok: false } {
  const { ticket } = entry
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${ticket}.${timestamp}.demand-pipeline`
    const stdoutPath = join(LOG_DIR, `${base}.stdout.log`)
    const stderrPath = join(LOG_DIR, `${base}.stderr.log`)

    // 比照 spawn-create-mr.ts 同名 sidecar 機制，見該檔案註解。
    if (entry.triggeredBy) {
      try {
        writeFileSync(
          join(LOG_DIR, `${base}.triggered-by.json`),
          JSON.stringify({ name: entry.triggeredBy.name, email: entry.triggeredBy.email, at: new Date().toISOString() }),
        )
      } catch {
        // best-effort，理由同 spawn-create-mr.ts。
      }
    }

    // T26 review 修正：標記「這張需求單是 dispatcher 觸發的」，理由與作法比照
    // spawn-create-mr.ts（見 active-pipeline-marker.ts 檔頭註解）——
    // stale-lock-reaper.ts 只會對有這份標記的 ticket 動手。
    markPipelineActive(ticket)

    const pid = spawnDetachedProcess('bash', ['-c', WRAPPER_SCRIPT, 'run-demand-pipeline', ticket, entry.payload.assigneeEmail], {
      cwd: '/Users/user/aladdin/telegram-dispatcher',
      stdoutPath,
      stderrPath,
      // 順序硬約束（對抗性 review 2026-08-28）：clearPipelineActive 必須在
      // onExit() 之前，理由見 spawn-create-mr.ts 同位置註解。
      onExit: () => {
        clearPipelineActive(ticket)
        onExit()
      },
    })
    return { ok: true, pid }
  } catch (err) {
    clearPipelineActive(ticket)
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawnDemandPipeline 失敗（${ticket}）: ${err}\n`)
    return { ok: false }
  }
}

const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'

/**
 * 對抗性 review 2026-08-28 round 2 發現（E）：需求單在 demand-claim.ts 認領
 * 當下就被標成 AI分析=分析中，而候選單 filter（demand-pool-tickets.ts 的
 * WANTED_AI_ANALYSIS）只認 待分析/需要重跑——排隊中的單被移除（逾時）或
 * 輪到時啟動失敗後，若不把 AI分析 改回可認領值，這張單會永遠卡在「分析中」
 * 且無任何流程在跑，/req 列不出來、通知裡的「請重新認領」在結構上做不到。
 * 這裡 best-effort 改回「需要重跑」（唯一同時語意正確且在 filter 白名單內的
 * 值）；失敗只記 log 並回 false，呼叫端據此調整通知文案（不能宣稱已改回）。
 * 注意只有 expired / 啟動失敗 這兩種「確定沒有流程在跑」的情況能呼叫——
 * locked（別的流程正在跑）絕不能動，那個流程的 finalize 會自己更新 AI分析。
 * 同步 execFileSync（最壞 60 秒）跟 demand-claim.ts 的既有寫法一致；只在
 * 佇列移除/啟動失敗這種低頻路徑觸發，且被 pipeline-queue 的 safeHook 包住，
 * 例外不會外洩。
 */
export function resetAiAnalysisForReclaim(ticket: string): boolean {
  try {
    const url = getDemandTicketNotionUrl(ticket)
    if (url === null) {
      console.error(`spawn-demand-pipeline: ${ticket} 找不到 Notion 頁面，無法把 AI分析 改回「需要重跑」`)
      return false
    }
    execFileSync('bash', [NOTION_SH, 'update-prop', url, 'AI分析', 'select', '需要重跑'], { encoding: 'utf8', timeout: 30_000 })
    return true
  } catch (err) {
    console.error(`spawn-demand-pipeline: ${ticket} AI分析 改回「需要重跑」失敗: ${err}`)
    return false
  }
}

/** expired／啟動失敗共用的收尾＋通知（locked 不走這裡）。 */
function releaseTicketAndNotify(entry: QueueEntry<DemandPayload>, situation: string): void {
  const reset = resetAiAnalysisForReclaim(entry.ticket)
  notifyQueueEvent(
    entry.triggeredBy,
    reset
      ? `ℹ️ ${entry.ticket} ${situation}，Notion AI分析 已改回「需要重跑」。若仍需要分析，請重新認領一次。`
      : `⚠️ ${entry.ticket} ${situation}，且 Notion AI分析 改回「需要重跑」失敗（目前仍停在「分析中」）——請人工到 Notion 把 AI分析 改成「需要重跑」後重新認領，或聯絡維運人員。`,
  )
}

const demandQueue = createPipelineQueue<DemandPayload>({
  limiter: concurrencyLimiter,
  stateFile: join(LOG_DIR, 'pipeline-queue.demand.json'),
  ticketRe: TICKET_RE,
  spawnNow: spawnDemandPipelineNow,
  // 出列/恢復時的前提重驗與時效上限，理由見 spawn-create-mr.ts 的
  // makeQueueSkipReason 註解（需求單的鎖同樣是 /tmp/bug-analysis-locks/
  // {ALDREQ-xxx}，isTicketLocked 直接適用）。
  skipReason: makeQueueSkipReason<DemandPayload>(),
  onSkipped: (entry, reason) => {
    if (reason.code === 'locked') {
      // 別的流程正在跑：它的 finalize 會自行更新 AI分析 與留言，這裡絕不能
      // 動 Notion（見 resetAiAnalysisForReclaim 註解），只告知不用重複認領。
      notifyQueueEvent(entry.triggeredBy, `ℹ️ ${entry.ticket} 已從等待佇列移除：${reason.text}。該流程會自行回報結果，不需要重新認領。`)
      return
    }
    releaseTicketAndNotify(entry, `已從等待佇列移除（${reason.text}）`)
  },
  onDequeueStarted: entry =>
    notifyQueueEvent(entry.triggeredBy, `▶️ ${entry.ticket} 排隊結束，需求 pipeline 已自動開始評估規格與範圍，完成後會再通知你。`),
  onDequeueFailed: entry => releaseTicketAndNotify(entry, `輪到執行時背景流程啟動失敗（詳見 spawn-errors.log）`),
  onExited: ticket => {
    for (const cb of demandExitListeners) {
      try {
        cb(ticket)
      } catch (err) {
        console.error(`spawn-demand-pipeline: exit listener 失敗（${ticket}）: ${err}`)
      }
    }
  },
})

// 多機派工（lib/cluster/）用的旁路出口，介面說明比照 spawn-create-mr.ts。
const demandExitListeners: Array<(ticket: string) => void> = []

export function registerDemandPipelineExitListener(cb: (ticket: string) => void): void {
  demandExitListeners.push(cb)
}

export function getDemandQueueStats(): { limit: number; running: number; queued: number } {
  return { limit: DEMAND_CONCURRENCY_LIMIT, running: demandQueue.runningCount(), queued: demandQueue.size() }
}

export function hasDemandTicketActive(ticket: string): 'running' | 'queued' | null {
  return demandQueue.has(ticket)
}

export function getDemandRunningTickets(): string[] {
  return demandQueue.runningTickets()
}

/** 提交一張需求單：有名額直接 spawn、額滿排入 FIFO 佇列（回覆順位）、已在
 * 排隊中則回 already_queued。介面說明比照 submitCreateMr。 */
export function submitDemandPipeline(ticket: string, assigneeEmail: string, triggeredBy?: TechUser): SubmitResult {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }
  const by: QueueTriggeredBy = triggeredBy ? { name: triggeredBy.notion_user_name, email: triggeredBy.email } : null
  return demandQueue.submit(ticket, by, { assigneeEmail })
}

/** 只給 server.ts 啟動時呼叫一次（CLI 短命行程絕不能呼叫，見 pipeline-queue.ts
 * recoverFromDisk 註解）。 */
export function recoverDemandQueue(): { started: number; requeued: number; skipped: number } {
  return demandQueue.recoverFromDisk()
}
