// lib/monitor-db/collectors/audit-ingester.ts — Phase 4 collector：
// hosted MCP server 的稽核 JSONL（`aladdin_mcps/*/logs/audit*.jsonl`）→ `mcp_usage`。
// **head only**（§11.1 授權對映：`mcp_usage` 是 head only 的表，`mon_exec` 碰不到）。
//
// 規格出處：
//   - plan-db-as-truth-v3.md §11.1（`mcp_usage`：`UNIQUE(service, raw_sha256)`、
//     寫入者＝audit ingester（head only））、§6.2.2（`file_offsets` 守衛；migration
//     002 後改為 `event_seq` 單調守衛，見 writes.ts 的說明）、§7.4（續讀游標平移
//     現有 `file_offsets` 模式）、§9.0(B)（flag 關閉時完全不啟動）。
//   - 語意移植自 `tg-monitor/lib/ingest.ts` 的 `ingestAuditLogs` / `readNewLines`
//     （唯讀參考，未 import；兩個 repo 沒有 import 關係）。
//
// 續讀游標：`file_offsets`（`host` + path + inode + offset），逐行增量讀、
// **位元組 offset、半行留待下次**。實際的 tail 用同 repo 既有的
// `lib/log-shipper/tailer.ts`（inode 變＝rotate 從 0 讀、半行不消耗），不重寫
// 一份相同邏輯；`event_seq` 用同 repo 既有的記憶體單調計數器
// （`lib/log-shipper/event-seq.ts`）。兩者都只 import、不修改。
//
// 失敗處置（兩層，順序固定）：
//   1. **落 spool**（2026-09-02 指揮官裁定：`run_id` 硬規則改為 per-fn 之後，
//      `insertMcpUsage` / `upsertFileOffset` 這類結構上沒有 run_id 的條目
//      允許 `run_id: null` 進 spool，見 `spool/writer.ts` 的
//      `RUN_SCOPED_SPOOL_FNS`）。一旦某一行寫失敗，本檔本輪剩下的行全部改走
//      spool（DB 已經不可用，逐行重試只是把 1000ms 預算乘上行數），offset 照常
//      推進——條目在 spool 裡，重放者會補上，結構上不缺口。
//   2. spool 本身也不可用（未注入／append 失敗）→ 退回 Phase 7 log shipper 對
//      `file_offsets` 的既有處置：**offset 不推進**，下一輪從同一位置重讀
//      （「緩衝天然由『檔案還在執行機上、offset 沒推進』提供」）。
//   兩層都靠 `UNIQUE(service, raw_sha256)` 的 `INSERT IGNORE` 保證重放安全
//   （結構上只重複、不缺口）。
import { existsSync } from 'node:fs'
import { MON_HOST, isMonitorDbEnabled } from '../env.ts'
import { withMonitorDeadline } from '../deadline.ts'
import { insertMcpUsage, upsertFileOffset, type InsertMcpUsageInput, type MonitorDbExecutor } from '../writes.ts'
import type { SpoolWriterHandle } from '../spool/writer.ts'
import { createEventSeqCounter, eventSeqToNumber, type EventSeqCounter } from '../../log-shipper/event-seq.ts'
import { tailFile } from '../../log-shipper/tailer.ts'
import type { TailCursor } from '../../log-shipper/types.ts'

const MCPS_DIR = '/Users/user/aladdin/aladdin_mcps'

export interface AuditSource {
  /** `mcp_usage.service` 值；必須與 tg-monitor 的 `SERVICES[].id` 一致（見下方註解）。 */
  service: string
  /** 稽核 JSONL 主檔絕對路徑（輪替檔 `<path>.1` 由本模組自動補讀）。 */
  path: string
}

/**
 * 稽核來源名冊：**逐項複製自 `tg-monitor/lib/services.ts` 的 `SERVICES[].id` ↔
 * `auditLog`**（兩個 repo 各自獨立、沒有 import 關係，比照 ingest.ts 對
 * `CREATE_MR_TIMEOUT_SECONDS` 的既有處置——那邊也是複製常數並註明「改動時要
 * 同步調整」）。
 *
 * 為什麼不用 glob 推導 service 名：id 不是路徑的函式——
 * `aladdin-admin/logs/audit.jsonl` 的 id 是 `admin-dev`、`audit.pre.jsonl` 是
 * `admin-pre`、`aladdin-platform/logs/audit.jsonl` 是 `platform`。Phase 8 讀取面
 * 要拿 MySQL 的 `mcp_usage.service` 對上 sqlite 既有值，猜錯一個字就對不起來。
 */
