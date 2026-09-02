// lib/monitor-db/collectors/agent-runs-collector.ts — Phase 4 collector：
// agent trace / bug pipeline stdout → `agent_runs`（head 與 worker 共用同一份）。
//
// 規格出處：
//   - plan-db-as-truth-v3.md §11.1（`agent_runs` PK=(run_id, path)、host 必填、
//     寫入者＝執行機 collector（head + worker））、§6.2.2（形狀 A：純 additive，
//     COALESCE 補空 + `finished_at` 一次寫定）、§6.7（非阻斷紀律）、
//     §9.0(B)（flag 關閉時完全不啟動、不 lazy import mysql2）、Phase 4。
//   - migration-003-proposal.md §4（**已被指揮官採納的裁定**）：
//     「collector 只在 trace 終態（`ended_at` 已知）才帶 payload 欄寫入，
//       未終態先寫 NULL（first-write-wins 補空）」。
//     理由：sqlite 端的 `upsertAgentRun` 是 last-write-wins（trace 檔長大就整列
//     重寫），MySQL 側的形狀 A 是 first-write-wins；若未終態就把「跑到一半的」
//     usage 數字寫進去，之後真正的終態值會被 COALESCE 擋掉、永遠補不上。
//     所以未終態一律只寫骨架（run_id / path / host / agent_name / started_at），
//     payload 十欄與 `finished_at` 全部留 NULL。
//
// 解析邏輯移植自 `tg-monitor/lib/ingest.ts` 的 `parseClaudeEvents` /
// `summarizeEvents` / `scanAgentTraces` / `ingestBugStdout`（**唯讀參考，未
// import**——兩個 repo 各自獨立、沒有 import 關係，比照 `filename-parse.ts`
// 對 backfill 腳本的既有處置）。sqlite collector 不在本工項的檔案所有權範圍內，
// 本檔不改它、也不依賴它；Phase 9 之前兩邊並行是計畫預期的「多寫一份」。
//
// 游標：**本機記憶體 mtime map**，不落任何權威表（003 提案明文：`file_mtime`
// 是 collector 私有的再解析游標，行程私有狀態不進權威表）。重啟後全量重掃是
// 冪等的——形狀 A 的 COALESCE 補空讓重複寫入不會改變任何已寫定的值。
//
// run_id 對位（兩條來源都**只用確定性對位，對不到就 skip + 計數，絕不猜**）：
//   - demand agent trace：檔內有 `runId` 欄（claude-exec.ts 寫入，見該檔）就直接用；
//     舊檔沒有 → 以 (host, ticket) 對回 `runs`，**恰好一列**才採用。
//   - bug pipeline stdout：以 (host, stdout_path) 對回 `runs`，**恰好一列**才採用。
//     刻意不重用 `lib/log-shipper/run-id-lookup.ts`（那支是 `ORDER BY created_at
//     DESC LIMIT 1`）：對 log shipping 而言 run_id 只是 best-effort 的 stream
//     field，對錯了只是標籤錯；對 `agent_runs` 而言 run_id 是 PK 的一半，對錯了
//     會把這次 agent 執行的統計掛到別的 run 上。兩者要求的強度不同。
//
// 寫入紀律：DB 寫入一律經注入的 `writeAgentRun`（production 接線層傳
// `dispatchMonitorWrite('upsertAgentRun', …)`：非阻斷、逾時/失敗落 spool、
// 不 throw 不阻斷）。對位用的 SELECT 失敗（DB 不可達）→ 本輪 skip 該檔、下輪
// 再試，**不落 spool、不猜**（spool 條目的 run_id 不得留給重放時求值，
// v3.2 §6.5(a)【G:MJ-G2】）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { MON_HOST, isMonitorDbEnabled } from '../env.ts'
import type { MonitorDbExecutor, UpsertAgentRunInput } from '../writes.ts'

/** claude-exec.ts 的 TRACE_DIR（同 repo 常數，維持單一字面量來源在該檔）。 */
export const DEFAULT_TRACE_DIR = '/Users/user/aladdin/telegram-dispatcher/logs/agent-traces'
export const DEFAULT_DISPATCHER_LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'

