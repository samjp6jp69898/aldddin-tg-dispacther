// lib/log-shipper/shipper.ts — pipeline 監控 DB 化 Phase 7：log-shipper library core。
//
// 規格出處：plan §7.2/§7.4 + plan-db-as-truth-v3.2.md 裁定 4(c)(d)(e)/【G:MN-G9】/
// 【G:MN-G11】（見派工 prompt）。純 library：行程掛載點（setInterval、head 掛
// log-intake、worker 掛 worker-agent）由 2D 整合批次落地，本模組只提供
// `runOneCycle()`，不含任何 sleep/setInterval/自旋重試。
//
// 核心不變式：
//   - offset 語意（裁定 4(d)，逐字）：先 POST/寫 sink，2xx（或 VL 寫入成功）
//     才推進 file_offsets；非 2xx → offset 不推進、本輪結束；upsertFileOffset
//     自身失敗（拋例外）→ 記憶體 offset 也不推進，直到重放成功。結構上只
//     重複、不缺口。
//   - event_seq（【G:MN-G11】）：整個 shipper 行程共用一個記憶體單調計數器
//     （見 event-seq.ts），每次成功推進 file_offsets 呼叫一次 next()。
//   - 續讀游標：純記憶體 {path, inode, offset}（tailer.ts）。inode 變了視為
//     rotate，從 0 讀新檔。呼叫端第一次看到某個 path（無初始 cursor）也是從
//     offset 0 開始——若要接續既有 DB file_offsets 值（例如行程重啟後想避免
//     重送整份歷史），由呼叫端經 `initialCursors` 注入還原後的游標；本模組
//     不做「從 DB 讀回游標」這件事，那是掛載端（2D）的職責，見派工 prompt
//     的檔案所有權聲明。
//
// 批次/速率對齊（裁定 4(c) + intake-server.ts 的每 worker 60 req/min burst
// 120 額度）：LOG_SHIP_INTERVAL_MS 與 MAX_BATCHES_PER_CYCLE 的乘積換算成
// req/min 必須 ≤ 60，見 shipper.test.ts 的純算術測試——任一常數被改壞就紅。

import { basename } from 'node:path'
import { MON_HOST } from '../monitor-db/env.ts'
import { upsertFileOffset, type MonitorDbExecutor } from '../monitor-db/writes.ts'
import { redactLine as defaultRedactLine } from './redaction.ts'
import { createEventSeqCounter, eventSeqToNumber, type EventSeqCounter } from './event-seq.ts'
import { parseLogFilename } from './filename-parse.ts'
import { createRunIdLookup, type RunIdLookup } from './run-id-lookup.ts'
import { tailFile, type TailedLine } from './tailer.ts'
import { batchByBytes } from './batching.ts'
import type { LogSink, ShipLine, TailCursor } from './types.ts'

/** 【G:MN-G9】head/worker 同值：5 秒一輪。 */
export const LOG_SHIP_INTERVAL_MS = 5_000

/** 單輪最多送出的批數上界——對齊每 worker 60 req/min（burst 120）額度，見下方算術測試。 */
export const MAX_BATCHES_PER_CYCLE = 5

/** 軟目標 1MB/請求（裁定 4(c)）。 */
export const MAX_BATCH_BYTES = 1024 * 1024

/** 單行 >2MB 改送截斷摘要（對齊 -insert.maxLineSizeBytes / intake-server.ts 的 MAX_LINE_BYTES）。 */
export const MAX_LINE_BYTES = 2 * 1024 * 1024

const TRUNCATE_SNIPPET_CHARS = 4096

export interface LogShipperDeps {
  /**
   * 本輪要 tail 的來源檔案清單（絕對路徑）。角色差異（head 要 tail
   * telegram-dispatcher logs 目錄下的 .log 檔，外加 aladdin_mcps 各子專案 logs
   * 目錄下的 audit jsonl 檔；worker 只 tail telegram-dispatcher logs 目錄下的
   * .log 檔）由呼叫端注入，本模組不內建角色判斷（見檔頭）。
   */
  listSourceFiles: () => Promise<string[]> | string[]
  sink: LogSink
  executor: MonitorDbExecutor
  /** 預設用 createRunIdLookup(executor)；測試或其他情境可自行注入假查找。 */
  lookupRunId?: RunIdLookup
  redactLine?: (line: string) => string
  now?: () => number
  eventSeqCounter?: EventSeqCounter
  /** stream field host / file_offsets 守衛用的 host 值；預設 MON_HOST
   * （worker 上等於 CLUSTER_WORKER_NAME，head 上是 'head'，見 monitor-db/env.ts）。 */
  host?: string
  /** 記憶體續讀游標的初始值（例如從 DB 現有 file_offsets 還原）——還原本身
   * 不在本模組職責內，見檔頭。 */
  initialCursors?: Record<string, TailCursor>
}

