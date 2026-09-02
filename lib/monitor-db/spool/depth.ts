// lib/monitor-db/spool/depth.ts — spool 深度的唯讀讀取器（v3.2 §6.8(b) 修訂）。
//
// §6.8(b) 逐字：`spool_depth` ＝ `logs/spool/` 下**所有**資料檔的「未 ack 位元組」
// 換算出的**條目數總和**；`oldest_age_s` ＝ 所有未 ack 條目中最舊 `ts` 距今秒數。
// 門檻 200 條 / 15 分鐘。
//
// 本檔是純唯讀的：只 open('r')／stat／read，**絕不寫任何檔案**——它既不是
// §6.5(b) 的寫入者、也不是重放者、更不是回收器，三條不變式完全不受影響。
// 因此可以被任意行程、任意頻率呼叫（health-monitor 的 60 秒 timer、三個長駐
// 行程的心跳、doctor 腳本），不需要互斥。
//
// 兩個消費者：
//   1. §6.8(b) 的 head spool 告警（lib/monitor-db/alerts.ts）。
//   2. `monitor_heartbeat.spool_depth` / `spool_oldest_ts` 兩個觀察欄——
//      heartbeat.ts 原本因為「spool 側沒有數條目的 API」一律寫 NULL，本檔
//      就是那個缺口的解（見 heartbeat.ts 的 `spoolStats` 說明）。
//
// **保守計法（規格要求）**：任何「算不準」的情況一律往「未 ack 更多」的方向倒，
// 寧可誤報也不漏報——
//   - 游標檔不存在／JSON 壞掉：`readCursor()` 回 `emptyCursor()`（acked_bytes=0）
//     ⇒ 整檔視為未 ack。
//   - 游標的 `acked_bytes` 不是有限數、為負、或大於檔案現值：同樣退回 0
//     ⇒ 整檔視為未 ack（這涵蓋「檔案被截短」與「游標寫壞成大數」兩種壞檔）。
//   - 壞行（JSON 解析不出來）：**仍計入條目數**（replayer 會消費掉它、推進游標，
//     所以它確實是「待處理」的量）。
//   - **半行不計**：最後一個 `\n` 之後的位元組是寫入者可能正在寫的一行，
//     與 replayer.ts `readLinesFromOffset()` 的「讀到最後一個完整換行為止」
//     同一判準——兩邊對「一條目」的定義必須一致，否則深度會恆比實際多 1。
//   - 空行不計（同 replayer 的 `if (lineStr.length === 0) continue`）。
//
// `oldestTs` 的取法：同一檔內條目是 append-only 且 `ts` 由寫入當下產生
// （§6.5(a) 硬規則：絕對 ISO 字串，不留給重放時求值），所以**該檔未 ack 區段的
// 第一條就是最舊的**——只需要解析開頭幾行，不需要 parse 整個檔案。開頭若剛好
// 是壞行，往後最多再看 `MAX_TS_PROBE_LINES` 行；都取不到就這一檔回 null
// （「不知道」，不是「沒有」）。

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readCursor } from './replayer.ts'
import { SPOOL_DIR, isSpoolDataFileName } from './types.ts'

/** 單次 read() 的緩衝大小。資料檔上限 64MB（writer.ts 的輪替門檻），分塊掃避免
 * 一次把整檔讀進記憶體。 */
const READ_CHUNK_BYTES = 1 << 20

/** 為了取 `oldestTs` 而保留的檔頭位元組數（只用來解析前幾行，不影響計數）。 */
const HEAD_SCAN_BYTES = 64 * 1024

/** 檔頭最多試解析幾行來取 `ts`（第一行是壞行時的退路）。 */
const MAX_TS_PROBE_LINES = 5

export interface SpoolFileDepth {
  file: string
  /** 未 ack 的完整條目數（含壞行、不含半行與空行）。 */
  depth: number
  /** 未 ack 區段第一條的 `ts`；取不到回 null。 */
  oldestTs: string | null
  /** 未 ack 且以完整換行收尾的位元組數。 */
  unackedBytes: number
  /** 本檔的游標被判為不可信（缺檔／壞檔／超出範圍）而退回「整檔未 ack」。 */
  cursorFallback: boolean
}

export interface SpoolDepthStats {
  /** 全目錄未 ack 條目數總和（§6.8(b) 的 `spool_depth`）。 */
  depth: number
  /** 全目錄未 ack 條目中最舊的 `ts`（ISO 字串）；沒有未 ack 條目或全都取不到時 null。 */
  oldestTs: string | null
  /** 掃到的資料檔數。 */
  files: number
  /** 未 ack 位元組總和。 */
  unackedBytes: number
  /** 開檔／讀檔失敗、完全無法判讀的檔案數（呼叫端可據此判斷結果的可信度）。 */
  unreadableFiles: number
  /** 逐檔明細（告警訊息要指出是哪一檔積壓時用）。 */
  perFile: SpoolFileDepth[]
}

