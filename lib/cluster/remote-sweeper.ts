import { DISPATCH_STATUS_RANK, type DispatchRegistry } from './dispatch-registry.ts'
import type { DispatchAttemptWriteDeps } from './dispatch.ts'
import type { WorkerInfo } from './worker-registry.ts'
import type { JobStatus } from './worker-client.ts'
import type { QueueTriggeredBy } from '../pipeline-runner/pipeline-queue.ts'

// head 端派工登記表的事後校正（對應單機的 stale-lock-reaper）。
// job-done 回報是主要清除機制（事件驅動）；本模組是安全網，處理回報遺失：
// worker 整機重開、回報當下 head 剛好重啟、postJob ambiguous 其實沒接到單、
// head 在交涉中重啟（M-1 的 dispatching 殘留）。
//
// 對抗性 review（2026-08-31 C-2）定下的最高原則：**寧可讓一張單暫時卡住
// 不可認領，也絕不製造「叫使用者重新認領但流程其實還活著」的雙跑**。
// 具體落地：
// - 失聯（探測連續失敗）**不清登記**——登記在，claim 就會被
//   already_running_remote 擋住；只告警一次，等 worker 恢復或 27 小時
//   絕對上限。清了反而讓單子回到可認領池。
// - 只有「向 worker 查證確認沒有任何活動」或「超過 27 小時絕對上限」才清。
// - 需求單（ALDREQ）清除時的 Notion AI分析 處理：認領當下已被標成
//   「分析中」，而 /req 候選 filter 只收 待分析/需要重跑——不改回去的話
//   「重新認領」在結構上做不到。但「已結束但回報遺失」無法與「正常完成
//   （finalize 已自行更新 AI分析）」區分，這種情況**不**自動 reset（會把
//   已完成的單錯誤地放回可認領池），改由維運者依結果通知有無來人工判讀；
//   只有「確定沒有任何流程碰過這張單」（dispatching 求證全空）與 27 小時
//   上限（不可能還有活流程）才自動 reset。
//
// 純邏輯 + 依賴注入（比照 dispatch.ts）；production 接線在 cluster-head.ts。

export const SWEEP_GRACE_MS = 15 * 60_000 // 冷啟動寬限：spawn 後拿鎖要 1–3 分鐘（claim.ts 註解），5 倍 margin
// 絕對上限：worker 端排隊最長 24h + 單輪 timeout 3h（plan-db-as-truth-v3.2.md
// §9.0(G) 逐點對照表第 5 列：timeout 180 分（10800 秒）連動改動之一，26h→27h）。
export const SWEEP_MAX_AGE_MS = 27 * 3600_000
export const SWEEP_MISS_LIMIT = 3

export type SweeperDeps = {
  registry: DispatchRegistry
  listWorkers: () => WorkerInfo[]
  fetchStatus: (url: string, ticket: string) => Promise<JobStatus | null>
  notifyOperator: (text: string) => void
  notifyUser: (triggeredBy: QueueTriggeredBy, text: string) => void
  /** 把需求單 Notion AI分析 改回「需要重跑」（spawn-demand-pipeline.ts 的
   * resetAiAnalysisForReclaim）。回傳是否成功，決定使用者訊息措辭。 */
  resetDemand: (ticket: string) => boolean
  /** monitor DB `dispatch_attempts` 觀察面寫入，比照 dispatch.ts（§5.3）。optional：
   * 省略時等同單機/測試模式，不寫入也不影響清理正確性（那完全由 registry 保證）。 */
  dispatchAttempts?: DispatchAttemptWriteDeps
  now?: () => number
}

export type RemoteSweeper = {
  sweep: () => Promise<void>
  /** job-done（或其他外部清除）發生時呼叫，清掉這張單的失聯計數與告警
   * 旗標（M-3：不清的話下一次派工只要一次瞬時抖動就累積到門檻）。 */
  noteCleared: (ticket: string) => void
}

type MissState = { misses: number; alerted: boolean }