export interface CycleResult {
  linesShipped: number
  batchesSent: number
  filesTouched: string[]
  aborted: boolean
  abortReason?: 'sink_rejected' | 'offset_write_failed'
  abortedPath?: string
}

export interface LogShipper {
  runOneCycle(): Promise<CycleResult>
  /** 目前記憶體游標狀態快照（唯讀，供測試/觀察）。 */
  getCursors(): Record<string, TailCursor>
}

function buildShipLine(
  path: string,
  inode: number,
  ticket: string | null,
  kind: string | null,
  runId: string | null,
  host: string,
  now: () => number,
  redact: (line: string) => string,
): (raw: TailedLine) => ShipLine {
  return raw => {
    const bytes = Buffer.byteLength(raw.text, 'utf8')
    const ts = new Date(now()).toISOString()
    const base = { path, inode, offset: raw.offset, ts, host, source: path, ticket, kind, runId }
    if (bytes > MAX_LINE_BYTES) {
      return {
        ...base,
        truncated: true,
        origBytes: bytes,
        head4k: redact(raw.text.slice(0, TRUNCATE_SNIPPET_CHARS)),
        tail4k: redact(raw.text.slice(-TRUNCATE_SNIPPET_CHARS)),
      }
    }
    return { ...base, content: redact(raw.text) }
  }
}

export function createLogShipper(deps: LogShipperDeps): LogShipper {
  const host = deps.host ?? MON_HOST
  const redact = deps.redactLine ?? defaultRedactLine
  const now = deps.now ?? Date.now
  const eventSeq = deps.eventSeqCounter ?? createEventSeqCounter(now)
  const lookupRunId = deps.lookupRunId ?? createRunIdLookup(deps.executor)
  const cursors = new Map<string, TailCursor>(Object.entries(deps.initialCursors ?? {}))

  async function runOneCycle(): Promise<CycleResult> {
    const result: CycleResult = { linesShipped: 0, batchesSent: 0, filesTouched: [], aborted: false }
    const files = await deps.listSourceFiles()

    for (const path of files) {
      if (result.batchesSent >= MAX_BATCHES_PER_CYCLE) break

      const cursor = cursors.get(path)
      const tailed = tailFile(path, cursor)
      if (tailed === null || tailed.lines.length === 0) continue

      const parsed = parseLogFilename(basename(path))
      const runId = await lookupRunId(host, path)
      const toShip = tailed.lines.map(buildShipLine(path, tailed.inode, parsed.ticket, parsed.kind, runId, host, now, redact))
      const batches = batchByBytes(toShip, line => Buffer.byteLength(JSON.stringify(line), 'utf8'), MAX_BATCH_BYTES)

      let consumedCount = 0
      for (const batch of batches) {
        if (result.batchesSent >= MAX_BATCHES_PER_CYCLE) break // 軟上限：留到下一輪，不算 abort

        const ok = await deps.sink.send(batch)
        result.batchesSent++
        if (!ok) {
          result.aborted = true
          result.abortReason = 'sink_rejected'
          result.abortedPath = path
          return result
        }

        consumedCount += batch.length
        const newOffset = consumedCount === tailed.lines.length ? tailed.newOffset : tailed.lines[consumedCount]!.offset
        const seq = eventSeqToNumber(eventSeq.next())

        try {
          await upsertFileOffset(deps.executor, { path, inode: tailed.inode, offset: newOffset, eventSeq: seq })
        } catch {
          // upsertFileOffset 自身失敗：記憶體 offset 也不推進，直到重放成功。
          result.aborted = true
          result.abortReason = 'offset_write_failed'
          result.abortedPath = path
          return result
        }

        cursors.set(path, { inode: tailed.inode, offset: newOffset })
        result.linesShipped += batch.length
        if (!result.filesTouched.includes(path)) result.filesTouched.push(path)
      }
    }

    return result
  }

  function getCursors(): Record<string, TailCursor> {
    return Object.fromEntries(cursors)
  }

  return { runOneCycle, getCursors }
}
