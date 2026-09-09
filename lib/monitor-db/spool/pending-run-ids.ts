// lib/monitor-db/spool/pending-run-ids.ts
//
// 2026-09-09（回應 ALDREQ-812 誤標事故）：local-sweep.ts 的 §6.6 sweeper 一直
// 有一個 `hasPendingSpoolEntry` 保護——run_id 還有待重放的 spool 條目時，
// sweeper 該跳過、不把它標成 unknown_no_writer（降噪，見 local-sweep.ts 該
// 參數的檔頭註解）。但這個保護在 production 從未真的接上：server.ts 與
// worker-agent.ts 呼叫 startMonitorMaintenance() 時都沒有傳
// `hasPendingSpoolEntry`，導致它一直是 no-op——ALDREQ-812 就是活生生的案例：
// finalize() 的權威終態寫入因 DB 連線逾時落地成 spool（outcome: success），
// 但 sweeper 完全不知道有這筆待重放的條目，逕自把 tier1 的
// `unknown_no_writer` 蓋上去（後來手動用 writeRunOutcomeAuthoritative 補寫
// tier2 蓋回 success 才修正）。
//
// 本檔提供 readPendingSpoolRunIds()：掃一次 logs/spool/ 下所有資料檔的
// 「未 ack 區」（cursor.acked_bytes 之後、最後一個完整換行為止——半行不算，
// 判準與 replayer.ts 的 readLinesFromOffset() 一致，因為那才是「重放者接下來
// 真的會處理到」的範圍），把每一行 parse 出來的 `run_id` 收進一個 Set。
// maintenance.ts 的 tick() 每輪只呼叫一次，建好 Set 後用
// `runId => set.has(runId)` 當 hasPendingSpoolEntry 傳給 sweepDeadLocalRuns——
// 不在 sweeper 的每一列迴圈裡各自重掃一次整個 spool 目錄。
//
// 純唯讀，跟 depth.ts 同等級的安全性：不寫任何檔案、不影響三個不變式，可以
// 被任意行程/頻率呼叫；讀不到/壞檔一律當「沒有這個 run_id」處理（跟 sweeper
// 既有的「連不上 DB 整輪跳過」同一種保守方向——這裡反過來是「查不到就不
// 特別保護」，因為就算誤判，下一輪 tick 一樣會再檢查一次，不是不可逆）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCursor } from './replayer.ts'
import { isSpoolDataFileName, type SpoolEntry } from './types.ts'

/**
 * 掃一次 spool 目錄，回傳所有「未 ack 區」內出現過的 run_id 集合。
 * 半行（最後一個 `\n` 之後的位元組）不算——寫入者可能還在寫。
 */
export function readPendingSpoolRunIds(dir: string): Set<string> {
  const pending = new Set<string>()
  let names: string[]
  try {
    if (!existsSync(dir)) return pending
    names = readdirSync(dir).filter(isSpoolDataFileName)
  } catch {
    return pending
  }

  for (const name of names) {
    const filePath = join(dir, name)
    try {
      const cursor = readCursor(`${filePath}.cursor`)
      const buf = readFileSync(filePath)
      const acked = Number(cursor.acked_bytes)
      const start = Number.isFinite(acked) && acked >= 0 && acked <= buf.length ? acked : 0

      let pos = start
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos)
        if (nl === -1) break // 半行：留給下一輪
        const lineStr = buf.subarray(pos, nl).toString('utf8')
        pos = nl + 1
        if (lineStr.length === 0) continue
        try {
          const entry = JSON.parse(lineStr) as SpoolEntry
          if (entry.run_id) pending.add(entry.run_id)
        } catch {
          // 壞行：跳過（同 replayer.ts 的既有慣例），不影響其餘行的判讀。
        }
      }
    } catch {
      // 單一檔案讀不到（權限/競態刪除等）：跳過，不讓整輪掃描中斷。
    }
  }
  return pending
}
