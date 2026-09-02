// backfill/backfill-rosters.ts — Phase 6 名冊回填（tech-users.csv / tokens*.json /
// unknown-senders.jsonl → tech_users / mcp_tokens / tg_unknown_senders）。
//
// 依 plan-db-as-truth-v3.md §4.1（加密 AAD/scope 契約）、§4.3（DB 權威 + 投影機制的
// 前提）、§5.9（mcp_tokens）、§5.10（tech_users 欄位級權威）、§11.2（回填總則：離線、
// 單執行緒、可重跑）——指揮官定案；本檔只「先開發+測試」，正式 pipeline_monitor
// schema 的實際寫入由指揮官日後另行觸發（--dry-run 之外一律不得對正式 schema 執行）。
//
// 三來源 mapping 摘要：
//   1) tech-users.csv → tech_users：純逗號切分（非 RFC-4180）；任一值含逗號／雙引號／
//      \r／\n，或 tg_chat_id 非空且不合 ^-?\d+$ → 整個腳本中止（exit 1，見
//      parseTechUsersCsv）。tg_chat_id 空 → *_enc/*_bidx/bidx_key_ver 皆 NULL。
//   2) tokens*.json → mcp_tokens：來源固定 9 條絕對路徑白名單（TOKENS_FILES，禁遞迴
//      glob）；檔案不存在 → skip + notes（非錯誤）。issued_at 原字串存入（MAJOR-D5，
//      不得經任何 Date 轉換）。
//   3) unknown-senders.jsonl → tg_unknown_senders：壞行（JSON.parse 失敗、缺
//      chat_id、ts 格式不合法）→ skip + notes；row-key 用 chat_id_bidx 的 hex
//      （§4.1 m-2：auto-increment 表用 bidx hex 當 AAD row-key）。
//
// 三表皆用 INSERT IGNORE（tech_users 靠 email PK；mcp_tokens 靠 (server,env,token_id)
// PK；tg_unknown_senders 靠 UNIQUE(chat_id_bidx, ts)）——bidx 是確定性 HMAC，重跑必
// IGNORE，雖然 enc 每次密文不同（隨機 IV），唯一鍵仍擋住重複列，冪等成立。