export const AUDIT_SOURCES: readonly AuditSource[] = Object.freeze([
  { service: 'toolsmith', path: `${MCPS_DIR}/aladdin-toolsmith/logs/audit.jsonl` },
  { service: 'admin-dev', path: `${MCPS_DIR}/aladdin-admin/logs/audit.jsonl` },
  { service: 'admin-pre', path: `${MCPS_DIR}/aladdin-admin/logs/audit.pre.jsonl` },
  { service: 'admin-evi', path: `${MCPS_DIR}/aladdin-admin/logs/audit.evi.jsonl` },
  { service: 'platform', path: `${MCPS_DIR}/aladdin-platform/logs/audit.jsonl` },
  { service: 'platform-6t', path: `${MCPS_DIR}/aladdin-platform/logs/audit.dev-6t.jsonl` },
  { service: 'platform-pre-pk', path: `${MCPS_DIR}/aladdin-platform/logs/audit.pre-pk.jsonl` },
  { service: 'platform-pre-6t', path: `${MCPS_DIR}/aladdin-platform/logs/audit.pre-6t.jsonl` },
  { service: 'platform-evi-6t', path: `${MCPS_DIR}/aladdin-platform/logs/audit.evi-6t.jsonl` },
])

export const FILE_OFFSET_SELECT_SQL = 'SELECT inode, `offset` FROM file_offsets WHERE host = ? AND path = ?'

export interface AuditIngestStats {
  skippedNoExecutor: boolean
  filesScanned: number
  linesRead: number
  linesInserted: number
  /** 不是合法 JSON、或缺少 `ts` → 跳過該行但**照樣消耗**（壞行不會卡住整個檔案）。 */
  linesInvalid: number
  /** DB 寫入失敗後改落 spool 的行數（重放者會補上，offset 照常推進）。 */
  linesSpooled: number
  /** file_offsets 推進改由 spool 承接的次數。 */
  offsetsSpooled: number
  /** DB 與 spool 兩層都不可用 → 該檔本輪中止、offset 不推進（下輪重讀）。 */
  filesAborted: number
  /** 讀不回既有 offset（DB 不可達）→ 該檔本輪跳過，不從 0 重讀。 */
  cursorLoadErrors: number
  /** upsertFileOffset 失敗 → 記憶體 offset 也不推進。 */
  offsetWriteErrors: number
}

function emptyStats(): AuditIngestStats {
  return {
    skippedNoExecutor: false,
    filesScanned: 0,
    linesRead: 0,
    linesInserted: 0,
    linesInvalid: 0,
    linesSpooled: 0,
    offsetsSpooled: 0,
    filesAborted: 0,
    cursorLoadErrors: 0,
    offsetWriteErrors: 0,
  }
}

export interface AuditIngesterDeps {
  /**
   * 取得本行程的 monitor DB executor；`null` ＝ 本輪整輪跳過。接線層一律傳
   * runtime.ts 既有的取得路徑（head=mon_head），**本模組絕不自行 createPool**。
   */
  getExecutor: () => Promise<MonitorDbExecutor | null>
  /**
   * 長駐行程的 spool writer **取得函式**（production 接線層傳
   * `getLongLivedMonitorSpoolWriter`）。刻意是函式不是實例：`createSpoolWriter`
   * 會當場開檔，掛載時就取實例等於「一啟動就在 logs/spool/ 生一個空檔」，
   * 這裡只在真的需要落 spool 時才取。不注入＝沒有 spool 退路，寫入失敗時
   * 一律走「offset 不推進、下輪重讀」。
   */
  getSpool?: () => SpoolWriterHandle
  sources?: readonly AuditSource[]
  host?: string
  eventSeqCounter?: EventSeqCounter
  now?: () => number
  /** 單次查詢的逾時預算（§6.7，預設 1000ms）。測試注入小值以確定性驗證逾時路徑。 */
  queryBudgetMs?: number
}

export interface AuditIngester {
  runOnce(): Promise<AuditIngestStats>
  getCursors(): Record<string, TailCursor>
}

interface AuditLine {
  ts: string
  identity: string | null
  sourceIp: string | null
}

