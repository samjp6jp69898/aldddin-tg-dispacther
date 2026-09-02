// lib/log-shipper/event-seq.ts — event_seq 記憶體單調計數器（【G:MN-G11】定案）。
//
// 見 lib/monitor-db/writes.ts:369-376 的 file_offsets 守衛說明（唯讀參考）：
// DB 側的 upsertFileOffset 只把 event_seq 當不透明守衛值寫入
// （`WHERE host=? AND path=? AND event_seq < ?`），計數器本身是 shipper 行程
// 的狀態，不是 DB 層的職責，職責在本檔。
//
// 演算法（逐字）：
//   wall = BigInt(Date.now()) * 1000n
//   last = wall > last ? wall : last + 1n
// 永不倒退——即使系統時鐘回撥（wall 比 last 小）或同一毫秒內連續呼叫多次
// （wall 等於 last），都保證嚴格遞增，讓 shipping 不會因為 DB 守衛判定
// 「不夠新」而靜默停擺。

export interface EventSeqCounter {
  /** 回傳下一個單調遞增的 event_seq（BigInt，內部量級）。 */
  next(): bigint
}

export function createEventSeqCounter(now: () => number = Date.now): EventSeqCounter {
  let last = 0n
  return {
    next(): bigint {
      const wall = BigInt(now()) * 1000n
      last = wall > last ? wall : last + 1n
      return last
    },
  }
}

/**
 * upsertFileOffset 的 eventSeq 參數型別是 number（見 writes.ts 的
 * UpsertFileOffsetInput 型別註解：`Date.now()*1000` 量級約 1.7e15，遠低於
 * Number.MAX_SAFE_INTEGER 的 9e15，此處轉換不失精度）。
 */
export function eventSeqToNumber(seq: bigint): number {
  return Number(seq)
}