function emptyStats(): SpoolDepthStats {
  return { depth: 0, oldestTs: null, files: 0, unackedBytes: 0, unreadableFiles: 0, perFile: [] }
}

/** 從檔頭緩衝裡取最多 MAX_TS_PROBE_LINES 條完整行，回傳第一個解析得出的 `ts`。 */
function firstTsFromHead(head: Buffer): string | null {
  let pos = 0
  for (let i = 0; i < MAX_TS_PROBE_LINES; i++) {
    const nl = head.indexOf(0x0a, pos)
    if (nl === -1) return null
    const line = head.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    if (line.length === 0) continue
    try {
      const ts = (JSON.parse(line) as { ts?: unknown }).ts
      if (typeof ts === 'string' && ts.length > 0) return ts
    } catch {
      // 壞行：往下一行試（見檔頭說明）。
    }
  }
  return null
}

function measureFile(filePath: string): SpoolFileDepth | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(fd).size
    const cursor = readCursor(`${filePath}.cursor`)
    const acked = Number(cursor.acked_bytes)
    // 保守：任何不可信的游標值一律退回 0（整檔未 ack），見檔頭說明。
    const trustworthy = Number.isFinite(acked) && acked >= 0 && acked <= size
    const start = trustworthy ? acked : 0
    const cursorFallback = !trustworthy

    let pos = start
    let depth = 0
    let lastNewlineAbs = -1
    const headParts: Buffer[] = []
    let headBytes = 0
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES)

    while (pos < size) {
      const want = Math.min(READ_CHUNK_BYTES, size - pos)
      const n = readSync(fd, buf, 0, want, pos)
      if (n <= 0) break
      const chunkStart = pos
      const chunk = buf.subarray(0, n)

      if (headBytes < HEAD_SCAN_BYTES) {
        const take = chunk.subarray(0, Math.min(chunk.length, HEAD_SCAN_BYTES - headBytes))
        headParts.push(Buffer.from(take))
        headBytes += take.length
      }

      let idx = 0
      for (;;) {
        const nl = chunk.indexOf(0x0a, idx)
        if (nl === -1) break
        if (nl > idx) depth += 1 // 空行不計（同 replayer.ts）
        lastNewlineAbs = chunkStart + nl
        idx = nl + 1
      }
      pos += n
    }

    return {
      file: filePath,
      depth,
      oldestTs: depth > 0 ? firstTsFromHead(Buffer.concat(headParts)) : null,
      unackedBytes: lastNewlineAbs >= 0 ? lastNewlineAbs + 1 - start : 0,
      cursorFallback,
    }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * 掃一次 spool 目錄，回傳未 ack 條目數與最舊條目時間（§6.8(b)）。
 * **永不拋例外**：目錄不存在回全 0；個別檔案讀不了計進 `unreadableFiles`。
 */
export function readSpoolDepth(dir: string = SPOOL_DIR): SpoolDepthStats {
  const stats = emptyStats()
  let names: string[]
  try {
    if (!existsSync(dir)) return stats
    names = readdirSync(dir).filter(isSpoolDataFileName).sort()
  } catch {
    return stats
  }

  for (const name of names) {
    stats.files += 1
    const measured = measureFile(join(dir, name))
    if (measured === null) {
      stats.unreadableFiles += 1
      continue
    }
    stats.perFile.push(measured)
    stats.depth += measured.depth
    stats.unackedBytes += measured.unackedBytes
    if (measured.oldestTs !== null && (stats.oldestTs === null || measured.oldestTs < stats.oldestTs)) {
      // ISO-8601 UTC 字串（`new Date().toISOString()`）的字典序＝時間序，
      // 不需要建 Date 物件再比。
      stats.oldestTs = measured.oldestTs
    }
  }
  return stats
}

/**
 * `monitor_heartbeat` 兩個觀察欄要的形狀（heartbeat.ts 的 `spoolStats` 介面）。
 * 讀取失敗時回 `{null, null}`——心跳欄位寫 NULL 的語意是「這一拍不知道」，
 * 不是「深度為 0」，不可以用 0 頂替。
 */
export function readSpoolStatsForHeartbeat(dir: string = SPOOL_DIR): { depth: number | null; oldestTs: string | null } {
  try {
    const stats = readSpoolDepth(dir)
    return { depth: stats.depth, oldestTs: stats.oldestTs }
  } catch {
    return { depth: null, oldestTs: null }
  }
}