/** 解析一行稽核 JSONL；不合法（非 JSON / 無 ts / ts 不是合法時間）回 null。 */
export function parseAuditLine(raw: string): AuditLine | null {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null) return null
  const o = j as Record<string, unknown>
  if (typeof o.ts !== 'string' || !o.ts) return null
  const d = new Date(o.ts)
  if (Number.isNaN(d.getTime())) return null
  return {
    ts: d.toISOString(),
    identity: typeof o.identity === 'string' ? o.identity : null,
    sourceIp: typeof o.sourceIp === 'string' ? o.sourceIp : null,
  }
}

export function createAuditIngester(deps: AuditIngesterDeps): AuditIngester {
  const sources = deps.sources ?? AUDIT_SOURCES
  const host = deps.host ?? MON_HOST
  const now = deps.now ?? Date.now
  const eventSeq = deps.eventSeqCounter ?? createEventSeqCounter(now)
  const cursors = new Map<string, TailCursor>()
  /** 已經（成功或確認無列地）從 DB 還原過游標的 path，避免每輪都重打一次 SELECT。 */
  const restored = new Set<string>()

  /** 回傳 `undefined` 代表 SELECT 失敗（DB 不可達）→ 呼叫端本輪跳過該檔。 */
  async function loadCursor(pool: MonitorDbExecutor, path: string): Promise<TailCursor | null | undefined> {
    const inMemory = cursors.get(path)
    if (inMemory) return inMemory
    if (restored.has(path)) return null
    try {
      // §6.7：對位／游標 SELECT 一律套 1000ms deadline（對抗性審查 B1）——
      // tunnel 半開時裸 await 會讓整輪 runOnce 永遠掛住，spooling 降級旗標
      // 也就永遠不會被設起來。
      const [rows] = await withMonitorDeadline(
        'file_offsets SELECT',
        () => pool.execute(FILE_OFFSET_SELECT_SQL, [host, path]),
        deps.queryBudgetMs,
      )
      restored.add(path)
      const list = Array.isArray(rows) ? (rows as Array<{ inode?: unknown; offset?: unknown }>) : []
      const row = list[0]
      if (!row || row.inode == null) return null
      const cursor: TailCursor = { inode: Number(row.inode), offset: Number(row.offset ?? 0) }
      cursors.set(path, cursor)
      return cursor
    } catch (err) {
      console.error(`audit ingester: 讀取 file_offsets 失敗（${path}）: ${err}`)
      return undefined
    }
  }

  async function ingestFile(pool: MonitorDbExecutor, service: string, path: string, stats: AuditIngestStats): Promise<void> {
    if (!existsSync(path)) return
    const cursor = await loadCursor(pool, path)
    if (cursor === undefined) {
      // 讀不回既有 offset 就**不能**從 0 重讀（會把整份歷史重送一次；雖然
      // INSERT IGNORE 去重，仍是不必要的大量寫入）——本輪跳過，下輪再試。
      stats.cursorLoadErrors++
      return
    }
    stats.filesScanned++

    const tailed = tailFile(path, cursor ?? undefined)
    if (tailed === null) return
    if (tailed.lines.length === 0) {
      // rotate 但新檔還沒有完整行：仍要把 (inode, offset=0) 寫回去，否則下一輪
      // 又拿舊 inode 的 offset 去讀新檔。
      if (tailed.rotated) await advanceOffset(pool, path, tailed.inode, tailed.newOffset, stats)
      return
    }

    let consumed = 0
    // 一旦 DB 寫入失敗就切換成 spool 模式：本檔本輪剩下的行不再逐行重試 DB
    // （DB 已經不可用，逐行重試只是把逾時預算乘上行數），直接落 spool。
    let spooling = false
    for (const line of tailed.lines) {
      const text = line.text.trim()
      if (!text) {
        consumed++
        continue
      }
      const parsed = parseAuditLine(text)
      if (!parsed) {
        // 壞行照樣消耗：它永遠不會變好，卡在這裡會讓整個檔案停止前進。
        stats.linesInvalid++
        consumed++
        continue
      }
      const input: InsertMcpUsageInput = {
        service,
        identity: parsed.identity,
        sourceIp: parsed.sourceIp,
        raw: text,
        ts: parsed.ts,
      }

      if (!spooling) {
        try {
          const outcome = await withMonitorDeadline('insertMcpUsage', () => insertMcpUsage(pool, input), deps.queryBudgetMs)
          if (outcome.kind === 'inserted') stats.linesInserted++
          consumed++
          continue
        } catch (err) {
          console.error(`audit ingester: mcp_usage 寫入失敗，改走 spool（${service} ${path}）: ${err}`)
          spooling = true
        }
      }

      if (!appendToSpool('insertMcpUsage', input)) {
        // DB 與 spool 兩層都不可用：offset 停在這一行之前，下輪從同一位置重讀。
        stats.filesAborted++
        break
      }
      stats.linesSpooled++
      consumed++
    }
    stats.linesRead += consumed

    if (consumed === 0) return
    const newOffset = consumed === tailed.lines.length ? tailed.newOffset : (tailed.lines[consumed] as { offset: number }).offset
    await advanceOffset(pool, path, tailed.inode, newOffset, stats)
  }

  /**
   * 落一條 spool 條目（`run_id: null`——這幾張表結構上沒有 run_id，per-fn 硬
   * 規則允許，見 spool/writer.ts）。回傳是否成功；沒有注入 spool 或 append
   * 失敗都回 false，由呼叫端退回「不推進 offset」。
   */
  function appendToSpool(fn: string, input: unknown): boolean {
    if (!deps.getSpool) return false
    try {
      deps.getSpool().append({ ts: new Date(now()).toISOString(), host, run_id: null, fn, args: [input] })
      return true
    } catch (err) {
      console.error(`audit ingester: 落 spool 失敗（fn=${fn}）: ${err}`)
      return false
    }
  }

  async function advanceOffset(
    pool: MonitorDbExecutor,
    path: string,
    inode: number,
    offset: number,
    stats: AuditIngestStats,
  ): Promise<void> {
    const input = { path, inode, offset, eventSeq: eventSeqToNumber(eventSeq.next()) }
    try {
      await withMonitorDeadline('upsertFileOffset', () => upsertFileOffset(pool, input), deps.queryBudgetMs)
    } catch (err) {
      console.error(`audit ingester: file_offsets 推進失敗（${path}）: ${err}`)
      stats.offsetWriteErrors++
      if (!appendToSpool('upsertFileOffset', input)) {
        // 沒有 spool 退路：記憶體游標也不推進，下一輪從同一位置重讀
        // （重複重讀由 INSERT IGNORE 去重，結構上只重複、不缺口）。
        return
      }
      // 已落 spool：DB 的游標由重放者補上，記憶體游標可以照常前進。
      stats.offsetsSpooled++
    }
    cursors.set(path, { inode, offset })
  }

  async function runOnce(): Promise<AuditIngestStats> {
    const stats = emptyStats()
    const pool = await deps.getExecutor()
    if (!pool) {
      stats.skippedNoExecutor = true
      return stats
    }
    for (const s of sources) {
      // 先補讀輪替檔 `.1`（若有、且還沒讀完），再讀主檔——沿用 sqlite collector
      // 的順序，避免 rotate 當下漏掉尚未讀到的尾段。
      for (const p of [`${s.path}.1`, s.path]) {
        await ingestFile(pool, s.service, p, stats)
      }
    }
    return stats
  }

  return {
    runOnce,
    getCursors: () => Object.fromEntries(cursors),
  }
}

