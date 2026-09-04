// lib/cluster/job-done-queue.ts — worker 端「job-done 回報待重送佇列」。
//
// 背景：worker-agent.ts 的 reportJobDone()/postToHead() 對 head 的
// POST /cluster/job-done 原本只打一次、10 秒逾時，失敗只 catch 回傳 false、
// 不重試、不落地——這次回報永久遺失。head 的 remote-sweeper 之後 sweep
// 判定「該單無本機活動」本身沒有錯，只是回報訊號早就丟了沒人知道（誤報
// 「已無執行活動但未收到 job-done 回報，登記已清除」的根因）。
//
// 修法：回報失敗即落磁碟（tmp+rename 原子寫入，比照 pipeline-queue.ts /
// dispatch-registry.ts 既有慣例），由 worker-agent.ts 的週期性 timer
// （setInterval）定期重試，成功（head 回 ok:true）才從佇列移除；worker
// 重啟時 loadFromDisk() 撿回還沒送達的回報，不會遺漏。
//
// 這不是「用等待解決正確性問題」（CLAUDE.md 硬規則）：這裡沒有競態要規避，
// 是對「head 暫時打不通」這個外部失敗做確定性的重試排程，跟
// concurrency-limiter/remote-sweeper 既有的 setInterval 週期性排程器同一類。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export type JobDoneEntry = {
  id: string
  ticket: string
  worker: string
  /** BUG_TICKET_RE 命中時才有值，見 worker-agent.ts reportJobDone。 */
  trackerRow?: string
  enqueuedAt: string
}

export type JobDoneQueue = {
  /** 落地一筆待重送回報（同一次呼叫恰好一筆，不去重——同張票短時間內重複
   * enqueue 極罕見，且重送冪等：head 端 /cluster/job-done 對同張票的多次
   * 回報本來就是冪等的，多送一次無害）。回傳鑄好的 id。 */
  enqueue: (entry: Omit<JobDoneEntry, 'id' | 'enqueuedAt'>) => string
  /** 成功送達後移除。 */
  remove: (id: string) => void
  /** 目前佇列快照（重試 timer 用，回傳的是複本，呼叫端修改不影響內部狀態）。 */
  list: () => JobDoneEntry[]
  /** 啟動時載回上次未送達的回報（worker-agent.ts 啟動流程呼叫一次；只有呼叫
   * 過這支之後 enqueue/remove 才會真的落盤，比照 pipeline-queue.ts /
   * dispatch-registry.ts 的 recoverFromDisk 慣例——短命行程/測試 import 本
   * 模組不會意外寫檔）。 */
  loadFromDisk: () => JobDoneEntry[]
}

export function createJobDoneQueue(stateFile: string): JobDoneQueue {
  let entries: JobDoneEntry[] = []
  let persistEnabled = false

  function persist(): void {
    if (!persistEnabled) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2))
      renameSync(tmp, stateFile)
    } catch (err) {
      console.error(`job-done-queue: 寫入 ${stateFile} 失敗: ${err}`)
    }
  }

  return {
    enqueue(entry) {
      const id = randomUUID()
      entries.push({ ...entry, id, enqueuedAt: new Date().toISOString() })
      persist()
      return id
    },
    remove(id) {
      const before = entries.length
      entries = entries.filter(e => e.id !== id)
      if (entries.length !== before) persist()
    },
    list: () => entries.map(e => ({ ...e })),
    loadFromDisk() {
      persistEnabled = true
      try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { entries?: JobDoneEntry[] }
        if (Array.isArray(parsed.entries)) {
          // 壞掉/被竄改的條目逐筆驗格式丟棄（比照 dispatch-registry.ts
          // recoverFromDisk 的既有紀律），不讓半寫壞的檔案把不合法字串帶進
          // 之後的 postToHead body。
          entries = parsed.entries.filter(
            e =>
              typeof e?.id === 'string' &&
              typeof e?.ticket === 'string' &&
              typeof e?.worker === 'string' &&
              typeof e?.enqueuedAt === 'string' &&
              (e.trackerRow === undefined || typeof e.trackerRow === 'string'),
          )
        }
      } catch {
        // 檔案不存在或壞掉都當空佇列；下面 persist 會把檔案重寫成目前實況。
      }
      persist()
      return entries.map(e => ({ ...e }))
    },
  }
}

/**
 * 對佇列內每一筆待重送回報各嘗試補送一次，成功（`post` 回 true）才移除。
 * 純函式（依賴注入 `post`），供 worker-agent.ts 的週期性 timer 呼叫，也供
 * 單元測試用假的 `post` 驗證「失敗落地 → 重試成功 → 移除」整條流程，不需要
 * 真的打 head。
 *
 * 逐筆循序 await（不是 Promise.all 全平行）：佇列通常很小（head 短暫失聯期間
 * 累積的回報），循序送不會對 head 造成突發流量尖峰；单筆失敗不影響其餘筆的
 * 重試機會。
 */
export async function retryJobDoneQueue(
  queue: JobDoneQueue,
  post: (entry: JobDoneEntry) => Promise<boolean>,
): Promise<{ attempted: number; succeeded: number }> {
  let succeeded = 0
  const snapshot = queue.list()
  for (const entry of snapshot) {
    let ok = false
    try {
      ok = await post(entry)
    } catch (err) {
      console.error(`job-done-queue: 重送 ${entry.ticket}（id=${entry.id}）時例外，保留佇列下輪再試: ${err}`)
    }
    if (ok) {
      queue.remove(entry.id)
      succeeded++
    }
  }
  return { attempted: snapshot.length, succeeded }
}
