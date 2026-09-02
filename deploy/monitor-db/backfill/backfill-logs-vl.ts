#!/usr/bin/env bun
// backfill/backfill-logs-vl.ts — Phase 6 歷史回填：head 上既有 pipeline 逐字稿 +
// hosted MCP audit log → VictoriaLogs（best-effort，plan §7.2/§7.3/§7.4/§11.2）。
//
// 「先開發＋測試，後執行」：本腳本在指揮官宣告 Phase 6 時點之前只准以 --dry-run
// 執行（或測試以假 fetch 注入），絕不對正式 127.0.0.1:9428 發真 HTTP 寫入。
//
// 兩個來源：
//   1. telegram-dispatcher/logs/*.log（pipeline 逐字稿；跳過子目錄與 .json）
//   2. aladdin_mcps/{aladdin-admin,aladdin-platform,aladdin-toolsmith}/logs/audit*.jsonl
//
// host 欄一律 'head'（這些檔案事實上是 head 的物理檔案來源；注意這與
// backfill/lib/env.ts 的 BACKFILL_HOST='unknown_pre_migration' 不同——後者是
// DB 回填列的標記，這裡是 log 的 stream field，指揮官 2026-09-02 已在派工時
// 明確區分兩者，不可混用）。
//
// 遮罩：送出前逐行套用 lib/redaction.ts 的全部規則（§7.3 BLOCKER-4，Phase 7
// 落地正式 log shipper 前的先行版）。
//
// retention：VictoriaLogs 對超出 -retentionPeriod=90d 的條目會【無聲拒收】
// （§11.2），本腳本主動跳過並列入報告，不寄望 VL 自己擋。
//
// 冪等：best-effort，靠 --workdir 下的 manifest（{path, inode, size, sentLines}）
// 判斷「同一檔案（path+inode+size 全同）已完整送過」則整檔跳過。manifest 遺失
// 或檔案被置換 inode 時重跑會重複送——VL 端無去重，重複可接受、缺口不可接受
// （只有整檔全數送出成功才寫 manifest；中途失敗的檔案不寫，確保下次整檔重試）。

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { loadBackfillEnv } from './lib/env.ts'
import { parseBackfillArgs } from './lib/cli.ts'
import { makeReport, printReports, type SourceReport } from './lib/report.ts'
import { deriveRunId } from './lib/run-id.ts'
import { redactLine } from './lib/redaction.ts'

export const DEFAULT_LOGS_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
export const DEFAULT_MCPS_DIR = '/Users/user/aladdin/aladdin_mcps'
const MCPS_SUBDIRS = ['aladdin-admin', 'aladdin-platform', 'aladdin-toolsmith'] as const

/** log stream field 的 host 值（見檔頭說明，與 DB 回填的 BACKFILL_HOST 不同）。 */
export const LOG_BACKFILL_HOST = 'head'

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const MAX_LINE_BYTES = 2 * 1024 * 1024
export const MAX_BATCH_BYTES = 1024 * 1024
const TRUNCATE_SNIPPET_CHARS = 4096

// ── 檔名解析 ────────────────────────────────────────────────────────────────

const ISO_RAW_SRC = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z'
const DEMAND_LOG_RE = new RegExp(`^(.+)\\.(${ISO_RAW_SRC})\\.demand-pipeline\\.(?:stdout|stderr)\\.log$`)
const BUG_LOG_RE = new RegExp(`^(.+)\\.(${ISO_RAW_SRC})\\.(?:stdout|stderr)\\.log$`)

export interface ParsedLogFilename {
  ticket?: string
  kind?: 'bug' | 'demand'
  /** 檔名原樣的 ISO 字串（含 - 的形式，如 2026-09-01T07-05-02-406Z）——deriveRunId 用這個。 */
  isoRaw?: string
}

/**
 * 解析 pipeline log 檔名。只有 `<ticket>.<ISO>.(demand-pipeline.)?(stdout|stderr).log`
 * 這兩種形式能解出 ticket/kind/run_id；其餘 .log（bootstrap.log、demand-pipeline.log、
 * cleanup-worktree.log 等雜項）一律回傳空物件，_time 改用檔案 mtime（見 buildPipelineLogContext）。
 */
export function parseLogFilename(name: string): ParsedLogFilename {
  const demand = DEMAND_LOG_RE.exec(name)
  if (demand) return { ticket: demand[1], kind: 'demand', isoRaw: demand[2] }
  const bug = BUG_LOG_RE.exec(name)
  if (bug) return { ticket: bug[1], kind: 'bug', isoRaw: bug[2] }
  return {}
}