import { existsSync, readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import { blindIndex, encryptField } from '../../../lib/crypto/field-crypto.ts'
import { isoToMysqlDatetime3 } from '../../../lib/monitor-db/mysql-datetime.ts'
import { parseBackfillArgs } from './lib/cli.ts'
import { insertIgnoreRow, openBackfillPool } from './lib/db.ts'
import { loadBackfillEnv } from './lib/env.ts'
import { makeReport, printReports, type SourceReport } from './lib/report.ts'

// ---------- 常數 ----------

export const DEFAULT_CSV_PATH = '/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv'
export const DEFAULT_JSONL_PATH = '/Users/user/aladdin/telegram-dispatcher/logs/unknown-senders.jsonl'

/** tokens*.json 白名單（m-10：禁遞迴 glob，硬編這 9 條；CLI 不提供覆寫）。 */
export const TOKENS_FILES: readonly string[] = [
  '/Users/user/aladdin/aladdin_mcps/aladdin-admin/tokens.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-admin/tokens.pre.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-admin/tokens.evi.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-platform/tokens.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-platform/tokens.dev-6t.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-platform/tokens.pre-pk.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-platform/tokens.pre-6t.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-platform/tokens.evi-6t.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-toolsmith/tokens.json',
]

/**
 * blindIndex scope 常數 —— 2026-09-02 本次回填定案，寫死後 Phase 5 投影機制
 * 必須沿用相同字串；改動會讓既有密文列的等值查詢全部失效（scope 是 HKDF info，
 * 換字串等於換子金鑰）。
 */
export const TECH_USER_BIDX_SCOPE = 'tech_users.tg_chat_id'
export const MCP_TOKEN_BIDX_SCOPE = 'mcp_tokens.token'
export const UNKNOWN_SENDER_BIDX_SCOPE = 'tg_unknown_senders.chat_id'

const BIDX_KEY_VER = 1

// ---------- tech_users ----------

export interface TechUserCsvRow {
  notion_user_name: string
  notion_user_id: string
  email: string
  pushed_repos: string
  tg_chat_id: string
}

export interface TechUserDbRow {
  email: string
  notion_user_name: string
  notion_user_id: string
  pushed_repos: string
  tg_chat_id_enc: string | null
  tg_chat_id_bidx: Buffer | null
  bidx_key_ver: number | null
}

const TG_CHAT_ID_RE = /^-?\d+$/

/**
 * 純逗號切分（非 RFC-4180）。任一資料列格式不合規 → 直接 throw（呼叫端 main()
 * 視為整支腳本中止 exit 1，不做部分寫入）：
 *   - 值含雙引號或 \r
 *   - 切分後欄位數不是 5（疑似某欄值本身含逗號）
 *   - tg_chat_id 非空但不合 ^-?\d+$
 */
export function parseTechUsersCsv(content: string): TechUserCsvRow[] {
  const lines = content.split('\n').filter((l) => l.length > 0)
  const dataLines = lines.slice(1) // 跳過 header
  const rows: TechUserCsvRow[] = []
  for (const rawLine of dataLines) {
    if (rawLine.includes('"') || rawLine.includes('\r')) {
      throw new Error('tech-users.csv 格式防呆失敗：資料列含雙引號或 \\r，中止回填')
    }
    const parts = rawLine.split(',')
    if (parts.length !== 5) {
      throw new Error(
        `tech-users.csv 格式防呆失敗：欄位數為 ${parts.length}（預期 5，疑似某欄值含逗號），中止回填`,
      )
    }
    const [notion_user_name, notion_user_id, email, pushed_repos, tg_chat_id] = parts as [
      string,
      string,
      string,
      string,
      string,
    ]
    if (tg_chat_id !== '' && !TG_CHAT_ID_RE.test(tg_chat_id)) {
      throw new Error(`tech-users.csv tg_chat_id 格式不合法（email=${email}），中止回填`)
    }
    rows.push({ notion_user_name, notion_user_id, email, pushed_repos, tg_chat_id })
  }
  return rows
}

/** tg_chat_id 空 → *_enc/*_bidx/bidx_key_ver 皆 NULL；非空 → AAD row-key 為 email（§4.1 m-2）。 */
export function mapTechUserRow(row: TechUserCsvRow): TechUserDbRow {
  if (row.tg_chat_id === '') {
    return {
      email: row.email,
      notion_user_name: row.notion_user_name,
      notion_user_id: row.notion_user_id,
      pushed_repos: row.pushed_repos,
      tg_chat_id_enc: null,
      tg_chat_id_bidx: null,
      bidx_key_ver: null,
    }
  }
  const ctx = `tech_users.tg_chat_id:${row.email}`
  return {
    email: row.email,
    notion_user_name: row.notion_user_name,
    notion_user_id: row.notion_user_id,
    pushed_repos: row.pushed_repos,
    tg_chat_id_enc: encryptField(ctx, row.tg_chat_id),
    tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, row.tg_chat_id),
    bidx_key_ver: BIDX_KEY_VER,
  }
}

// ---------- mcp_tokens ----------

export interface TokenFileEntry {
  id: string
  token: string
  display_name?: string | null
  issued_at: string
}

export interface McpTokenDbRow {
  server: string
  env: string
  token_id: string
  token_enc: string
  token_bidx: Buffer
  issued_at: string
  display_name: string | null
}

/** server = 路徑目錄名；env：tokens.json→'default'，tokens.<env>.json→<env>。 */
export function deriveServerEnv(path: string): { server: string; env: string } {
  const parts = path.split('/')
  const filename = parts[parts.length - 1] ?? ''
  const server = parts[parts.length - 2] ?? ''
  const m = /^tokens\.(.+)\.json$/.exec(filename)
  const env = filename === 'tokens.json' ? 'default' : (m?.[1] ?? 'default')
  return { server, env }
}

/** 檔案不存在回傳 null（呼叫端當 skip 處理，非錯誤）。 */
export function readTokensFile(path: string): TokenFileEntry[] | null {
  if (!existsSync(path)) return null
  const content = readFileSync(path, 'utf8')
  const parsed = JSON.parse(content) as { tokens?: TokenFileEntry[] }
  return parsed.tokens ?? []
}

