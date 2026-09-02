// lib/monitor-db/spool/replayer.ts
//
// 重放者核心（v3.2 §6.5(c)(g)）。重放者永遠不寫資料檔（§6.5(b) 不變式 2）
// ——本檔對資料檔只有 readFileSync，唯一的寫入動作是 tmp+rename 原子寫游標
// 檔，以及（dead-letter 命中時）append `<same>.dead.jsonl`（這不是「改寫資料
// 檔」，是另開一個新檔案，資料檔本身仍然原封不動）。
//
// 單一重放者的結構性互斥見 replayer-lock.ts；本檔只負責「拿到鎖之後」該做
// 什麼。正確性不來自順序，來自 §6.1/§6.2 的守衛（順序無關 + 冪等）——重放
// 同一條目任意次數，結果都相同，所以 drainAll() 這種「跑到不再有進展為止」
// 的定點寫法是安全的，不需要靠 sleep/計時去猜「應該跑幾輪」。

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { emptyCursor, isSpoolDataFileName, type CursorState, type SpoolEntry } from './types.ts'

/** §6.5(g)：同一條目連續失敗達此次數才移入 dead-letter 並跳過。 */
export const DEAD_LETTER_THRESHOLD = 5

export interface ReplayDeps {
  /**
   * §6.5(g)：重放者每輪先跑一次 SELECT 1（1000ms 上界，由呼叫端自行實作
   * timeout）。回 false → 本輪整個跳過，不動游標、不加任何 attempts（連不上
   * ≠ 失敗，只是還沒輪到）。
   */
  isDbReachable(): Promise<boolean>
  /** 對應 §6.2 具名寫入函式的實際呼叫（由 lib/monitor-db/writes.ts 提供，
   * 尚未存在——這是本檔對它的 thin interface）。 */
  applyEntry(entry: SpoolEntry): Promise<{ ok: boolean; reason?: string }>
  now?(): number
}

export interface ReplayFileSummary {
  file: string
  replayed: number
  deadLettered: number
  /** 本輪是否因為某條目未達 5 次門檻而卡住、沒有繼續處理該檔後面的條目。 */
  blocked: boolean
}

export interface ReplayRoundSummary {
  skipped: boolean
  reason?: string
  files: ReplayFileSummary[]
}

export function readCursor(cursorPath: string): CursorState {
  if (!existsSync(cursorPath)) return emptyCursor()
  try {
    return JSON.parse(readFileSync(cursorPath, 'utf8')) as CursorState
  } catch {
    return emptyCursor()
  }
}

/**
 * tmp + rename 原子寫游標檔；rename 只覆蓋游標檔，不覆蓋資料檔（§6.5(c)）——
 * 同時發生的 append 一個位元組都不會消失。游標檔與其父目錄各 fsync 一次
 * （§6.5(a2)：游標是進度的唯一載體，它的原子性是整節推論的前提）。
 */