/** 2026-09-01T07-05-02-406Z → 2026-09-01T07:05:02.406Z（給 Date.parse / _time 用；run_id 仍用原字串）。 */
export function isoRawToIsoString(isoRaw: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(isoRaw)
  if (!m) throw new Error(`isoRaw 格式不符（預期 YYYY-MM-DDTHH-MM-SS-mmmZ）: ${isoRaw}`)
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
}

// ── VL entry 組裝 ───────────────────────────────────────────────────────────

export interface VlLogEntry {
  _time: string
  _msg: string
  host: string
  source: string
  ticket?: string
  kind?: string
  run_id?: string
}

export interface BuildEntryParams {
  timeMs: number
  rawLine: string
  source: string
  ticket?: string
  kind?: string
  runId?: string
  /** 該行在檔案內的位元組偏移（僅超大行的 truncated 物件會用到）。 */
  offset: number
}

/**
 * 組出送 VL 的一列 JSON 物件。行 ≤2MB：遮罩後整行照送。行 >2MB：不送原文，
 * 改送 {truncated:true, orig_bytes, head_4k, tail_4k, file, offset, host}
 * （head_4k/tail_4k 同樣先過遮罩，MN-C3；以字元數近似 4KB，多位元組字元邊界
 * 可能有些微誤差，這裡只是診斷用截斷，不追求精確位元組切點）。
 */
export function buildEntry(params: BuildEntryParams): VlLogEntry {
  const { timeMs, rawLine, source, ticket, kind, runId, offset } = params
  const rawBytes = Buffer.byteLength(rawLine, 'utf8')
  let msg: string
  if (rawBytes > MAX_LINE_BYTES) {
    const head = redactLine(rawLine.slice(0, TRUNCATE_SNIPPET_CHARS))
    const tail = redactLine(rawLine.slice(-TRUNCATE_SNIPPET_CHARS))
    msg = JSON.stringify({
      truncated: true,
      orig_bytes: rawBytes,
      head_4k: head,
      tail_4k: tail,
      file: source,
      offset,
      host: LOG_BACKFILL_HOST,
    })
  } else {
    msg = redactLine(rawLine)
  }
  const entry: VlLogEntry = { _time: new Date(timeMs).toISOString(), _msg: msg, host: LOG_BACKFILL_HOST, source }
  if (ticket) entry.ticket = ticket
  if (kind) entry.kind = kind
  if (runId) entry.run_id = runId
  return entry
}

// ── 批次切分 ────────────────────────────────────────────────────────────────

/** 把已序列化的 NDJSON 行切成 ≤maxBytes 的批次；單行本身超過 maxBytes 就自成一批。 */
export function batchLines(lines: string[], maxBytes: number = MAX_BATCH_BYTES): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let currentBytes = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (current.length > 0 && currentBytes + lineBytes > maxBytes) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(line)
    currentBytes += lineBytes
  }
  if (current.length > 0) batches.push(current)
  return batches
}

// ── HTTP 發送 ───────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch

