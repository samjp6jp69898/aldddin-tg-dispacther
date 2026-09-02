// lib/monitor-db/spool/reaper.ts
//
// 回收器（v3.2 §6.5(e)）：唯一會 unlink 資料檔的角色，與重放者同一行程、同
// 一 tick 執行。刪除條件必須全部成立，且【G:MN-G5】求值順序寫死如下，不得
// 調換：
//
//   步驟 1（先驗死活）→ 步驟 2（再 stat）→ 步驟 3（最後比對）。
//
// 之所以必須是這個順序：若先 stat 取 size、再驗寫入者死活，兩者之間的
// append 會被漏掉（acked_bytes == size_old 通過 → unlink → 那段 append 永遠
// 消失）。條件 3（mtime > 5 分鐘）不是正確性依據，正確性必須由求值順序本身
// 保證——本檔的實作嚴格遵守這個順序：任何一個檔案的 stat() 呼叫，前面一定
// 已經先做完該檔的死活判定。

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { floorToSecond, isPidAlive, readProcStartMs } from './proc-start.ts'
import { emptyCursor, isSpoolDataFileName, parseSpoolFileName, type CursorState } from './types.ts'

const DEFAULT_STALE_MS = 5 * 60 * 1000

export interface StatResult {
  size: number
  mtimeMs: number
}

export interface ReaperDeps {
  isPidAlive?(pid: number): boolean
  readProcStartMs?(pid: number): number | null
  stat?(path: string): StatResult
  readCursor?(cursorPath: string): CursorState
  now?(): number
  /** 對應 spool_reap_unknown_pidstart 計數器（§6.5(e2) 硬規則 2）。 */
  onWarn?(metric: string, detail?: Record<string, unknown>): void
  /** 測試用覆寫；正式環境用 DEFAULT_STALE_MS（5 分鐘）。 */
  staleMs?: number
}

export interface ReclaimResult {
  /** 被刪除的檔名（資料檔與孤兒游標檔都算，各自以自己的檔名列出）。 */
  reclaimed: string[]
  skipped: Array<{ file: string; reason: string }>
}

function defaultReadCursor(cursorPath: string): CursorState {
  if (!existsSync(cursorPath)) return emptyCursor()
  try {
    return JSON.parse(readFileSync(cursorPath, 'utf8')) as CursorState
  } catch {
    return emptyCursor()
  }
}

function defaultStat(path: string): StatResult {
  const s = statSync(path)
  return { size: s.size, mtimeMs: s.mtimeMs }
}

/**
 * 掃描 dir，回收「寫入者已終止 且 全部重放完 且 已閒置 > 5 分鐘」的資料檔
 * （＋其游標檔），並清掉孤兒游標檔（沒有對應資料檔的 `.cursor`）。
 *
 * self：長駐行程自己的身分（writer 名 + 目前的 pid）——self 目前正在寫的那
 * 一檔永遠不回收（§6.5(e) 步驟 1 的第三條）。
 */
export function reclaimSpoolFiles(dir: string, self: { writer: string; pid: number }, deps: ReaperDeps = {}): ReclaimResult {
  const isAlive = deps.isPidAlive ?? isPidAlive
  const readStart = deps.readProcStartMs ?? readProcStartMs
  const statFn = deps.stat ?? defaultStat
  const readCursor = deps.readCursor ?? defaultReadCursor
  const now = deps.now ?? Date.now
  const warn = deps.onWarn ?? (() => {})
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS

  const result: ReclaimResult = { reclaimed: [], skipped: [] }
  if (!existsSync(dir)) return result

  const allNames = readdirSync(dir)
  const dataFileNames = allNames.filter(isSpoolDataFileName)

  for (const name of dataFileNames) {
    const parsed = parseSpoolFileName(name)
    if (!parsed) {
      result.skipped.push({ file: name, reason: 'unparseable_name' })
      continue
    }
    const { writer, pid, startEpochMs } = parsed

    // 長駐行程的當前檔（pid == 自己）永遠不回收。
    if (writer === self.writer && pid === self.pid) {
      result.skipped.push({ file: name, reason: 'own_current_file' })
      continue
    }

    // ---- 步驟 1（先驗死活）：嚴禁在這之前對這個檔案呼叫 stat ----
    if (isAlive(pid)) {
      const startMs = readStart(pid)
      if (startMs === null) {
        // 【G:MJ-G4】解析失敗 → 視為仍存活，不回收，記 WARN。
        warn('spool_reap_unknown_pidstart', { file: name, pid })
        result.skipped.push({ file: name, reason: 'unknown_pidstart' })
        continue
      }
      if (!(startMs > floorToSecond(startEpochMs))) {
        // 沒有偵測到 pid 重用：這個 pid 現在活著的行程，就是當初建這個檔案
        // 的那個寫入者本人，仍在跑，不回收。
        result.skipped.push({ file: name, reason: 'writer_alive' })
        continue
      }
      // 走到這裡：pid 活著，但啟動時刻晚於檔名裡的 startEpochMs → pid 被
      // 重用，原寫入者已終止，繼續往下走（視同「已終止」）。
    }
    // isAlive(pid) === false：pid 不存在，寫入者已終止，繼續往下走。

    // ---- 步驟 2（再 stat）：確認終止後才讀檔案大小 ----
    const filePath = join(dir, name)
    const stat = statFn(filePath)

    // ---- 步驟 3（最後比對）----
    const cursorPath = `${filePath}.cursor`
    const cursor = readCursor(cursorPath)
    const idleMs = now() - stat.mtimeMs
    if (cursor.acked_bytes === stat.size && idleMs > staleMs) {
      unlinkSync(filePath)
      if (existsSync(cursorPath)) unlinkSync(cursorPath)
      result.reclaimed.push(name)
    } else {
      result.skipped.push({
        file: name,
        reason: cursor.acked_bytes !== stat.size ? 'not_fully_acked' : 'too_recent',
      })
    }
  }

  // 孤兒游標檔（沒有對應資料檔，含剛被上面回收掉的那些）下一輪／本輪直接
  // 刪除；用實際檔案是否存在判斷，不靠集合追蹤，避免與上面的回收動作重複
  // 計數或漏刪。
  for (const name of allNames) {
    if (!name.endsWith('.cursor')) continue
    const dataName = name.slice(0, -'.cursor'.length)
    if (isSpoolDataFileName(dataName) && existsSync(join(dir, dataName))) continue // 有活著的對應資料檔
    const cursorPath = join(dir, name)
    if (!existsSync(cursorPath)) continue // 已經在上面被連帶刪掉了
    try {
      unlinkSync(cursorPath)
      result.reclaimed.push(name)
    } catch {
      // best-effort
    }
  }

  return result
}