/** issued_at 原字串傳遞，不經任何 Date 轉換（MAJOR-D5，CHAR(24) byte-exact）。 */
export function mapTokenRow(server: string, env: string, entry: TokenFileEntry): McpTokenDbRow {
  const bidx = blindIndex(MCP_TOKEN_BIDX_SCOPE, entry.token)
  if (!bidx) {
    throw new Error(`mcp_tokens: token 值為空（id=${entry.id}），無法產生 blind index`)
  }
  return {
    server,
    env,
    token_id: entry.id,
    token_enc: encryptField(`mcp_tokens.token_enc:${entry.id}`, entry.token),
    token_bidx: bidx,
    issued_at: entry.issued_at,
    display_name: entry.display_name ?? null,
  }
}

// ---------- tg_unknown_senders ----------

export interface UnknownSenderRaw {
  chat_id?: string | number
  first_name?: string
  last_name?: string
  username?: string
  ts?: string
}

export interface UnknownSenderDbRow {
  chat_id_enc: string
  chat_id_bidx: Buffer
  sender_profile_enc: string | null
  ts: string
}

/** JSON.parse 失敗 → null（呼叫端當壞行 skip）。 */
export function parseJsonlLine(line: string): UnknownSenderRaw | null {
  try {
    return JSON.parse(line) as UnknownSenderRaw
  } catch {
    return null
  }
}

/**
 * 缺 chat_id 或 ts 格式不合法 → null（呼叫端當壞行 skip）。
 * row-key 用 chat_id_bidx 的 hex（§4.1 m-2：auto-increment 表用 bidx hex 當 AAD row-key），
 * 所以先算 bidx 再算兩個 enc 欄位。first_name/last_name/username 三者皆缺 → sender_profile_enc NULL。
 */
export function mapUnknownSenderRow(raw: UnknownSenderRaw): UnknownSenderDbRow | null {
  if (raw.chat_id === undefined || raw.chat_id === null || String(raw.chat_id) === '') return null
  if (typeof raw.ts !== 'string') return null
  let ts: string
  try {
    ts = isoToMysqlDatetime3(raw.ts)
  } catch {
    return null
  }
  const chatIdStr = String(raw.chat_id)
  const bidx = blindIndex(UNKNOWN_SENDER_BIDX_SCOPE, chatIdStr)
  if (!bidx) return null // chatIdStr 已確保非空字串，理論上不會發生
  const bidxHex = bidx.toString('hex')
  const hasProfile = raw.first_name !== undefined || raw.last_name !== undefined || raw.username !== undefined
  const sender_profile_enc = hasProfile
    ? encryptField(
        `tg_unknown_senders.sender_profile_enc:${bidxHex}`,
        JSON.stringify({ first_name: raw.first_name, last_name: raw.last_name, username: raw.username }),
      )
    : null
  return {
    chat_id_enc: encryptField(`tg_unknown_senders.chat_id_enc:${bidxHex}`, chatIdStr),
    chat_id_bidx: bidx,
    sender_profile_enc,
    ts,
  }
}

// ---------- executor 抽象（DB 寫入注入點；測試用假物件取代真實 pool） ----------

export interface RosterExecutor {
  insertTechUser(row: TechUserDbRow): Promise<boolean>
  insertMcpToken(row: McpTokenDbRow): Promise<boolean>
  insertUnknownSender(row: UnknownSenderDbRow): Promise<boolean>
}

export function makePoolExecutor(pool: Pool): RosterExecutor {
  return {
    insertTechUser: (row) =>
      insertIgnoreRow(
        pool,
        'tech_users',
        ['email', 'notion_user_name', 'notion_user_id', 'pushed_repos', 'tg_chat_id_enc', 'tg_chat_id_bidx', 'bidx_key_ver'],
        [row.email, row.notion_user_name, row.notion_user_id, row.pushed_repos, row.tg_chat_id_enc, row.tg_chat_id_bidx, row.bidx_key_ver],
      ),
    insertMcpToken: (row) =>
      insertIgnoreRow(
        pool,
        'mcp_tokens',
        ['server', 'env', 'token_id', 'token_enc', 'token_bidx', 'issued_at', 'display_name'],
        [row.server, row.env, row.token_id, row.token_enc, row.token_bidx, row.issued_at, row.display_name],
      ),
    insertUnknownSender: (row) =>
      insertIgnoreRow(
        pool,
        'tg_unknown_senders',
        ['chat_id_enc', 'chat_id_bidx', 'sender_profile_enc', 'ts'],
        [row.chat_id_enc, row.chat_id_bidx, row.sender_profile_enc, row.ts],
      ),
  }
}

// ---------- 主流程 ----------