export function createRemoteSweeper(deps: SweeperDeps): RemoteSweeper {
  const missStates = new Map<string, MissState>()
  let sweeping = false // 重疊防護：上一輪還在跑（多台失聯時一輪可能拖很久）就跳過本輪

  function isActive(status: JobStatus): boolean {
    return status.locked || status.queueState !== null
  }

  /** demand 專用收尾：reset AI分析 並回傳對應的使用者措辭尾句。 */
  function resetDemandWithText(ticket: string): string {
    return deps.resetDemand(ticket)
      ? 'Notion AI分析 已改回「需要重跑」，若仍需要分析請重新認領一次。'
      : 'Notion AI分析 改回「需要重跑」失敗（停在「分析中」）——請人工到 Notion 改成「需要重跑」後才能重新認領。'
  }

  async function sweepOnce(): Promise<void> {
    const now = deps.now?.() ?? Date.now()

    // M-3：修剪不在登記表上的殘留計數（含 job-done 清除後的），杜絕無上界增長。
    for (const ticket of [...missStates.keys()]) {
      if (deps.registry.get(ticket) === null) missStates.delete(ticket)
    }

    for (const entry of deps.registry.list()) {
      const age = now - Date.parse(entry.dispatchedAt)

      if (age > SWEEP_MAX_AGE_MS) {
        // 超過排隊上限+單輪 timeout 的總和，不可能還有活流程，清除是安全的。
        deps.registry.clear(entry.ticket)
        missStates.delete(entry.ticket)
        // 門檻已改 27h（§9.0(G)），dispatch_attempts 的終態名稱同步從
        // lost_26h 改為 lost_27h（與常數改名同一批，避免文件對不上程式碼）。
        deps.dispatchAttempts?.advance({
          dispatchId: entry.dispatchId,
          status: 'lost_27h',
          statusRank: DISPATCH_STATUS_RANK.terminal,
          clearedAt: new Date(now).toISOString(),
          clearReason: 'sweep_max_age',
        })
        deps.notifyOperator(`⚠️ cluster: ${entry.ticket}（worker ${entry.worker || '(交涉中)'}）超過 ${Math.round(SWEEP_MAX_AGE_MS / 3600_000)} 小時未回報結束，登記已強制清除，請人工確認該 worker 狀態。`)
        deps.notifyUser(
          entry.triggeredBy,
          entry.kind === 'demand'
            ? `⚠️ ${entry.ticket} 的背景流程超時未回報。${resetDemandWithText(entry.ticket)}`
            : `⚠️ ${entry.ticket} 的背景流程超時未回報，若未收到結果通知，請重新認領一次。`,
        )
        continue
      }
      if (age < SWEEP_GRACE_MS) continue

      if (entry.status === 'dispatching') {
        // M-1：head 在交涉中重啟的殘留（正常流程會在同一次 dispatch() 呼叫內
        // confirm 或 clear）。不知道派到哪台，向全部 worker 求證。
        const workers = deps.listWorkers()
        const results = await Promise.all(workers.map(async w => ({ w, status: await deps.fetchStatus(w.url, entry.ticket) })))
        const activeOn = results.find(r => r.status !== null && isActive(r.status))
        if (activeOn) {
          deps.registry.confirmDispatched(entry.ticket, activeOn.w.name, activeOn.w.url)
          missStates.delete(entry.ticket)
          deps.dispatchAttempts?.advance({
            dispatchId: entry.dispatchId,
            status: 'dispatched',
            statusRank: DISPATCH_STATUS_RANK.dispatched,
            confirmedAt: new Date(now).toISOString(),
          })
          deps.notifyOperator(`ℹ️ cluster: ${entry.ticket} 的交涉中斷登記已求證回填為 worker ${activeOn.w.name}（head 重啟前已派出）。`)
          continue
        }
        if (results.some(r => r.status === null)) {
          // 有 worker 失聯：可能就在那台上，保留登記等下一輪（受 27h 上限）。
          continue
        }
        // 全部 worker 可達且都沒有這張單的活動：確定沒派出去，清除放回可認領。
        deps.registry.clear(entry.ticket)
        missStates.delete(entry.ticket)
        deps.dispatchAttempts?.advance({
          dispatchId: entry.dispatchId,
          status: 'never_started',
          statusRank: DISPATCH_STATUS_RANK.terminal,
          clearedAt: new Date(now).toISOString(),
          clearReason: 'sweep_no_activity',
        })
        deps.notifyOperator(`ℹ️ cluster: ${entry.ticket} 的交涉中斷登記已求證清除（所有 worker 均無此單活動）。`)
        deps.notifyUser(
          entry.triggeredBy,
          entry.kind === 'demand'
            ? `ℹ️ ${entry.ticket} 先前的派工未完成啟動。${resetDemandWithText(entry.ticket)}`
            : `ℹ️ ${entry.ticket} 先前的派工未完成啟動，請重新認領一次。`,
        )
        continue
      }

      // confirmed：向執行機查證。
      const status = await deps.fetchStatus(entry.workerUrl, entry.ticket)
      if (status === null) {
        const state = missStates.get(entry.ticket) ?? { misses: 0, alerted: false }
        state.misses += 1
        missStates.set(entry.ticket, state)
        if (state.misses >= SWEEP_MISS_LIMIT && !state.alerted) {
          // C-2：失聯**不清登記**（流程可能還活著，清了會被重新認領→雙跑）。
          // 登記保留即持續擋住重複認領；告警一次，等恢復或 27h 上限。
          state.alerted = true
          deps.notifyOperator(`⚠️ cluster: worker ${entry.worker}（${entry.workerUrl}）連續 ${state.misses} 次失聯，${entry.ticket} 的登記保留中（防止重複認領），待該機恢復或 ${Math.round(SWEEP_MAX_AGE_MS / 3600_000)} 小時上限。`)
          deps.notifyUser(entry.triggeredBy, `⚠️ ${entry.ticket} 執行所在的機器暫時失聯，流程狀態無法確認。請**不要**重新認領，維運人員處理中；有結果會照常通知你。`)
        }
        continue
      }

      missStates.delete(entry.ticket) // 恢復連線即歸零計數與告警旗標
      if (isActive(status)) continue

      // vanished：worker 可達但該單已無任何活動（queue/鎖/ps 三合一判定，見
      // local-activity.ts）。多半是流程正常結束但 job-done 回報遺失（結果
      // 通知已由 worker 端 post-run-notify 發過）；少數是 worker 整機重開、
      // 流程無疾而終——兩者無法區分，清登記後交人工判讀，不叫使用者重新
      // 認領（若流程其實完成了，重新認領＝重跑一整輪）。
      deps.registry.clear(entry.ticket)
      deps.dispatchAttempts?.advance({
        dispatchId: entry.dispatchId,
        status: 'vanished',
        statusRank: DISPATCH_STATUS_RANK.terminal,
        clearedAt: new Date(now).toISOString(),
        clearReason: 'vanished_no_activity',
      })
      deps.notifyOperator(
        `ℹ️ cluster: ${entry.ticket}（worker ${entry.worker}）已無執行活動但未收到 job-done 回報，登記已清除。若該單沒有結果通知/Notion 留言，可能是 worker 中途重開${entry.kind === 'demand' ? '；需求單如需重跑，請人工把 Notion AI分析 改成「需要重跑」' : ''}。`,
      )
      deps.notifyUser(entry.triggeredBy, `ℹ️ ${entry.ticket} 的背景流程已結束。若你**沒有**收到結果通知，代表流程可能異常中斷，請聯絡維運人員確認，不要自行重新認領。`)
    }
  }

  return {
    async sweep() {
      if (sweeping) return
      sweeping = true
      try {
        await sweepOnce()
      } finally {
        sweeping = false
      }
    },
    noteCleared(ticket) {
      missStates.delete(ticket)
    },
  }
}