/** bug pipeline 的 stdout log 檔名（spawn-create-mr.ts 的 `${base}.stdout.log`）。 */
const BUG_STDOUT_RE = /^(.+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.stdout\.log$/

/** 排除 demand pipeline 的 stdout（它不是「單一 stage」的 bug pipeline 語意）。 */
const DEMAND_STDOUT_RE = /\.demand-pipeline\.stdout\.log$/

/** 異常肥大的檔案不值得拖垮 collector（沿用 sqlite collector 的 50MB 上限）。 */
export const MAX_PARSE_BYTES = 50 * 1024 * 1024

/** bug pipeline 的整份 stdout 視為單一 stage（沿用 sqlite collector 的命名）。 */
export const BUG_STAGE_NAME = 'create-mr'

/** result_preview 欄寬 512，沿用 sqlite collector 的 300 截斷（writes.ts 另有防禦性截斷）。 */
const RESULT_PREVIEW_CHARS = 300

export const RESOLVE_BY_TICKET_SQL = 'SELECT run_id FROM runs WHERE host = ? AND ticket = ? LIMIT 2'
export const RESOLVE_BY_STDOUT_PATH_SQL =
  'SELECT run_id, lifecycle_rank FROM runs WHERE host = ? AND stdout_path = ? LIMIT 2'

// ─────────────────────────────────────────────────────────────────────────
// 事件解析（移植自 tg-monitor/lib/ingest.ts，唯讀參考）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 雙格式事件解析：舊格式是 `--output-format json` 的單一 JSON 陣列（結束才
 * flush），新格式是 stream-json 的 JSONL（逐行即時落盤）。先試整檔 JSON，
 * 失敗改逐行——單行壞掉（讀到寫一半的尾行、timeout 砍斷）跳過該行即可。
 * 完全解析不出任何 event → null。
 */
export function parseClaudeEvents(txt: string): unknown[] | null {
  const t = txt.trim()
  if (!t) return null
  try {
    const j: unknown = JSON.parse(t)
    return Array.isArray(j) ? j : [j]
  } catch {
    // 落到逐行解析
  }
  const events: unknown[] = []
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 壞行跳過
    }
  }
  return events.length ? events : null
}

export interface AgentPayload {
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreateTokens: number | null
  costUsd: number | null
  numTurns: number | null
  toolCalls: number
  isError: boolean
  resultPreview: string | null
}

function emptyPayload(): AgentPayload {
  return {
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    costUsd: null,
    numTurns: null,
    toolCalls: 0,
    isError: false,
    resultPreview: null,
  }
}

type LooseRecord = Record<string, unknown>