export interface RunBackfillOptions {
  csvPath: string
  jsonlPath: string
  /** 預設 TOKENS_FILES；測試用 fixture 覆寫，避免 unit test 讀到真實 token 檔。CLI 不提供覆寫入口。 */
  tokensFiles?: readonly string[]
  dryRun: boolean
  /** dryRun=true 時不會被呼叫，可傳 null。 */
  executor: RosterExecutor | null
}

export async function runBackfill(opts: RunBackfillOptions): Promise<SourceReport[]> {
  const techReport = makeReport('tech-users.csv → tech_users', opts.dryRun)
  const tokensReport = makeReport('tokens*.json → mcp_tokens', opts.dryRun)
  const jsonlReport = makeReport('unknown-senders.jsonl → tg_unknown_senders', opts.dryRun)

  // --- tech_users ---
  const csvContent = readFileSync(opts.csvPath, 'utf8')
  const csvRows = parseTechUsersCsv(csvContent) // 格式錯誤時 throw，main() 視為整支中止
  techReport.sourceRows = csvRows.length
  techReport.attempted = csvRows.length
  for (const csvRow of csvRows) {
    const dbRow = mapTechUserRow(csvRow)
    if (opts.dryRun) continue
    const inserted = await opts.executor!.insertTechUser(dbRow)
    if (inserted) techReport.inserted++
    else techReport.ignored++
  }

  // --- mcp_tokens ---
  const tokensFiles = opts.tokensFiles ?? TOKENS_FILES
  let tokenAttempted = 0
  for (const filePath of tokensFiles) {
    const entries = readTokensFile(filePath)
    if (entries === null) {
      tokensReport.notes.push(`檔案不存在，skip：${filePath}`)
      continue
    }
    const { server, env } = deriveServerEnv(filePath)
    tokensReport.sourceRows += entries.length
    for (const entry of entries) {
      const dbRow = mapTokenRow(server, env, entry)
      tokenAttempted++
      if (opts.dryRun) continue
      const inserted = await opts.executor!.insertMcpToken(dbRow)
      if (inserted) tokensReport.inserted++
      else tokensReport.ignored++
    }
  }
  tokensReport.attempted = tokenAttempted
  tokensReport.notes.push(
    'env 命名（tokens.json→default／tokens.<env>.json→<env>）為本次回填自定，計畫未定義；Phase 5 投影定案若不同需 UPDATE。',
  )

  // --- tg_unknown_senders ---
  const jsonlContent = readFileSync(opts.jsonlPath, 'utf8')
  const jsonlLines = jsonlContent.split('\n').filter((l) => l.length > 0)
  jsonlReport.sourceRows = jsonlLines.length
  let jsonlAttempted = 0
  for (const line of jsonlLines) {
    const raw = parseJsonlLine(line)
    if (raw === null) {
      jsonlReport.skipped++
      jsonlReport.notes.push('壞行（JSON.parse 失敗），已 skip')
      continue
    }
    const dbRow = mapUnknownSenderRow(raw)
    if (dbRow === null) {
      jsonlReport.skipped++
      jsonlReport.notes.push('缺 chat_id 或 ts 格式不合法，已 skip')
      continue
    }
    jsonlAttempted++
    if (opts.dryRun) continue
    const inserted = await opts.executor!.insertUnknownSender(dbRow)
    if (inserted) jsonlReport.inserted++
    else jsonlReport.ignored++
  }
  jsonlReport.attempted = jsonlAttempted

  return [techReport, tokensReport, jsonlReport]
}

// ---------- CLI entry ----------

async function main(): Promise<void> {
  const args = parseBackfillArgs()
  loadBackfillEnv(args.envFile)

  let csvPath = DEFAULT_CSV_PATH
  let jsonlPath = DEFAULT_JSONL_PATH
  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--csv') csvPath = args.rest[++i] ?? csvPath
    else if (args.rest[i] === '--jsonl') jsonlPath = args.rest[++i] ?? jsonlPath
  }

  let pool: Pool | null = null
  let executor: RosterExecutor | null = null
  if (!args.dryRun) {
    pool = openBackfillPool()
    executor = makePoolExecutor(pool)
  }

  try {
    const reports = await runBackfill({ csvPath, jsonlPath, dryRun: args.dryRun, executor })
    printReports(reports)
  } catch (err) {
    console.error(`[backfill-rosters] 中止：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    if (pool) await pool.end()
  }
}

if (import.meta.main) {
  await main()
}