export async function postBatch(
  fetchImpl: FetchFn,
  vlUrl: string,
  vlUser: string,
  vlPassword: string,
  ndjsonBody: string,
): Promise<Response> {
  const auth = Buffer.from(`${vlUser}:${vlPassword}`).toString('base64')
  return fetchImpl(`${vlUrl}/insert/jsonline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/stream+json',
      Authorization: `Basic ${auth}`,
    },
    body: ndjsonBody,
  })
}

// ── manifest（best-effort 冪等） ─────────────────────────────────────────────

export interface ManifestEntry {
  path: string
  inode: number
  size: number
  sentLines: number
}

export type Manifest = Record<string, ManifestEntry>

function manifestFilePath(workdir: string): string {
  return join(workdir, 'backfill-logs-vl.manifest.json')
}

export function loadManifest(workdir: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestFilePath(workdir), 'utf8')) as Manifest
  } catch {
    return {}
  }
}

export function saveManifest(workdir: string, manifest: Manifest): void {
  mkdirSync(workdir, { recursive: true })
  writeFileSync(manifestFilePath(workdir), JSON.stringify(manifest, null, 2))
}

// ── 來源檔案收集 ────────────────────────────────────────────────────────────

function listFiles(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 只收 logsDir 直屬的 *.log；跳過任何子目錄（active-pipelines/、agent-traces/ 等）與 .json。 */
export function collectPipelineLogFiles(logsDir: string): string[] {
  return listFiles(logsDir)
    .filter((e) => e.isFile() && e.name.endsWith('.log'))
    .map((e) => join(logsDir, e.name))
    .sort()
}

/** aladdin_mcps/{aladdin-admin,aladdin-platform,aladdin-toolsmith}/logs/audit*.jsonl。 */
export function collectAuditJsonlFiles(mcpsDir: string): string[] {
  const files: string[] = []
  for (const sub of MCPS_SUBDIRS) {
    const dir = join(mcpsDir, sub, 'logs')
    for (const e of listFiles(dir)) {
      if (e.isFile() && /^audit.*\.jsonl$/.test(e.name)) files.push(join(dir, e.name))
    }
  }
  return files.sort()
}

// ── 每檔案處理 ──────────────────────────────────────────────────────────────

interface FileContext {
  source: string
  ticket?: string
  kind?: string
  runId?: string
  /** 給定原始行文字與行序號，回傳這行的 _time（毫秒 epoch）。 */
  getLineTimeMs: (rawLine: string, idx: number) => number
}

/** ISO 檔名（<ticket>.<ISO>.(demand-pipeline.)?(stdout|stderr).log）：整檔所有行共用同一 _time。
 * 其餘 .log（bootstrap.log 等雜項）：ticket/kind/run_id 留空，_time 用檔案 mtime。 */
function buildPipelineLogContext(absPath: string): FileContext {
  const parsed = parseLogFilename(basename(absPath))
  if (parsed.isoRaw && parsed.ticket) {
    const ms = Date.parse(isoRawToIsoString(parsed.isoRaw))
    const runId = deriveRunId(`${parsed.ticket}.${parsed.isoRaw}`)
    return { source: absPath, ticket: parsed.ticket, kind: parsed.kind, runId, getLineTimeMs: () => ms }
  }
  const mtimeMs = statSync(absPath).mtimeMs
  return { source: absPath, getLineTimeMs: () => mtimeMs }
}

/** audit*.jsonl：每行 parse .ts 欄當 _time；parse 失敗（含整行非合法 JSON）→ 檔案 mtime。 */
function buildAuditJsonlContext(absPath: string): FileContext {
  const mtimeMs = statSync(absPath).mtimeMs
  return {
    source: absPath,
    getLineTimeMs: (rawLine: string) => {
      try {
        const obj = JSON.parse(rawLine) as { ts?: unknown }
        if (typeof obj.ts === 'string') {
          const ms = Date.parse(obj.ts)
          if (!Number.isNaN(ms)) return ms
        }
      } catch {
        // 非合法 JSON：落到下面的 mtime fallback。
      }
      return mtimeMs
    },
  }
}

function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

interface ProcessFileParams {
  dryRun: boolean
  now: number
  manifest: Manifest
  fetchImpl: FetchFn
  vlUrl: string
  vlUser: string
  vlPassword: string
}

async function processFile(ctx: FileContext, report: SourceReport, params: ProcessFileParams): Promise<void> {
  const { dryRun, now, manifest, fetchImpl, vlUrl, vlUser, vlPassword } = params
  const key = ctx.source

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(key)
  } catch (err) {
    report.notes.push(`${key}: stat 失敗（${(err as Error).message}），略過`)
    return
  }

  // dry-run 不查也不寫 manifest：attempted 恆代表「若真跑會嘗試寫入的量」（見 lib/report.ts docstring）。
  if (!dryRun) {
    const prev = manifest[key]
    if (prev && prev.inode === stat.ino && prev.size === stat.size) {
      report.sourceRows += prev.sentLines
      report.ignored += prev.sentLines
      report.notes.push(`${key}: manifest 命中（inode/size 未變），整檔略過（ignored=${prev.sentLines}）`)
      return
    }
  }

  let content: string
  try {
    content = readFileSync(key, 'utf8')
  } catch (err) {
    report.notes.push(`${key}: 讀檔失敗（${(err as Error).message}），略過`)
    return
  }

  const rawLines = splitLines(content)
  report.sourceRows += rawLines.length

  const eligible: VlLogEntry[] = []
  let offset = 0
  let retentionSkipped = 0
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!
    const lineBytes = Buffer.byteLength(rawLine, 'utf8')
    const timeMs = ctx.getLineTimeMs(rawLine, i)
    if (now - timeMs > RETENTION_MS) {
      retentionSkipped++
      offset += lineBytes + 1
      continue
    }
    eligible.push(
      buildEntry({ timeMs, rawLine, source: ctx.source, ticket: ctx.ticket, kind: ctx.kind, runId: ctx.runId, offset }),
    )
    offset += lineBytes + 1
  }

  if (retentionSkipped > 0) {
    report.skipped += retentionSkipped
    report.notes.push(`${key}: retention 跳過 ${retentionSkipped} 行（_time 早於 90 天，VL 會無聲拒收故主動跳過）`)
  }

  report.attempted += eligible.length

  if (dryRun) return

  if (eligible.length === 0) {
    manifest[key] = { path: key, inode: stat.ino, size: stat.size, sentLines: 0 }
    return
  }

  const serialized = eligible.map((e) => JSON.stringify(e))
  const batches = batchLines(serialized, MAX_BATCH_BYTES)

  let sent = 0
  let aborted = false
  for (const batch of batches) {
    const body = `${batch.join('\n')}\n`
    try {
      const res = await postBatch(fetchImpl, vlUrl, vlUser, vlPassword, body)
      if (!res.ok) {
        report.notes.push(`${key}: HTTP ${res.status} 中止，已送 ${sent}/${eligible.length} 行（best-effort，不重試）`)
        aborted = true
        break
      }
    } catch (err) {
      report.notes.push(`${key}: HTTP 例外中止（${(err as Error).message}），已送 ${sent}/${eligible.length} 行`)
      aborted = true
      break
    }
    sent += batch.length
  }

  report.inserted += sent
  if (aborted) {
    const remaining = eligible.length - sent
    report.skipped += remaining
    report.notes.push(`${key}: 因中止未送 ${remaining} 行，不寫 manifest（下次整檔重試——缺口不可接受、重複可接受）`)
  } else {
    manifest[key] = { path: key, inode: stat.ino, size: stat.size, sentLines: sent }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

export interface RunBackfillOptions {
  dryRun: boolean
  envFile?: string
  workdir?: string
  logsDir?: string
  mcpsDir?: string
  fetchImpl?: FetchFn
  /** 測試用：覆寫「現在」時刻（epoch ms），讓 retention 判斷可決定性測試。 */
  now?: number
}

export async function runBackfill(opts: RunBackfillOptions): Promise<SourceReport[]> {
  const dryRun = opts.dryRun
  const logsDir = opts.logsDir ?? DEFAULT_LOGS_DIR
  const mcpsDir = opts.mcpsDir ?? DEFAULT_MCPS_DIR
  const workdir = opts.workdir ?? join(tmpdir(), 'backfill-logs-vl')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? Date.now()

  loadBackfillEnv(opts.envFile)
  const vlUrl = process.env.MON_VL_URL || 'http://127.0.0.1:9428'
  const vlUser = process.env.MON_VL_USER ?? ''
  const vlPassword = process.env.MON_VL_PASSWORD ?? ''

  const manifest = dryRun ? {} : loadManifest(workdir)

  const pipelineReport = makeReport(`pipeline logs (${logsDir}) → VictoriaLogs`, dryRun)
  const auditReport = makeReport(`audit jsonl (${mcpsDir}/*/logs) → VictoriaLogs`, dryRun)

  const commonParams: ProcessFileParams = { dryRun, now, manifest, fetchImpl, vlUrl, vlUser, vlPassword }

  for (const f of collectPipelineLogFiles(logsDir)) {
    await processFile(buildPipelineLogContext(f), pipelineReport, commonParams)
  }
  for (const f of collectAuditJsonlFiles(mcpsDir)) {
    await processFile(buildAuditJsonlContext(f), auditReport, commonParams)
  }

  if (!dryRun) saveManifest(workdir, manifest)

  return [pipelineReport, auditReport]
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function extractFlag(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag)
  if (i === -1 || i === rest.length - 1) return undefined
  return rest[i + 1]
}

async function main(): Promise<void> {
  const args = parseBackfillArgs()
  const logsDir = extractFlag(args.rest, '--logs-dir') ?? DEFAULT_LOGS_DIR
  const mcpsDir = extractFlag(args.rest, '--mcps-dir') ?? DEFAULT_MCPS_DIR
  const workdir = extractFlag(args.rest, '--workdir')
  const reports = await runBackfill({ dryRun: args.dryRun, envFile: args.envFile, logsDir, mcpsDir, workdir })
  printReports(reports)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