export function writeCursorAtomic(cursorPath: string, state: CursorState): void {
  const dir = dirname(cursorPath)
  const tmp = join(dir, `.${basename(cursorPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(state))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, cursorPath)
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

interface LineEntry {
  entry: SpoolEntry
  /** 這一行結束後的位元組偏移量（相對整檔），成功重放後游標就推進到這裡。 */
  endByte: number
}

/**
 * 從 fromByte 讀到最後一個完整換行為止（半行留到下次——寫入者正在寫的最後
 * 一行有可能還沒收尾）。壞行（理論上不該出現，因為已經排除半行）跳過但仍
 * 前進，不讓整檔卡死在一行解析不出來的資料上。
 */
function readLinesFromOffset(filePath: string, fromByte: number): LineEntry[] {
  const buf = readFileSync(filePath)
  const out: LineEntry[] = []
  let pos = fromByte
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl === -1) break
    const lineStr = buf.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    if (lineStr.length === 0) continue
    try {
      out.push({ entry: JSON.parse(lineStr) as SpoolEntry, endByte: pos })
    } catch {
      // 壞行：跳過但仍前進（見上方註解），不回報，留給人工事後從檔案內容
      // 診斷（這條路徑目前沒有已知的觸發方式，是防禦性的）。
    }
  }
  return out
}

function listSpoolDataFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(isSpoolDataFileName).sort()
}

function appendDeadEntry(dataFilePath: string, entry: SpoolEntry, reason: string | undefined): void {
  const deadPath = dataFilePath.replace(/\.jsonl$/, '.dead.jsonl')
  const fd = openSync(deadPath, 'a', 0o600)
  try {
    writeSync(fd, `${JSON.stringify({ ...entry, dead_reason: reason ?? 'unknown' })}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function replayFile(filePath: string, deps: ReplayDeps): Promise<ReplayFileSummary> {
  const cursorPath = `${filePath}.cursor`
  const cursor = readCursor(cursorPath)
  const lines = readLinesFromOffset(filePath, cursor.acked_bytes)

  let replayed = 0
  let deadLettered = 0
  let blocked = false
  let changed = false

  for (const { entry, endByte } of lines) {
    const result = await deps.applyEntry(entry)
    if (result.ok) {
      cursor.acked_bytes = endByte
      cursor.acked_seq = entry.seq
      delete cursor.failing[String(entry.seq)]
      replayed += 1
      changed = true
      continue
    }

    const attempts = (cursor.failing[String(entry.seq)] ?? 0) + 1
    if (attempts >= DEAD_LETTER_THRESHOLD) {
      // §6.5(g)：達 5 次 → 移入 dead-letter 並推進游標跳過它，否則它會擋住
      // 後面全部條目。
      appendDeadEntry(filePath, entry, result.reason)
      cursor.acked_bytes = endByte
      cursor.acked_seq = entry.seq
      delete cursor.failing[String(entry.seq)]
      deadLettered += 1
      changed = true
      continue
    }

    cursor.failing[String(entry.seq)] = attempts
    changed = true
    blocked = true
    break // 未達 5 次前游標不推進；冪等靠守衛，不靠「這輪一定要處理完」
  }

  if (changed) {
    cursor.updated_at = new Date((deps.now ?? Date.now)()).toISOString()
    writeCursorAtomic(cursorPath, cursor)
  }

  return { file: filePath, replayed, deadLettered, blocked }
}

/** 跑一輪重放。DB 不可達 → 整輪跳過，游標與 attempts 完全不動（§6.5(g)）。 */
export async function replayOnce(dir: string, deps: ReplayDeps): Promise<ReplayRoundSummary> {
  const reachable = await deps.isDbReachable()
  if (!reachable) return { skipped: true, reason: 'db_unreachable', files: [] }

  const files = listSpoolDataFiles(dir)
  const summaries: ReplayFileSummary[] = []
  for (const name of files) {
    summaries.push(await replayFile(join(dir, name), deps))
  }
  return { skipped: false, files: summaries }
}

/**
 * 重放到不再有進展為止（定點）。這是 Phase 1.4 測試用來取代 sleep/輪詢的
 * 確定性寫法——不是等時間，是等「沒有更多可推進的條目」這個結構性條件成立。
 * DB 不可達時立刻停止（不會無窮迴圈空等一個永遠不通的連線）。
 */
export async function drainAll(dir: string, deps: ReplayDeps, maxRounds = 10_000): Promise<ReplayRoundSummary[]> {
  const rounds: ReplayRoundSummary[] = []
  for (let i = 0; i < maxRounds; i++) {
    const summary = await replayOnce(dir, deps)
    rounds.push(summary)
    if (summary.skipped) return rounds
    const progressed = summary.files.some(f => f.replayed > 0 || f.deadLettered > 0)
    if (!progressed) return rounds
  }
  return rounds
}
