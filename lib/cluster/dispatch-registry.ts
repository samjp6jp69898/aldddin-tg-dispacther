import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CLUSTER_TICKET_RE } from './cluster-env.ts'
import type { QueueTriggeredBy } from '../pipeline-runner/pipeline-queue.ts'

// head 端的「派到哪台」登記表——多機版的 isTicketLocked 對應物。
//
// 為什麼需要它：per-ticket 鎖（/tmp/bug-analysis-locks）跟著執行 pipeline 的
// 那台機器走（claim.ts 在 spawn 前就 release、由 pipeline 自己的 Step 0.1.3
// 在執行機重新拿鎖，見 claim.ts releaseLock 註解）。job 派去 worker 之後，
// head 本機的鎖目錄看不到任何痕跡——沒有這份登記表，同一張單會被第二次
// 認領派去另一台，兩台各自跑同一張單（各推各的分支、互相蓋 Notion 狀態）。
//
// 生命週期：
//   markDispatching（同步，在任何 await 之前）→ confirmDispatched（worker
//   接單成功）→ clear（worker 的 job-done 回報，或 remote-sweeper 判定已
//   消失）。markDispatching 之後派工失敗改走本機時也要 clear。
// 「markDispatching 必須是同步呼叫」是結構性防重複的關鍵：兩個幾乎同時的
// 認領 callback 在同一條 event loop 上，第一個 handler 在 await 任何網路
// 呼叫之前先同步佔位，第二個 handler 的 get() 就一定看得到——跟
// pipeline-queue 的 running 集合封「已 spawn 未拿鎖」視窗是同一招。
//
// 持久化（tmp+rename）：head 重啟後 recoverFromDisk 撿回，否則重啟瞬間所有
// 遠端執行中的單都會「消失」而變回可認領。壞掉/被竄改的條目逐筆驗格式丟棄。

export type DispatchEntry = {
  ticket: string
  kind: 'bug' | 'demand'
  /** dispatching = 已同步佔位、還在跟 worker 交涉；confirmed = worker 已接單。 */
  status: 'dispatching' | 'confirmed'
  worker: string
  workerUrl: string
  dispatchedAt: string
  triggeredBy: QueueTriggeredBy
}

export type DispatchRegistry = {
  markDispatching: (ticket: string, kind: 'bug' | 'demand', triggeredBy: QueueTriggeredBy) => void
  confirmDispatched: (ticket: string, worker: string, workerUrl: string) => void
  clear: (ticket: string) => void
  get: (ticket: string) => DispatchEntry | null
  list: () => DispatchEntry[]
  /** 只給 head 的 server.ts 啟動時呼叫一次（比照 pipeline-queue 的
   * recoverFromDisk 慣例）。呼叫前的 mutation 不落盤——短命行程/測試 import
   * 本模組不會寫檔。 */
  recoverFromDisk: () => number
}

export function createDispatchRegistry(stateFile: string): DispatchRegistry {
  const entries = new Map<string, DispatchEntry>()
  let persistEnabled = false

  function persist(): void {
    if (!persistEnabled) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), entries: [...entries.values()] }, null, 2))
      renameSync(tmp, stateFile)
    } catch (err) {
      console.error(`dispatch-registry: 寫入 ${stateFile} 失敗: ${err}`)
    }
  }

  return {
    markDispatching(ticket, kind, triggeredBy) {
      entries.set(ticket, { ticket, kind, status: 'dispatching', worker: '', workerUrl: '', dispatchedAt: new Date().toISOString(), triggeredBy })
      persist()
    },
    confirmDispatched(ticket, worker, workerUrl) {
      const e = entries.get(ticket)
      if (!e) return
      e.status = 'confirmed'
      e.worker = worker
      e.workerUrl = workerUrl
      persist()
    },
    clear(ticket) {
      if (entries.delete(ticket)) persist()
    },
    get: ticket => entries.get(ticket) ?? null,
    list: () => [...entries.values()],
    recoverFromDisk(): number {
      persistEnabled = true
      try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { entries?: DispatchEntry[] }
        if (Array.isArray(parsed.entries)) {
          for (const e of parsed.entries) {
            if (typeof e?.ticket !== 'string' || !CLUSTER_TICKET_RE.test(e.ticket)) continue
            if (e.status !== 'confirmed' && e.status !== 'dispatching') continue
            // dispatching 條目也保留（對抗性 review 2026-08-31 M-1）：head 在
            // postJob 在途中重啟時，worker 可能已接單並 spawn——「交涉中」不
            // 等於「worker 沒接到」，直接丟棄會讓單子變回可認領而雙跑。保留
            // 後交給 remote sweeper 向全部 worker 求證再決定轉 confirmed 或
            // 清除（寧可暫時卡住不可認領，不可雙跑）。
            entries.set(e.ticket, e)
          }
        }
      } catch {
        // 檔案不存在或壞掉都當空表；下面 persist 會重寫成實況。
      }
      persist()
      return entries.size
    },
  }
}