/** 稽核 log 的更新頻率遠低於 pipeline log；比照 maintenance.ts 取同量級間隔。 */
export const AUDIT_INGEST_TICK_MS = 30_000

export interface AuditIngesterHandle {
  stop(): void
}

/**
 * 週期 tick（head only 掛載）。`isMonitorDbEnabled()=false` 時整段是 no-op
 * （連 setInterval 都不建、不碰 DB、不 lazy import mysql2）。
 */
export function startAuditIngester(deps: AuditIngesterDeps, tickMs = AUDIT_INGEST_TICK_MS): AuditIngesterHandle {
  if (!isMonitorDbEnabled()) return { stop() {} }
  const ingester = createAuditIngester(deps)
  // re-entrancy 閘門（對抗性審查 B1）：上一輪還沒結束就跳過本輪。兩輪並行會
  // 共用同一份記憶體游標（cursors / restored），把「只重複、不缺口」的不變式
  // 弄髒。這不是用等待解決正確性——是結構性互斥，單一 event loop 上的布林
  // 旗標讀寫之間沒有 await，不可能交錯。
  let running = false
  const timer = setInterval(() => {
    if (running) {
      console.error('audit ingester: 上一輪尚未結束，跳過本輪（re-entrancy 閘門）')
      return
    }
    running = true
    void ingester
      .runOnce()
      .catch(err => {
        console.error(`audit ingester: tick 失敗: ${err}`)
      })
      .finally(() => {
        running = false
      })
  }, tickMs)
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
