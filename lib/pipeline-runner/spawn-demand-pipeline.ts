import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawnDetachedProcess, notifyQueueEvent, makeQueueSkipReason, dispatchMonitorWrite } from './spawn-create-mr.ts'
import { DEMAND_CONCURRENCY_LIMIT, createConcurrencyLimiter } from './concurrency-limiter.ts'
import { createPipelineQueue, type QueueEntry, type QueueTriggeredBy, type RecoverFromDiskResult, type SubmitResult } from './pipeline-queue.ts'
import { markPipelineActive, clearPipelineActive } from './active-pipeline-marker.ts'
import { getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'
import { mintRunId, readInheritedRunId } from './demand-monitor-writes.ts'
import { writeRunProgress, writeRunOutcomeAuthoritative } from '../monitor-db/writes.ts'
import type { RunKind } from '../monitor-db/types.ts'

// 監控 DB 化：長駐行程（本檔跑在 head server／worker-agent 的常駐 webhook
// server 行程裡）的實際寫入一律經 spawn-create-mr.ts 匯出的
// `dispatchMonitorWrite()`——它是全案唯一的長駐行程 pool／spool 單例
// （§4.6 G:MN-G7 的「行程級單一 pool」歸屬，見該檔案檔頭註解），demand 佇列
// 複用同一組基礎設施，不另建第二個 mon_head/mon_exec pool。本檔只負責組
// SQL 呼叫本身（writeRunProgress／writeRunOutcomeAuthoritative），跟
// spawnCreateMrNow 的寫法逐字對稱。
const DEMAND_RUN_KIND: RunKind = 'demand'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SPAWN_ERROR_LOG = join(LOG_DIR, 'spawn-errors.log')
const RUN_DEMAND_PIPELINE_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/run-demand-pipeline.ts'
const POST_RUN_DEMAND_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/post-run-demand.ts'
const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'

// review 發現：run-demand-pipeline.ts 內部每個外部呼叫都各自有 timeout，
// 但整支腳本本身沒有一個外層總時限——跟 create-mr 的 WRAPPER_SCRIPT 用
// `timeout 10800` 包住整條 pipeline、且用 bash EXIT trap 保證『不管 claude -p
// 是正常結束還是被 timeout 殺，鎖都會釋放』不同，這裡原本只靠 TypeScript
// try/finally，一旦這支 Bun 腳本本身被外部機制強制終止（SIGKILL 不可被
// try/finally 攔截），鎖永遠不會釋放。已改成比照 spawn-create-mr.ts 的
// WRAPPER_SCRIPT 模式：bash 包一層 `timeout` + EXIT trap，鎖釋放交給 bash
// trap 做最後一道安全網（run-demand-pipeline.ts 內部的 try/finally release
// 仍是主要路徑，正常結束時就會執行；trap 只在它沒機會執行時補上，
// bug-lock.sh release 對已釋放的鎖是 no-op，兩邊都呼叫無害）。
const TICKET_RE = /^ALDREQ-\d+$/
// 【G:MN-G1】§9.0(G) 逐點對照表第 2 列：7200 → 10800（180 分），與 create-mr
// 的 WRAPPER_SCRIPT 同批調整（與本案並行的既有行為變更，不受
// MON_DB_ENABLED 保護）。
const OUTER_TIMEOUT_SECONDS = 10800 // 跟 create-mr 的既有值一致，run-demand-pipeline.ts 內部各步驟 timeout 加總的最壞情況遠低於這個值

// 監控 DB 化：trap 側終態寫入（demand 沒有等同 post-run-notify.ts 的既有
// 收尾腳本，v1/v2 都缺這個安全網，見 plan-db-as-truth-v3.md §9 Phase 2
// 「demand 終態（trap 側）」列）。post-run-demand.ts 只是安全網——正常路徑
// 的結構化終態由 run-demand-pipeline.ts 自己的 finalize() 寫（見該檔）；
// 這裡只補「行程被 timeout/SIGKILL 中途打斷、完全沒機會跑到 finally」的
// 情況。同一個 shell（不是 subshell），MON_RUN_ID 已由 spawnDetachedProcess
// 的 env 覆寫帶進來，trap 內直接繼承，不需要另外查 DB／讀檔。
// `>/dev/null 2>&1`：跟 release 同理，不弄髒 stdout log。
const WRAPPER_SCRIPT = `
trap '
  EC=$?
  bash ${BUG_LOCK_SH} release "$1" >/dev/null 2>&1
  bun ${POST_RUN_DEMAND_TS} "$1" "$EC" >/dev/null 2>&1
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
//
// 【plan-db-as-truth-v3.2.md §5.2】runId／retryOfRunId 由 submitDemandPipeline
// 在呼叫 demandQueue.submit() 之前鑄好、放進 payload——不管這張單最後是直接
// spawn 還是先進 FIFO 佇列，同一次 submitDemandPipeline 呼叫只鑄一個
// run_id，兩條路徑用的是同一個值（佇列的 onEnqueued 寫 queued/rank10，這裡
// 的 spawn choke point 寫 running/rank30，ODKU 的 GREATEST 語意讓寫入順序
// 不影響最終結果）——與 spawn-create-mr.ts 的 BugPayload 完全對稱。
// dispatchId（整合修補批次 item 6）：見 spawn-create-mr.ts BugPayload 同名欄位註解。
export type DemandPayload = { assigneeEmail: string; runId: string; retryOfRunId: string | null; dispatchId: string | null }

function spawnDemandPipelineNow(entry: QueueEntry<DemandPayload>, onExit: () => void): { ok: true; pid: number | undefined } | { ok: false } {
  const { ticket } = entry
  const { runId, retryOfRunId, dispatchId } = entry.payload
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
    // 監控 DB 化（【G:BL-G2】§6.4(4) R2）：帶 runId/kind，讓 cancel 五段解析與
    // stale-lock-reaper 的自動重試血緣都能純本機讀到這次 spawn 的 run_id。
    markPipelineActive(ticket, { runId, kind: 'demand' })

    const legacyKey = base
    const pid = spawnDetachedProcess('bash', ['-c', WRAPPER_SCRIPT, 'run-demand-pipeline', ticket, entry.payload.assigneeEmail], {
      cwd: '/Users/user/aladdin/telegram-dispatcher',
      stdoutPath,
      stderrPath,
      // 監控 DB 化（MN-1）：demand 開始傳 env——顯式覆寫 MON_RUN_ID，讓
      // run-demand-pipeline.ts 與同一個 bash shell 裡的 EXIT trap
      // （post-run-demand.ts）都能直接讀到這個行程的 run_id，不需要另外
      // 查 DB／讀 marker 檔（§5.2）。語意因此從「Bun 行程啟動快照」變成
      // 「spawn 呼叫當下的 {...process.env}」（見 spawnDetachedProcess 的
      // env 展開邏輯），是刻意的行為變更，非既有 DISPATCHER_TRIGGERED 那類
      // 既有必要環境變數會被影響——舊行為未帶任何 opts.env 時就是
      // `env: undefined`，兩者差異只在於「有沒有一個額外的 opts.env 物件」。
      env: { MON_RUN_ID: runId },
      // 監控 DB 化（MN-C8）：非同步 'error' 事件——child 從未真正開始執行，
      // 與 spawn-create-mr.ts 的 onSpawnError 對稱：把終態改寫成
      // spawn_error（tier2，W2 的守衛允許覆寫 outcome IS NULL 的列，跟下面
      // 成功路徑互斥，只會有其中一個真的執行到）。
      onSpawnError: () => {
        const finishedAt = new Date().toISOString()
        dispatchMonitorWrite(
          'writeRunOutcomeAuthoritative',
          { runId, ticket, kind: DEMAND_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-detached-error', finishedAt },
          pool => writeRunOutcomeAuthoritative(pool, { runId, ticket, kind: DEMAND_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-detached-error', finishedAt }),
        )
      },
      // 順序硬約束（對抗性 review 2026-08-28）：clearPipelineActive 必須在
      // onExit() 之前，理由見 spawn-create-mr.ts 同位置註解。
      onExit: () => {
        clearPipelineActive(ticket)
        onExit()
      },
    })

    if (pid === undefined) {
      // 監控 DB 化（MN-C8(a)）：拿不到 pid（罕見：fork 本身失敗但沒有走到
      // 上面 onSpawnError／下面 catch 那兩條路徑）——不寫 running，直接寫
      // 權威終態 spawn_error。
      const finishedAt = new Date().toISOString()
      dispatchMonitorWrite(
        'writeRunOutcomeAuthoritative',
        { runId, ticket, kind: DEMAND_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-no-pid', finishedAt },
        pool => writeRunOutcomeAuthoritative(pool, { runId, ticket, kind: DEMAND_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-no-pid', finishedAt }),
      )
    } else {
      // 監控 DB 化（spawn 是唯一 choke point）：拿到 pid 才寫 running（W1）。
      const startedAt = new Date().toISOString()
      dispatchMonitorWrite(
        'writeRunProgress',
        {
          runId,
          ticket,
          kind: DEMAND_RUN_KIND,
          lifecycleRank: 30 as const,
          startedAt,
          pid,
          stdoutPath,
          triggerSource: entry.triggeredBy ? 'telegram' : 'cli',
          retryOfRunId,
          dispatchId,
          legacyKey,
        },
        pool =>
          writeRunProgress(pool, {
            runId,
            ticket,
            kind: DEMAND_RUN_KIND,
            lifecycleRank: 30,
            startedAt,
            pid,
            stdoutPath,
            triggerSource: entry.triggeredBy ? 'telegram' : 'cli',
            retryOfRunId,
            dispatchId,
            legacyKey,
          }),
      )
    }

    return { ok: true, pid }
  } catch (err) {
    clearPipelineActive(ticket)
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawnDemandPipeline 失敗（${ticket}）: ${err}\n`)
    // 監控 DB 化（MN-C8(a)）：同步例外（mkdirSync/openSync 失敗等）——這張
    // 單從未真正 spawn，寫權威終態 spawn_error（tier2）。markPipelineActive
    // 在更前面已執行過，runId 已鑄定，不會是空值。
    {
      const finishedAt = new Date().toISOString()
      dispatchMonitorWrite(
        'writeRunOutcomeAuthoritative',
        { runId, ticket, kind: DEMAND_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-sync-exception', finishedAt },
        pool => writeRunOutcomeAuthoritative(pool, { runId, ticket, kind: DEMAND_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-sync-exception', finishedAt }),
      )
    }
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
  // §5.6（BL-C5）：供 recoverFromDisk() 回傳 run_id 陣列。
  getRunId: p => p.runId,
  // 監控 DB 化（【plan-db-as-truth-v3.2.md §9 Phase2】enqueue 寫入點）：一張
  // 需求單真的進入 FIFO 佇列時寫 queued（W1 rank10）——與 bugQueue 的
  // onEnqueued 對稱，複用 pipeline-queue.ts 同一組通用 hook 欄位。
  onEnqueued: entry => {
    dispatchMonitorWrite(
      'writeRunProgress',
      {
        runId: entry.payload.runId,
        ticket: entry.ticket,
        kind: DEMAND_RUN_KIND,
        lifecycleRank: 10 as const,
        retryOfRunId: entry.payload.retryOfRunId,
        dispatchId: entry.payload.dispatchId,
      },
      pool =>
        writeRunProgress(pool, {
          runId: entry.payload.runId,
          ticket: entry.ticket,
          kind: DEMAND_RUN_KIND,
          lifecycleRank: 10,
          retryOfRunId: entry.payload.retryOfRunId,
          dispatchId: entry.payload.dispatchId,
        }),
    )
  },
  onSkipped: (entry, reason) => {
    // 監控 DB 化：code 值域見 makeQueueSkipReason——'locked' 別的流程正在跑
    // （那個存活 run 的權威終態由它自己的 finalize 寫，W2 的守衛只覆寫
    // outcome IS NULL 或 tier<2 的列，這裡的 skipped_locked 不會覆寫掉它）；
    // 'expired' 排隊逾時、沒有任何流程在跑，寫 skipped_expired。與 bugQueue
    // 的 onSkipped 對稱。
    const outcome = reason.code === 'locked' ? 'skipped_locked' : reason.code === 'expired' ? 'skipped_expired' : null
    if (outcome) {
      const finishedAt = new Date().toISOString()
      dispatchMonitorWrite(
        'writeRunOutcomeAuthoritative',
        { runId: entry.payload.runId, ticket: entry.ticket, kind: DEMAND_RUN_KIND, outcome, outcomeSource: 'pipeline-queue-skip', finishedAt },
        pool =>
          writeRunOutcomeAuthoritative(pool, {
            runId: entry.payload.runId,
            ticket: entry.ticket,
            kind: DEMAND_RUN_KIND,
            outcome,
            outcomeSource: 'pipeline-queue-skip',
            finishedAt,
          }),
      )
    }
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

/** 多機派工（lib/cluster/backlog-dispatcher.ts）用的旁路出口，介面說明比照
 * spawn-create-mr.ts 的 tryDispatchBugQueueFront。 */
export function tryDispatchDemandQueueFront(attempt: (entry: QueueEntry<DemandPayload>) => Promise<boolean>): Promise<'empty' | 'dispatched' | 'declined'> {
  return demandQueue.tryDispatchFront(attempt)
}

/**
 * 提交一張需求單：有名額直接 spawn、額滿排入 FIFO 佇列（回覆順位）、已在
 * 排隊中則回 already_queued。介面說明比照 submitCreateMr。
 *
 * 【plan-db-as-truth-v3.2.md §5.2】run_id 鑄造機＝執行機，鑄造時機是「這次
 * submitDemandPipeline 呼叫本身」（不管最後走 started 還是 queued，同一次
 * 呼叫只鑄一個 run_id，見 DemandPayload 型別註解）。retry 血緣讀
 * process.env.MON_RUN_ID——demand 目前沒有既有的 auto-retry 觸發者
 * （stale-lock-reaper 只重試 bug pipeline），這裡仍照通用規則讀取，恆為
 * null，為未來擴充預留、成本為零。
 */
export function submitDemandPipeline(ticket: string, assigneeEmail: string, triggeredBy?: TechUser, dispatchId?: string): SubmitResult {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }
  const by: QueueTriggeredBy = triggeredBy ? { name: triggeredBy.notion_user_name, email: triggeredBy.email } : null
  const runId = mintRunId()
  const retryOfRunId = readInheritedRunId()
  return demandQueue.submit(ticket, by, { assigneeEmail, runId, retryOfRunId, dispatchId: dispatchId ?? null })
}

/** 只給 server.ts 啟動時呼叫一次（CLI 短命行程絕不能呼叫，見 pipeline-queue.ts
 * recoverFromDisk 註解）。 */
export function recoverDemandQueue(): RecoverFromDiskResult {
  return demandQueue.recoverFromDisk()
}
