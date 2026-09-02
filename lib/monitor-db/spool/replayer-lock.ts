// lib/monitor-db/spool/replayer-lock.ts
//
// 單一重放者的結構性互斥（v3.2 §6.5(d)(e3)）：
//   一個 spool 目錄恰好一個重放者行程（寫入者可以多個）。重放者啟動時以
//   O_CREAT|O_EXCL 建鎖檔：
//     - 建檔成功 → 成為重放者。
//     - 已存在且該 pid 仍活著（ps -p 且啟動時刻與鎖檔內的一致）→ 不重放、
//       記 ERROR、TG 告警（絕不等、絕不搶）。
//     - 已存在但 pid 已死或啟動時刻不符（pid 重用）→ 接管並覆寫鎖檔。
//     - 行程正常退出時 unlink 鎖檔。
// 接管判定同樣走 readProcStartMs 的 fail-closed 方向（【G:MJ-G4】(e3)：「這三
// 條同樣適用於 (d) 的 .replayer.lock 接管判定——那是同一個機制的另一個現場，
// 方向也一樣是 fail-closed」）。絕不因為「讀不出啟動時刻」就搶鎖——那會產生
// 兩個重放者，直接打掉這個模組唯一的不變式。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isPidAlive, readProcStartMs } from './proc-start.ts'
import { REPLAYER_LOCK_NAME } from './types.ts'

export interface ReplayerLockContent {
  pid: number
  writer: string
  /** 取得鎖當下，鎖持有者自己的行程啟動時刻（由 readProcStartMs(pid) 取得）；
   * 若當下解析不出來就記 null——之後別的行程想接管時，遇到 null 會走保守
   * 路徑（見下方 acquireReplayerLock 的說明）。 */
  startedAt: number | null
}

export type AcquireResult = { ok: true } | { ok: false; reason: 'held_alive' | 'held_unknown' }

export interface ReplayerLockDeps {
  isPidAlive?(pid: number): boolean
  readProcStartMs?(pid: number): number | null
}

function lockPathFor(dir: string): string {
  return join(dir, REPLAYER_LOCK_NAME)
}

function readLockFile(path: string): ReplayerLockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.writer === 'string') {
      return { pid: parsed.pid, writer: parsed.writer, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null }
    }
    return null
  } catch {
    return null
  }
}

function writeLockFile(path: string, content: ReplayerLockContent): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(content))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 嘗試成為重放者。成功即建檔；已存在時依 fail-closed 方向判斷是否接管
 * （見檔頭說明，與 reaper.ts 的 readProcStartMs 使用方式同一組規則）。
 */
export function acquireReplayerLock(dir: string, writer: string, pid: number = process.pid, deps: ReplayerLockDeps = {}): AcquireResult {
  const isAlive = deps.isPidAlive ?? isPidAlive
  const readStart = deps.readProcStartMs ?? readProcStartMs
  const path = lockPathFor(dir)
  const selfStart = readStart(pid)

  // 2026-09-02 熱修：O_CREAT|O_EXCL 不會建父目錄，spool 目錄在任何寫入者
  // 真的 append 過一筆之前不存在（writer.ts 的 mkdirSync 只在 createSpoolWriter
  // 內，本函式是獨立進入點）——boot 時第一個呼叫這裡的行程若先於任何寫入
  // 發生，openSync 會拋 ENOENT，未被外層捕捉會直接讓 server/worker-agent
  // crash loop。
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  try {
    const fd = openSync(path, 'wx', 0o600) // O_CREAT|O_EXCL：已存在即拋 EEXIST
    try {
      writeSync(fd, JSON.stringify({ pid, writer, startedAt: selfStart }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  const existing = readLockFile(path)
  if (!existing) {
    // 鎖檔存在但內容無法解析：無法確定持有者身分 → fail-closed，不接管。
    return { ok: false, reason: 'held_unknown' }
  }

  if (isAlive(existing.pid)) {
    const currentStart = readStart(existing.pid)
    if (currentStart === null) {
      // 【G:MJ-G4】：現在解析失敗 → 視為持有者仍活著，不接管、記 ERROR。
      return { ok: false, reason: 'held_unknown' }
    }
    if (existing.startedAt === null) {
      // 鎖檔當初取得時就沒能記到啟動時刻，現在也就無法比對出「不一致」——
      // 無法確定是否為 pid 重用，同樣 fail-closed：寧可誤判為活著，不誤判
      // 為可接管。
      return { ok: false, reason: 'held_unknown' }
    }
    if (currentStart === existing.startedAt) {
      // pid 活著且啟動時刻與鎖檔內一致 → 真的是同一個持有者，不接管。
      return { ok: false, reason: 'held_alive' }
    }
    // currentStart !== existing.startedAt → pid 被重用，原持有者已死，接管。
  }
  // 走到這裡：pid 已死，或 pid 存活但確定是被重用 → 接管並覆寫鎖檔。
  writeLockFile(path, { pid, writer, startedAt: selfStart })
  return { ok: true }
}

/**
 * 行程正常退出時 unlink 鎖檔（§6.5(d)）。只在鎖檔仍記著自己的 pid 時才刪，
 * 避免刪掉別人剛接管的鎖（理論上單一重放者不變式下不該發生，仍防禦寫）。
 */
export function releaseReplayerLock(dir: string, pid: number = process.pid): void {
  const path = lockPathFor(dir)
  if (!existsSync(path)) return
  const existing = readLockFile(path)
  if (existing && existing.pid !== pid) return
  try {
    unlinkSync(path)
  } catch {
    // best-effort：unlink 失敗不該讓行程退出流程掛掉。
  }
}
