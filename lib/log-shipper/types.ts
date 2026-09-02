// lib/log-shipper/types.ts — log shipper 核心共用型別（純型別，無副作用）。
//
// 只放跨檔共用介面，避免 shipper.ts / vl-sink.ts / cluster-sink.ts 互相 import
// 造成循環。規格出處見 shipper.ts 檔頭。

/** 一行已完成遮罩（或截斷摘要）處理、待送出的 log 行。 */
export interface ShipLine {
  path: string
  inode: number
  /** 這一行在檔案內的起始 byte offset（游標語意用，不是送出後的新 offset）。 */
  offset: number
  ts: string
  host: string
  source: string
  ticket: string | null
  kind: string | null
  runId: string | null
  /** true 時代表本行 >2MB，不含原文，改帶 origBytes/head4k/tail4k 摘要。 */
  truncated?: true
  origBytes?: number
  head4k?: string
  tail4k?: string
  /** 未截斷時才有值；已遮罩（redactLine 處理過）。 */
  content?: string
}

/**
 * 送出一批 log 行；回傳 2xx（或 VL 寫入成功）與否。任何非成功情形
 * （非 2xx、429、逾時、例外）一律回 false——呼叫端（shipper.ts）不重試、
 * 不自旋、不 sleep，只結束本輪，下一輪自然重送（見 v3.2 裁定 4(d)）。
 */
export interface LogSink {
  send(batch: ShipLine[]): Promise<boolean>
}

export interface TailCursor {
  inode: number
  offset: number
}