function asRecord(v: unknown): LooseRecord | null {
  return typeof v === 'object' && v !== null ? (v as LooseRecord) : null
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 移植 tg-monitor 的 summarizeEvents（欄位語意逐項對齊 api-inventory 的 AgentSummary）。 */
export function summarizeEvents(events: unknown[] | null): AgentPayload {
  const out = emptyPayload()
  if (!Array.isArray(events)) return out
  for (const raw of events) {
    const e = asRecord(raw)
    if (!e) continue
    if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string') out.model = e.model
    if (e.type === 'assistant') {
      const msg = asRecord(e.message)
      const content = msg?.content
      if (Array.isArray(content)) {
        out.toolCalls += content.filter(c => asRecord(c)?.type === 'tool_use').length
      }
      if (typeof msg?.model === 'string') out.model = msg.model
    }
    if (e.type === 'result') {
      const u = asRecord(e.usage) ?? {}
      out.inputTokens = numOrNull(u.input_tokens)
      out.outputTokens = numOrNull(u.output_tokens)
      out.cacheReadTokens = numOrNull(u.cache_read_input_tokens)
      out.cacheCreateTokens = numOrNull(u.cache_creation_input_tokens)
      out.costUsd = numOrNull(e.total_cost_usd)
      out.numTurns = numOrNull(e.num_turns)
      out.isError = e.is_error === true
      if (typeof e.result === 'string') out.resultPreview = e.result.slice(0, RESULT_PREVIEW_CHARS)
      const modelUsage = asRecord(e.modelUsage)
      if (modelUsage) {
        const models = Object.keys(modelUsage)
        if (models.length) out.model = models.join(', ')
      }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// collector 本體
// ─────────────────────────────────────────────────────────────────────────

export interface AgentRunsCollectorStats {
  /** DB 不可達／pool 尚未建立：整輪跳過（不猜、不寫、不落 spool）。 */
  skippedNoExecutor: boolean
  tracesSeen: number
  tracesWritten: number
  /** 沒有 runId 欄、且 (host, ticket) 對不到唯一一列 → skip（孤兒處置，不猜）。 */
  tracesSkippedUnresolved: number
  /** JSON 壞掉／檔案過大／stat 失敗 → 本輪跳過，不推進游標，下輪再試。 */
  tracesSkippedUnreadable: number
  stdoutSeen: number
  stdoutWritten: number
  stdoutSkippedUnresolved: number
  stdoutSkippedUnreadable: number
  /** 對位用 SELECT 拋例外（DB 不可達）的次數——本輪 skip 對應檔案，下輪再試。 */
  lookupErrors: number
}

function emptyStats(): AgentRunsCollectorStats {
  return {
    skippedNoExecutor: false,
    tracesSeen: 0,
    tracesWritten: 0,
    tracesSkippedUnresolved: 0,
    tracesSkippedUnreadable: 0,
    stdoutSeen: 0,
    stdoutWritten: 0,
    stdoutSkippedUnresolved: 0,
    stdoutSkippedUnreadable: 0,
    lookupErrors: 0,
  }
}

export interface AgentRunsCollectorDeps {
  /**
   * 取得本行程的 monitor DB executor；`null` ＝ 本輪整輪跳過。
   * 接線層一律傳 runtime.ts 既有的取得路徑（head=mon_head、worker=mon_exec，
   * 由 `monitorRoleForThisHost()` 處理），**本模組絕不自行 createPool**。
   */
  getExecutor: () => Promise<MonitorDbExecutor | null>
  /**
   * 一次 `agent_runs` 寫入。production 接線層傳
   * `input => dispatchMonitorWrite('upsertAgentRun', input, pool => upsertAgentRun(pool, input))`
   * ——非阻斷、逾時/失敗落 spool、永不 throw。本模組不自己決定寫入通道。
   */
  writeAgentRun: (input: UpsertAgentRunInput) => Promise<void>
  traceDir?: string
  dispatcherLogDir?: string
  /** `runs.host` 守衛值；預設 MON_HOST（與 writes.ts 內部用的同一個值）。 */
  host?: string
}

export interface AgentRunsCollector {
  runOnce(): Promise<AgentRunsCollectorStats>
  /** 記憶體游標快照（唯讀，供測試/觀察）。 */
  getCursors(): Record<string, { mtimeMs: number; terminal: boolean }>
}

interface CursorEntry {
  mtimeMs: number
  /** 已寫過終態（payload 全帶）→ 之後怎麼重掃都不會再有新資訊，直接跳過。 */
  terminal: boolean
}

function toIsoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function selectRows(result: unknown): RowDataPacket[] {
  return Array.isArray(result) ? (result as RowDataPacket[]) : []
}

export function createAgentRunsCollector(deps: AgentRunsCollectorDeps): AgentRunsCollector {
  const traceDir = deps.traceDir ?? DEFAULT_TRACE_DIR
  const logDir = deps.dispatcherLogDir ?? DEFAULT_DISPATCHER_LOG_DIR
  const host = deps.host ?? MON_HOST
  const cursors = new Map<string, CursorEntry>()

  /**
   * 舊 trace 檔（沒有 runId 欄）的確定性對位：(host, ticket) 恰好對到一列才採用。
   * 回傳 `undefined` 代表查詢本身失敗（DB 不可達）——與「查到但不唯一」的
   * `null` 分開，讓呼叫端把兩者計進不同的計數器。
   */
  async function resolveByTicket(
    pool: MonitorDbExecutor,
    ticket: string,
    cache: Map<string, string | null>,
  ): Promise<string | null | undefined> {
    const cached = cache.get(ticket)
    if (cached !== undefined) return cached
    let rows: RowDataPacket[]
    try {
      const [result] = await pool.execute<RowDataPacket[]>(RESOLVE_BY_TICKET_SQL, [host, ticket])
      rows = selectRows(result)
    } catch (err) {
      console.error(`agent-runs collector: (host, ticket) 對位查詢失敗（ticket=${ticket}）: ${err}`)
      return undefined
    }
    // 恰好一列才算確定性對位；0 列（孤兒）與 ≥2 列（歧義）都不猜。
    const runId = rows.length === 1 ? String((rows[0] as unknown as { run_id: string }).run_id) : null
    cache.set(ticket, runId)
    return runId
  }

  /** bug stdout 的確定性對位：(host, stdout_path) 恰好一列，並一併取回終態判準。 */
  async function resolveByStdoutPath(
    pool: MonitorDbExecutor,
    stdoutPath: string,
  ): Promise<{ runId: string; terminal: boolean } | null | undefined> {
    let rows: RowDataPacket[]
    try {
      const [result] = await pool.execute<RowDataPacket[]>(RESOLVE_BY_STDOUT_PATH_SQL, [host, stdoutPath])
      rows = selectRows(result)
    } catch (err) {
      console.error(`agent-runs collector: (host, stdout_path) 對位查詢失敗（path=${stdoutPath}）: ${err}`)
      return undefined
    }
    if (rows.length !== 1) return null
    const row = rows[0] as unknown as { run_id: string; lifecycle_rank: number }
    // 終態判準用 `runs` 這一列自己的 lifecycle_rank（100=finished），不用 ps、
    // 也不用檔案 mtime 猜：stdout 寫完之後 wrapper 的 EXIT trap 還會跑一段，
    // 「檔案不再長大」不等於「這次 run 結束了」（sqlite collector 的
    // `<mtime>~live` guard 就是為了這個空窗才存在的）。
    return { runId: String(row.run_id), terminal: Number(row.lifecycle_rank) >= 100 }
  }

  async function collectTraces(pool: MonitorDbExecutor, stats: AgentRunsCollectorStats): Promise<void> {
    if (!existsSync(traceDir)) return
    let tickets: string[]
    try {
      tickets = readdirSync(traceDir)
    } catch (err) {
      console.error(`agent-runs collector: 讀取 trace 目錄失敗（${traceDir}）: ${err}`)
      return
    }
    const ticketCache = new Map<string, string | null>()

    for (const ticketDir of tickets) {
      const dir = join(traceDir, ticketDir)
      let files: string[]
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.json'))
      } catch {
        continue
      }

      for (const f of files) {
        const path = join(dir, f)
        const cursor = cursors.get(path)
        if (cursor?.terminal) continue

        let mtimeMs: number
        let mtimeIso: string
        let size: number
        try {
          const st = statSync(path)
          mtimeMs = st.mtimeMs
          mtimeIso = st.mtime.toISOString()
          size = st.size
        } catch {
          stats.tracesSkippedUnreadable++
          continue
        }
        stats.tracesSeen++
        if (cursor && cursor.mtimeMs === mtimeMs) continue
        if (size === 0 || size > MAX_PARSE_BYTES) {
          stats.tracesSkippedUnreadable++
          continue
        }

        let doc: LooseRecord | null
        try {
          doc = asRecord(JSON.parse(readFileSync(path, 'utf8')))
        } catch (err) {
          // 讀到寫一半的檔案是預期情況：不推進游標，下輪再試。
          console.error(`agent-runs collector: trace 解析失敗（${path}）: ${err}`)
          stats.tracesSkippedUnreadable++
          continue
        }
        if (!doc) {
          stats.tracesSkippedUnreadable++
          continue
        }

        const ticket = typeof doc.ticket === 'string' && doc.ticket ? doc.ticket : ticketDir
        let runId = typeof doc.runId === 'string' && doc.runId.trim() ? doc.runId.trim() : null
        if (!runId) {
          const resolved = await resolveByTicket(pool, ticket, ticketCache)
          if (resolved === undefined) {
            stats.lookupErrors++
            continue
          }
          if (resolved === null) {
            // 孤兒／歧義：不猜，計數後跳過（游標不推進，之後 runs 補齊了還有機會）。
            stats.tracesSkippedUnresolved++
            continue
          }
          runId = resolved
        }

        const stage =
          typeof doc.stage === 'string' && doc.stage
            ? doc.stage
            : f.replace(/^.*?Z-/, '').replace(/\.json$/, '')
        const startedAt = toIsoOrNull(doc.startedAt) ?? mtimeIso
        const endedAt = toIsoOrNull(doc.endedAt)
        const errorObj = asRecord(doc.error)
        // 終態＝`ended_at` 已知，或這次呼叫是以錯誤收場（error 欄存在＝
        // claude 已經結束，只是非 0 exit / timeout）。
        const terminal = endedAt !== null || errorObj !== null

        const base: UpsertAgentRunInput = { runId, path, agentName: stage, startedAt }
        if (!terminal) {
          // 未終態只寫骨架：payload 十欄與 finished_at 全部 NULL（003 §4 裁定）。
          await deps.writeAgentRun(base)
          cursors.set(path, { mtimeMs, terminal: false })
          stats.tracesWritten++
          continue
        }

        const events = Array.isArray(doc.events) ? doc.events : null
        const payload = summarizeEvents(events)
        if (errorObj) {
          payload.isError = true
          payload.resultPreview = String(errorObj.message ?? 'error').slice(0, RESULT_PREVIEW_CHARS)
        }
        await deps.writeAgentRun({ ...base, finishedAt: endedAt ?? mtimeIso, ...payload })
        cursors.set(path, { mtimeMs, terminal: true })
        stats.tracesWritten++
      }
    }
  }

  async function collectBugStdout(pool: MonitorDbExecutor, stats: AgentRunsCollectorStats): Promise<void> {
    if (!existsSync(logDir)) return
    let files: string[]
    try {
      files = readdirSync(logDir)
    } catch (err) {
      console.error(`agent-runs collector: 讀取 log 目錄失敗（${logDir}）: ${err}`)
      return
    }

    for (const f of files) {
      if (DEMAND_STDOUT_RE.test(f)) continue
      const m = BUG_STDOUT_RE.exec(f)
      if (!m) continue
      const path = join(logDir, f)
      const cursor = cursors.get(path)
      if (cursor?.terminal) continue

      let mtimeMs: number
      let mtimeIso: string
      let size: number
      try {
        const st = statSync(path)
        mtimeMs = st.mtimeMs
        mtimeIso = st.mtime.toISOString()
        size = st.size
      } catch {
        stats.stdoutSkippedUnreadable++
        continue
      }
      stats.stdoutSeen++
      if (size === 0 || size > MAX_PARSE_BYTES) {
        stats.stdoutSkippedUnreadable++
        continue
      }

      const resolved = await resolveByStdoutPath(pool, path)
      if (resolved === undefined) {
        stats.lookupErrors++
        continue
      }
      if (resolved === null) {
        stats.stdoutSkippedUnresolved++
        continue
      }

      // 未終態時，檔案沒長大就沒有新資訊（骨架已經寫過一次）——但終態判準來自
      // `runs` 而不是檔案，所以「mtime 沒變」不能當成整體跳過的條件，只能當成
      // 「這一輪不用重寫骨架」的條件。
      if (!resolved.terminal) {
        if (cursor && cursor.mtimeMs === mtimeMs) continue
        await deps.writeAgentRun({
          runId: resolved.runId,
          path,
          agentName: BUG_STAGE_NAME,
          startedAt: fileTsToIso(m[2] as string),
        })
        cursors.set(path, { mtimeMs, terminal: false })
        stats.stdoutWritten++
        continue
      }

      const events = parseClaudeEvents(readFileSync(path, 'utf8'))
      if (!events) {
        stats.stdoutSkippedUnreadable++
        continue
      }
      const payload = summarizeEvents(events)
      await deps.writeAgentRun({
        runId: resolved.runId,
        path,
        agentName: BUG_STAGE_NAME,
        startedAt: fileTsToIso(m[2] as string),
        finishedAt: mtimeIso,
        ...payload,
      })
      cursors.set(path, { mtimeMs, terminal: true })
      stats.stdoutWritten++
    }
  }

  async function runOnce(): Promise<AgentRunsCollectorStats> {
    const stats = emptyStats()
    const pool = await deps.getExecutor()
    if (!pool) {
      stats.skippedNoExecutor = true
      return stats
    }
    await collectTraces(pool, stats)
    await collectBugStdout(pool, stats)
    return stats
  }

  return {
    runOnce,
    getCursors: () => Object.fromEntries(cursors),
  }
}

/** `2026-08-21T01-23-16-901Z` → `2026-08-21T01:23:16.901Z`（檔名時戳還原成 ISO）。 */
export function fileTsToIso(t: string): string {
  return t.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
}

/** 比照 maintenance.ts 的既有慣例：同量級、足夠即時又不過度打 DB 的間隔。 */
export const AGENT_RUNS_COLLECT_TICK_MS = 30_000

export interface CollectorHandle {
  stop(): void
}

/**
 * 週期 tick。`isMonitorDbEnabled()=false` 時整段是 no-op（連 setInterval 都不建、
 * 不碰 DB、不 lazy import mysql2）——§9.0(B) 的可證偽驗收就靠這一行。
 */
export function startAgentRunsCollector(deps: AgentRunsCollectorDeps, tickMs = AGENT_RUNS_COLLECT_TICK_MS): CollectorHandle {
  if (!isMonitorDbEnabled()) return { stop() {} }
  const collector = createAgentRunsCollector(deps)
  const timer = setInterval(() => {
    void collector.runOnce().catch(err => {
      console.error(`agent-runs collector: tick 失敗: ${err}`)
    })
  }, tickMs)
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
