// lib/monitor-db/spool/writer.ts
//
// spool 寫入者（v3.2 §6.5(a)(a2)(b)(f)）。每個寫入者一檔、append-only、批次
// fsync。三條不變式（§6.5(b)）：
//   1. 寫入者只對自己那一檔 append，永不改寫、永不截斷、永不 rename 資料檔。
//   2. 重放者永不寫資料檔（本檔不提供任何讓重放者呼叫的寫入 API——那是
//      replayer.ts 的事，且它只讀資料檔、只寫游標檔）。
//   3. 只有回收器會 unlink 資料檔（見 reaper.ts）。
// → rename(2) 整檔替換這個動作在資料檔上完全不存在，BL-E1 / BLOCKER-F1 的
//   失敗時序（A 的 rename 吃掉 B 的 append）結構上不可能發生。
//
// durability（§6.5(a2)）：不做 per-record fsync，改為「每批 append 結束後對
// 該檔 fsync 一次」。理由：spool 的寫入者包含 grammy webhook 所在的
// server.ts，per-record fsync 會把非阻斷寫入變成同步磁碟等待，與 §6.7 的
// 非阻斷紀律衝突。這是明文承認的代價（斷電可能丟最後一批未 fsync 的未 ack
// 條目），不是遺漏。

import { closeSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { SPOOL_DIR, buildSpoolFileName, type SpoolEntry, type SpoolWriterName } from './types.ts'

/** §6.5(f)：單檔超過 64MB 時，由該檔的寫入者自己關檔、以新的 startEpochMs
 * 開新檔（舊檔交給回收器）。輪替永遠只由該檔的寫入者做，重放者與回收器都
 * 不做。 */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024

/**
 * 「寫入目標的 row 身分帶 `run_id`」的具名寫入函式（`runs` 與 `agent_runs`
 * 兩張表的全部寫入者，對照 `lib/monitor-db/apply-entry.ts` 的分派表）。
 * 只有這些 fn 的 spool 條目強制要求非空 `run_id`；其餘 fn（`upsertFileOffset`
 * / `insertMcpUsage` / `upsertMonitorHeartbeat` / `insertStatusLogRow` /
 * `insertTgUnknownSender` / `dispatch_attempts` 三支）的列結構上沒有 run_id，
 * 允許 `null`（2026-09-02 指揮官裁定，理由見 types.ts 的 SpoolEntry 說明）。
 *
 * 刻意用「白名單 + 未知 fn 視為非 run 類」而不是黑名單：apply-entry.ts 對
 * 未知 fn 本來就回 `{ok:false}` 而不是拋例外，寫入端沒有理由比重放端更嚴格。
 */
export const RUN_SCOPED_SPOOL_FNS: ReadonlySet<string> = new Set([
  'writeRunProgress',
  'writeRunOutcomeAuthoritative',
  'writeRunOutcomeProvisional',
  'writeCancelFlag',
  'fixCancelLateOutcome',
  'upsertAgentRun',
])

export function isRunScopedSpoolFn(fn: string): boolean {
  return RUN_SCOPED_SPOOL_FNS.has(fn)
}

export interface SpoolWriterHandle {
  /** 對自己那一檔 append 一條（等同 appendBatch([entry])）。 */
  append(entry: Omit<SpoolEntry, 'seq'>): void
  /** 一次 write() 呼叫批次的結尾做一次 fsync（§6.5(a2)）。 */
  appendBatch(entries: Array<Omit<SpoolEntry, 'seq'>>): void
  /** 目前正在寫的資料檔完整路徑（輪替後會變）。 */
  filePath(): string
  close(): void
}

export interface CreateSpoolWriterOpts {
  writer: SpoolWriterName | string
  dir?: string
  /** 測試用覆寫；正式環境一律用行程自己的 pid（呼叫端不傳）。 */
  pid?: number
  /** 測試用覆寫；正式環境一律用行程啟動當下的 epoch ms（呼叫端不傳）。 */
  startEpochMs?: number
  maxFileBytes?: number
}

export function createSpoolWriter(opts: CreateSpoolWriterOpts): SpoolWriterHandle {
  const dir = opts.dir ?? SPOOL_DIR
  const pid = opts.pid ?? process.pid
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  let startEpochMs = opts.startEpochMs ?? Date.now()
  let filePath = join(dir, buildSpoolFileName(opts.writer, pid, startEpochMs))
  let fd = openSync(filePath, 'a', 0o600)
  let seq = 0

  function currentSize(): number {
    try {
      return statSync(filePath).size
    } catch {
      return 0
    }
  }

  function rotateIfNeeded(): void {
    if (currentSize() < maxFileBytes) return
    closeSync(fd)
    startEpochMs = Date.now()
    filePath = join(dir, buildSpoolFileName(opts.writer, pid, startEpochMs))
    fd = openSync(filePath, 'a', 0o600)
    seq = 0
  }

  function writeEntries(entries: Array<Omit<SpoolEntry, 'seq'>>): void {
    if (entries.length === 0) return
    rotateIfNeeded()
    let payload = ''
    for (const e of entries) {
      // 【G:MJ-G2】的硬規則（2026-09-02 裁定後改為 per-fn，見 types.ts 的
      // SpoolEntry 說明）：**寫入目標的 row 身分帶 run_id 的 fn**（runs /
      // agent_runs）條目，run_id 不得為空、不得留給重放時再解析——這裡是全案
      // 唯一的落地檢查點，寧可讓呼叫端當場炸掉，也不要讓一條無主的條目躺進
      // spool 等重放時才發現解析不出來。其餘表（file_offsets / mcp_usage /
      // monitor_heartbeat / *_log / tg_unknown_senders）結構上沒有 run_id，
      // 允許 null。
      if (isRunScopedSpoolFn(e.fn) && !e.run_id) {
        throw new Error(
          `spool writer(${opts.writer}): fn='${e.fn}' 是 runs/agent_runs 類寫入，條目缺少 run_id，拒絕寫入` +
            `（v3.2 §6.5(a) 硬規則 / 【G:MJ-G2】，per-fn 適用範圍見 spool/types.ts）`,
        )
      }
      seq += 1
      const record: SpoolEntry = { seq, ...e }
      payload += `${JSON.stringify(record)}\n`
    }
    writeSync(fd, payload)
    fsyncSync(fd) // 每批 append 結束後對該檔 fsync 一次，不做 per-record fsync（§6.5(a2)）
  }

  return {
    append(entry) {
      writeEntries([entry])
    },
    appendBatch(entries) {
      writeEntries(entries)
    },
    filePath() {
      return filePath
    },
    close() {
      closeSync(fd)
    },
  }
}
