// lib/log-shipper/tailer.ts — 單一檔案的增量 tail（純函式，注入路徑，真實 fs I/O）。
//
// 續讀游標語意（plan §7.2 逐字，見派工 prompt 第 3 條）：
//   - 記憶體 {path, inode, offset} 游標（DB 側持久化交給呼叫端經
//     lib/monitor-db/writes.ts 的 upsertFileOffset）。
//   - inode 變了（rotate）從 0 讀新檔。
//   - 半行（無換行結尾）留到下一輪：不解碼、不消耗那段 bytes，下一輪原封不動
//     從舊 offset 重讀（含之後補寫進來的剩餘內容）。
//
// 行邊界一律用 '\n'（單位元組 ASCII，不可能落在多位元組 UTF-8 字元中間），
// 故逐行 Buffer.byteLength 統計「消耗掉的 bytes」不會有邊界誤差。

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { TailCursor } from './types.ts'

export interface TailedLine {
  text: string
  /** 這行在檔案內的起始 byte offset。 */
  offset: number
}

export interface TailResult {
  lines: TailedLine[]
  inode: number
  /** 讀完這批完整行之後的新 offset（半行的 bytes 不計入，留給下一輪）。 */
  newOffset: number
  rotated: boolean
  /** 這次讀到的內容尾端是否有未完成的半行（純觀察用，不影響游標語意）。 */
  hasIncompleteTail: boolean
}

/**
 * 檔案不存在 / stat 失敗 → 回傳 null（呼叫端略過這個來源，不是硬錯誤——
 * pipeline log 檔案本來就會隨 pipeline 結束而被清掉）。
 */
export function tailFile(path: string, cursor: TailCursor | undefined): TailResult | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    const inode = Number(stat.ino)
    const rotated = cursor !== undefined && cursor.inode !== inode
    const startOffset = cursor === undefined || rotated ? 0 : cursor.offset
    const size = stat.size

    if (size <= startOffset) {
      return { lines: [], inode, newOffset: startOffset, rotated, hasIncompleteTail: false }
    }

    const length = size - startOffset
    const buf = Buffer.alloc(length)
    let readTotal = 0
    while (readTotal < length) {
      const n = readSync(fd, buf, readTotal, length - readTotal, startOffset + readTotal)
      if (n === 0) break // 防禦性跳出（理論上不會提前 EOF）：避免無窮迴圈
      readTotal += n
    }
    const data = buf.subarray(0, readTotal)
    const text = data.toString('utf8')
    const parts = text.split('\n')
    // 換行結尾時最後一個 split 元素是空字串；沒換行結尾時是半行本體——兩種
    // 情況都用 slice(0,-1) 拿掉，只保留真正完整的行。
    const lastPart = parts[parts.length - 1]
    const hasIncompleteTail = lastPart !== undefined && lastPart.length > 0
    const completeParts = parts.slice(0, -1)

    const lines: TailedLine[] = []
    let cursorOffset = startOffset
    for (const part of completeParts) {
      lines.push({ text: part, offset: cursorOffset })
      cursorOffset += Buffer.byteLength(part, 'utf8') + 1 // +1 for '\n'
    }

    return { lines, inode, newOffset: cursorOffset, rotated, hasIncompleteTail }
  } finally {
    closeSync(fd)
  }
}
