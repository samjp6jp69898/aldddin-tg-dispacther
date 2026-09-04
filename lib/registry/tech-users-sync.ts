// lib/registry/tech-users-sync.ts — Phase 5（MAJOR-F11）：tech_users 的
// tg_chat_id 欄 DB 權威寫入者，bun CLI 取代 aladdin_ai/scripts/tg-map-chatids.sh
// 的 awk 直改邏輯。bash 端呼叫本檔（另批派工，屬 aladdin_ai repo），本檔只管
// bun 側行為。
//
// 契約（依 plan v3 §5.10 + v3.2 MAJOR-F11 表，逐字實作）：
//   - MON_DB_ENABLED !== '1'（旗標關）：只改 CSV，行為鏡射
//     aladdin_ai/scripts/tg-map-chatids.sh 的 do_set（48-93 行）／
//     do_unset（96-120 行），不 import 任何 DB/crypto 模組（皆 lazy）。
//   - 旗標開：
//       notion_user_name / notion_user_id / pushed_repos：CSV → DB 每次覆寫。
//       email：鍵，不覆寫。
//       tg_chat_id：DB 該列不存在 → 由 CSV 初始化；列已存在 → 單向 DB → CSV
//         （CSV 側人工改動一律被 DB 覆寫回去）。
//   - --set/--unset：驗參數（chat_id 必須 ^-?\d+$）→ 寫 DB → 欄位級重生 CSV。
//     email 在 DB 與 CSV 都不存在 → 明確報錯，不自創列。
//   - 重生＝欄位級改寫：讀現行 CSV → 每列只把 tg_chat_id 換成 DB 值（DB 無
//     該列 → 保留檔案原值）→ backupOutsideRepo(csv,'tech-users') →
//     writeFileAtomic。永不新增列、永不刪列、永不改其他欄、header 原樣。
//     m6 防呆（寫 DB 與重生**兩個方向都要**，見 regenerateCsvContent 檔頭註解）：
//     任何即將寫入 CSV 的 DB 值含 `,`／`"`／`\r`／`\n` → 整個重生中止（throw），
//     不寫檔、不產生半套 CSV（不引入 RFC-4180 quoting，7 處讀者皆純逗號 split）。
//   - --reconcile：對整份 CSV 跑上述方向表 + 重生；DB 有列但 CSV 沒有的
//     孤兒列印 WARN 清單，不自動刪。
//   - --dry-run：印將發生的動作摘要，零 DB 讀寫、零 CSV 寫入（executor 零呼叫）。
//   - 空值一律 NULL（tg_chat_id_enc/_bidx/bidx_key_ver 三欄同進退）。
//   - chat_id 明文不得出現在任何 CLI 輸出（本專案對 tg_chat_id 全面視為需
//     加密的 PII，見 lib/crypto/field-crypto.ts／roster-decrypt.ts）。
//
// bidx scope — 必須與 deploy/monitor-db/backfill/backfill-rosters.ts:56 的
// TECH_USER_BIDX_SCOPE 逐字相同（HKDF info，改動會讓既有密文的等值查詢失效）。
// 本檔刻意不 import 該回填腳本（一次性工具，非本模組所有權），改為在此重新
// 宣告同一字串常數。

import { existsSync, readFileSync } from 'node:fs'
import { backupOutsideRepo, writeFileAtomic } from './fs-safe.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

export const DEFAULT_CSV_PATH = '/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv'

export const TECH_USER_BIDX_SCOPE = 'tech_users.tg_chat_id'
const BIDX_KEY_VER = 1
const CHAT_ID_RE = /^-?\d+$/

// ─────────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────────

export interface TechUserCsvRow {
  notion_user_name: string
  notion_user_id: string
  email: string
  pushed_repos: string
  tg_chat_id: string
}

export interface RunDeps {
  csvPath: string
  enabled: boolean
  dryRun: boolean
  /** enabled && !dryRun 時必須非 null；其餘情況可為 null（不會被呼叫）。 */
  executor: MonitorDbExecutor | null
}

// ─────────────────────────────────────────────────────────────────────────
// CSV 格式防呆（m6）＋嚴格解析——用於 --reconcile 與 DB 路徑的 CSV row 查找。
// 逐字對照 deploy/monitor-db/backfill/backfill-rosters.ts:91-118 的
// parseTechUsersCsv（同一格式契約，本檔獨立實作避免跨模組耦合到一次性回填
// 腳本）。任一資料列格式不合規 → throw，呼叫端視為整支中止，不做部分寫入。
// ─────────────────────────────────────────────────────────────────────────

export function parseTechUsersCsvStrict(content: string): TechUserCsvRow[] {
  const lines = content.split('\n').filter((l) => l.length > 0)
  const dataLines = lines.slice(1) // 跳過 header
  const rows: TechUserCsvRow[] = []
  for (const rawLine of dataLines) {
    if (rawLine.includes('"') || rawLine.includes('\r')) {
      throw new Error('tech-users.csv 格式防呆失敗：資料列含雙引號或 \\r，中止')
    }
    const parts = rawLine.split(',')
    if (parts.length !== 5) {
      throw new Error(
        `tech-users.csv 格式防呆失敗：欄位數為 ${parts.length}（預期 5，疑似某欄值含逗號），中止`,
      )
    }
    const [notion_user_name, notion_user_id, email, pushed_repos, tg_chat_id] = parts as [
      string,
      string,
      string,
      string,
      string,
    ]
    if (tg_chat_id !== '' && !CHAT_ID_RE.test(tg_chat_id)) {
      throw new Error(`tech-users.csv tg_chat_id 格式不合法（email=${email}），中止`)
    }
    rows.push({ notion_user_name, notion_user_id, email, pushed_repos, tg_chat_id })
  }
  return rows
}

function findCsvRowByEmail(content: string, email: string): TechUserCsvRow | null {
  const rows = parseTechUsersCsvStrict(content)
  return rows.find((r) => r.email === email) ?? null
}

// ─────────────────────────────────────────────────────────────────────────
// flag off（MON_DB_ENABLED !== '1'）：純 CSV 改寫，逐字鏡射
// aladdin_ai/scripts/tg-map-chatids.sh 的 do_set（48-93 行）／do_unset
// （96-120 行）語意：header-aware 欄位索引比對、NOOP/CONFLICT 判斷、awk
// 對命中列以 OFS=',' 重組整行、其餘列與 header 原樣輸出。
//
// 刻意差異（見 OWNED_FILES 回報 NOTES）：
//   1. 不含 bash 版 do_set 尾段的 TG_RESTART_CMD 重啟觸發（tg-map-chatids.sh:
//      86-92 行）——那是 launchctl 對 telegram-dispatcher 服務本身的操作性
//      副作用，不屬本次「DB 權威寫入者」轉移範圍，留在 bash 側處理。
//   2. CLI 輸出訊息不印 chat_id 明文（bash 原版的 echo 訊息含明文 chat_id，
//      本專案對 tg_chat_id 全面視為需加密的 PII，見檔頭）。
//   3. 改寫一律經 lib/registry/fs-safe.ts 的 backupOutsideRepo + writeFileAtomic
//      （bash 版只是 `mv "$tmp" "$CSV"`，無備份）——套用本專案名冊寫入的硬規則。
//   4. bash 版對 chat_id 格式完全不驗證（do_set/do_unset 皆無 regex 檢查）；
//      本路徑刻意原樣鏡射、同樣不驗證，格式防呆只在 flag on 的 DB 寫入路徑
//      與 --reconcile 生效（m6）。
// ─────────────────────────────────────────────────────────────────────────

/** tg-map-chatids.sh:56-58 header-aware 欄位索引（tr -d '\r' 後用逗號切分找 email/tg_chat_id）。 */
export function findEmailAndChatIdColumns(headerLine: string): { emailCol: number; chatCol: number } | null {
  const cols = headerLine.replace(/\r/g, '').split(',')
  const emailCol = cols.indexOf('email')
  const chatCol = cols.indexOf('tg_chat_id')
  if (emailCol === -1 || chatCol === -1) return null
  return { emailCol, chatCol }
}

export type CsvOnlySetStatus = 'ERR_ARGS' | 'ERR_NO_COL' | 'ERR_NO_EMAIL' | 'NOOP' | 'CONFLICT' | 'OK'
export interface CsvOnlySetResult {
  status: CsvOnlySetStatus
  /** 只有 status === 'OK' 時存在。 */
  content?: string
}

/** 純內容轉換（無 I/O），對照 tg-map-chatids.sh:48-78 do_set 的判斷與改寫邏輯。 */
export function applySetToContent(content: string, email: string, chatId: string, force: boolean): CsvOnlySetResult {
  // tg-map-chatids.sh:51
  if (email === '' || chatId === '') return { status: 'ERR_ARGS' }

  const lines = content.split('\n')
  const cols = findEmailAndChatIdColumns(lines[0] ?? '')
  // tg-map-chatids.sh:59
  if (!cols) return { status: 'ERR_NO_COL' }
  const { emailCol, chatCol } = cols

  // tg-map-chatids.sh:62-66：找現值；gsub(/[ \t\r]/,"",$cc) 全域移除空白/tab/CR。
  let cur: string | undefined
  let matchedIdx = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue
    const fields = line.split(',')
    if (fields[emailCol] === email) {
      cur = (fields[chatCol] ?? '').replace(/[ \t\r]/g, '')
      matchedIdx = i
      break
    }
  }
  // tg-map-chatids.sh:64-66（awk END{if(!f)exit 3}）
  if (matchedIdx === -1) return { status: 'ERR_NO_EMAIL' }

  // tg-map-chatids.sh:68-70
  if (cur === chatId) return { status: 'NOOP' }
  // tg-map-chatids.sh:71-73
  if (cur !== '' && !force) return { status: 'CONFLICT' }

  // tg-map-chatids.sh:75-78：awk 對命中列以 OFS=',' 重組整行，其餘列（含 header）原樣輸出。
  const fields = lines[matchedIdx]!.split(',')
  fields[chatCol] = chatId
  lines[matchedIdx] = fields.join(',')
  return { status: 'OK', content: lines.join('\n') }
}

export type CsvOnlyUnsetStatus = 'ERR_ARGS' | 'ERR_NO_COL' | 'ERR_NO_EMAIL' | 'NOOP' | 'OK'
export interface CsvOnlyUnsetResult {
  status: CsvOnlyUnsetStatus
  content?: string
}

/** 純內容轉換（無 I/O），對照 tg-map-chatids.sh:96-118 do_unset 的判斷與改寫邏輯。 */
export function applyUnsetToContent(content: string, email: string): CsvOnlyUnsetResult {
  // tg-map-chatids.sh:98
  if (email === '') return { status: 'ERR_ARGS' }

  const lines = content.split('\n')
  const cols = findEmailAndChatIdColumns(lines[0] ?? '')
  // tg-map-chatids.sh:104
  if (!cols) return { status: 'ERR_NO_COL' }
  const { emailCol, chatCol } = cols

  let cur: string | undefined
  let matchedIdx = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue
    const fields = line.split(',')
    if (fields[emailCol] === email) {
      cur = (fields[chatCol] ?? '').replace(/[ \t\r]/g, '')
      matchedIdx = i
      break
    }
  }
  // tg-map-chatids.sh:109-110
  if (matchedIdx === -1) return { status: 'ERR_NO_EMAIL' }
  // tg-map-chatids.sh:112-114
  if (cur === '') return { status: 'NOOP' }

  // tg-map-chatids.sh:116-118
  const fields = lines[matchedIdx]!.split(',')
  fields[chatCol] = ''
  lines[matchedIdx] = fields.join(',')
  return { status: 'OK', content: lines.join('\n') }
}

async function runSetCsvOnly(csvPath: string, email: string, chatId: string, force: boolean): Promise<string[]> {
  // tg-map-chatids.sh:52
  if (!existsSync(csvPath)) return [`SET_ERR_NO_CSV: ${csvPath}`]
  const content = readFileSync(csvPath, 'utf8')
  const result = applySetToContent(content, email, chatId, force)
  switch (result.status) {
    case 'ERR_ARGS':
      return ['SET_ERR_ARGS: need <email> <chat_id>']
    case 'ERR_NO_COL':
      return ['SET_ERR_NO_COL: email/tg_chat_id 欄缺失']
    case 'ERR_NO_EMAIL':
      return [`SET_ERR_NO_EMAIL: ${email}`]
    case 'NOOP':
      return [`SET_NOOP: ${email}（chat_id 未變）`]
    case 'CONFLICT':
      return [`SET_CONFLICT: ${email} 已有不同的 chat_id；需 --force`]
    case 'OK': {
      backupOutsideRepo(csvPath, 'tech-users')
      writeFileAtomic(csvPath, result.content!)
      return [`SET_OK: ${email}`]
    }
  }
}

async function runUnsetCsvOnly(csvPath: string, email: string): Promise<string[]> {
  // tg-map-chatids.sh:99
  if (!existsSync(csvPath)) return [`UNSET_ERR_NO_CSV: ${csvPath}`]
  const content = readFileSync(csvPath, 'utf8')
  const result = applyUnsetToContent(content, email)
  switch (result.status) {
    case 'ERR_ARGS':
      return ['UNSET_ERR_ARGS: need <email>']
    case 'ERR_NO_COL':
      return ['UNSET_ERR_NO_COL: email/tg_chat_id 欄缺失']
    case 'ERR_NO_EMAIL':
      return [`UNSET_ERR_NO_EMAIL: ${email}`]
    case 'NOOP':
      return [`UNSET_NOOP: ${email}（已經沒有 chat_id）`]
    case 'OK': {
      backupOutsideRepo(csvPath, 'tech-users')
      writeFileAtomic(csvPath, result.content!)
      return [`UNSET_OK: ${email}`]
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 欄位級重生（純字串轉換，無 I/O）——§5.10「重生＝欄位級改寫」。
// dbChatIds 沒有該 email 的鍵 → 保留該列原值（DB 無該列）；
// dbChatIds 有該 email 但值為 null → 該列 tg_chat_id 覆寫成空字串（DB 有列但欄位 NULL）。
// 永不新增/刪除列、永不動其他欄、header（lines[0]）原樣保留、未變動的列維持原始 byte
// （只在新值與現值不同時才重組該行，其餘行連 split/join 都不做）。
// ─────────────────────────────────────────────────────────────────────────

/**
 * m6 防呆（重生方向）：§5.10 原文要求「寫 DB 與重生時」都拒絕含 `,`、`"`、`\r`、`\n`
 * 的值。寫 DB 方向已由 `parseTechUsersCsvStrict`（CSV→DB）與 `runSetDbAuthoritative`
 * 的 `CHAT_ID_RE` 檢查涵蓋；本函式補上重生（DB→CSV）方向的另一半——寫入 CSV 前驗證
 * 每個即將寫入的 DB 值必須是空字串或符合 `^-?\d+$`（該 regex 本身已排除四種污染字元），
 * 不符即整個重生中止（throw），不寫檔、不產生半套 CSV，維持「永不新增列/欄」不變式。
 * **不引入 RFC-4180 quoting**（7 個跨 repo 讀者全是純逗號 split，裁定方向）。
 */
export function regenerateCsvContent(content: string, dbChatIds: Map<string, string | null>): string {
  const lines = content.split('\n')
  const cols = findEmailAndChatIdColumns(lines[0] ?? '')
  if (!cols) throw new Error('regenerateCsvContent: header 缺 email/tg_chat_id 欄')
  const { emailCol, chatCol } = cols
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue
    const fields = line.split(',')
    const email = fields[emailCol]
    if (email === undefined || !dbChatIds.has(email)) continue // DB 無該列 → 保留原值
    const newVal = dbChatIds.get(email) ?? ''
    if (newVal !== '' && !CHAT_ID_RE.test(newVal)) {
      throw new Error(
        `tech-users.csv 重生防呆失敗：email=${email} 的 DB 值格式不合法` +
          '（疑似含逗號/雙引號/CR/LF，或不符 ^-?\\d+$），整個重生中止，不寫檔',
      )
    }
    if (fields[chatCol] === newVal) continue // 值未變 → 不重組該行，保持 byte 不變
    fields[chatCol] = newVal
    lines[i] = fields.join(',')
  }
  return lines.join('\n')
}

async function regenerateCsvFile(csvPath: string, executor: MonitorDbExecutor): Promise<{ changedRows: number }> {
  const content = readFileSync(csvPath, 'utf8')
  const { decryptField } = await import('../crypto/roster-decrypt.ts')
  const [rows] = await executor.execute<Array<{ email: string; tg_chat_id_enc: string | null }>>(
    'SELECT email, tg_chat_id_enc FROM tech_users',
    [],
  )
  const map = new Map<string, string | null>()
  for (const r of rows as Array<{ email: string; tg_chat_id_enc: string | null }>) {
    if (r.tg_chat_id_enc === null) {
      map.set(r.email, null)
    } else {
      map.set(r.email, decryptField(`tech_users.tg_chat_id:${r.email}`, r.tg_chat_id_enc))
    }
  }
  const newContent = regenerateCsvContent(content, map)
  if (newContent === content) return { changedRows: 0 }

  const oldLines = content.split('\n')
  const newLines = newContent.split('\n')
  let changedRows = 0
  for (let i = 0; i < newLines.length; i++) if (oldLines[i] !== newLines[i]) changedRows++

  backupOutsideRepo(csvPath, 'tech-users')
  writeFileAtomic(csvPath, newContent)
  return { changedRows }
}

// ─────────────────────────────────────────────────────────────────────────
// flag on（MON_DB_ENABLED === '1'）：DB 權威路徑。
// ─────────────────────────────────────────────────────────────────────────

async function fetchTechUserExists(executor: MonitorDbExecutor, email: string): Promise<boolean> {
  const [rows] = await executor.execute<Array<{ email: string }>>('SELECT email FROM tech_users WHERE email = ?', [
    email,
  ])
  return Array.isArray(rows) && rows.length > 0
}

async function runSetDbAuthoritative(email: string, chatId: string, deps: RunDeps): Promise<string[]> {
  if (!CHAT_ID_RE.test(chatId)) return [`SET_ERR_BAD_CHATID: ${email}`]

  if (deps.dryRun) {
    return [
      `SET_DRYRUN: email=${email}（將加密寫入 tech_users.tg_chat_id 並欄位級重生 CSV；本次不讀取 DB、不寫入）`,
    ]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runSetDbAuthoritative: executor is required when MON_DB_ENABLED=1 且非 --dry-run')

  const { encryptField, blindIndex } = await import('../crypto/field-crypto.ts')
  const ctx = `tech_users.tg_chat_id:${email}`
  const enc = encryptField(ctx, chatId)
  const bidx = blindIndex(TECH_USER_BIDX_SCOPE, chatId)

  const exists = await fetchTechUserExists(executor, email)
  if (exists) {
    await executor.execute(
      'UPDATE tech_users SET tg_chat_id_enc = ?, tg_chat_id_bidx = ?, bidx_key_ver = ? WHERE email = ?',
      [enc, bidx, BIDX_KEY_VER, email],
    )
  } else {
    // §5.10：DB 該列不存在 → 由 CSV 初始化其餘欄位；CSV 也沒有此 email → 拒絕自創列。
    const csvContent = readFileSync(deps.csvPath, 'utf8')
    const csvRow = findCsvRowByEmail(csvContent, email)
    if (!csvRow) return [`SET_ERR_NO_EMAIL: ${email}（DB 與 CSV 皆無此 email，拒絕自創列）`]
    await executor.execute(
      'INSERT INTO tech_users (email, notion_user_name, notion_user_id, pushed_repos, tg_chat_id_enc, tg_chat_id_bidx, bidx_key_ver) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [email, csvRow.notion_user_name, csvRow.notion_user_id, csvRow.pushed_repos, enc, bidx, BIDX_KEY_VER],
    )
  }

  const regen = await regenerateCsvFile(deps.csvPath, executor)
  return [`SET_OK: ${email}`, `REGEN_OK: ${regen.changedRows} row(s) field-updated`]
}

async function runUnsetDbAuthoritative(email: string, deps: RunDeps): Promise<string[]> {
  if (deps.dryRun) {
    return [
      `UNSET_DRYRUN: email=${email}（將清空 tech_users.tg_chat_id_enc/_bidx/bidx_key_ver 並欄位級重生 CSV；本次不讀取 DB、不寫入）`,
    ]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runUnsetDbAuthoritative: executor is required when MON_DB_ENABLED=1 且非 --dry-run')

  const exists = await fetchTechUserExists(executor, email)
  if (!exists) {
    const csvContent = readFileSync(deps.csvPath, 'utf8')
    const csvRow = findCsvRowByEmail(csvContent, email)
    if (!csvRow) return [`UNSET_ERR_NO_EMAIL: ${email}（DB 與 CSV 皆無此 email）`]
    return [`UNSET_NOOP: ${email}（DB 尚無此列，視為已無 chat_id）`]
  }

  // §8：空值一律 NULL，enc/bidx/bidx_key_ver 三欄同進退（釋出 UNIQUE 位）。
  await executor.execute(
    'UPDATE tech_users SET tg_chat_id_enc = NULL, tg_chat_id_bidx = NULL, bidx_key_ver = NULL WHERE email = ?',
    [email],
  )
  const regen = await regenerateCsvFile(deps.csvPath, executor)
  return [`UNSET_OK: ${email}`, `REGEN_OK: ${regen.changedRows} row(s) field-updated`]
}

async function runReconcileDbAuthoritative(deps: RunDeps): Promise<string[]> {
  const content = readFileSync(deps.csvPath, 'utf8')
  const rows = parseTechUsersCsvStrict(content) // 格式錯誤 → throw，呼叫端視為整支中止

  if (deps.dryRun) {
    return [
      `RECONCILE_DRYRUN: ${rows.length} CSV row(s) 將 upsert 進 tech_users` +
        `（name/id/repos 每次覆寫；tg_chat_id 新列由 CSV 初始化、既有列單向 DB→CSV）；` +
        `本次不讀取 DB、不寫入`,
    ]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runReconcileDbAuthoritative: executor is required when MON_DB_ENABLED=1 且非 --dry-run')

  const { encryptField, blindIndex } = await import('../crypto/field-crypto.ts')
  const upsertSql =
    'INSERT INTO tech_users (email, notion_user_name, notion_user_id, pushed_repos, tg_chat_id_enc, tg_chat_id_bidx, bidx_key_ver) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE notion_user_name = VALUES(notion_user_name), notion_user_id = VALUES(notion_user_id), pushed_repos = VALUES(pushed_repos)'

  for (const row of rows) {
    if (row.tg_chat_id === '') {
      await executor.execute(upsertSql, [row.email, row.notion_user_name, row.notion_user_id, row.pushed_repos, null, null, null])
    } else {
      const ctx = `tech_users.tg_chat_id:${row.email}`
      const enc = encryptField(ctx, row.tg_chat_id)
      const bidx = blindIndex(TECH_USER_BIDX_SCOPE, row.tg_chat_id)
      await executor.execute(upsertSql, [
        row.email,
        row.notion_user_name,
        row.notion_user_id,
        row.pushed_repos,
        enc,
        bidx,
        BIDX_KEY_VER,
      ])
    }
  }

  const out: string[] = [`RECONCILE_OK: ${rows.length} CSV row(s) upserted`]

  // 孤兒列：DB 有 email 但 CSV 沒有此列 → WARN，不自動刪（doctor 職責的 CLI 版）。
  const [dbRows] = await executor.execute<Array<{ email: string }>>('SELECT email FROM tech_users', [])
  const csvEmails = new Set(rows.map((r) => r.email))
  for (const r of dbRows as Array<{ email: string }>) {
    if (!csvEmails.has(r.email)) {
      out.push(`RECONCILE_WARN_ORPHAN: ${r.email}`)
    }
  }

  const regen = await regenerateCsvFile(deps.csvPath, executor)
  out.push(`REGEN_OK: ${regen.changedRows} row(s) field-updated`)
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// 頂層 run*：依 deps.enabled 分派 flag off / flag on。
// ─────────────────────────────────────────────────────────────────────────

export async function runSet(email: string, chatId: string, force: boolean, deps: RunDeps): Promise<string[]> {
  if (!deps.enabled) return runSetCsvOnly(deps.csvPath, email, chatId, force)
  return runSetDbAuthoritative(email, chatId, deps)
}

export async function runUnset(email: string, deps: RunDeps): Promise<string[]> {
  if (!deps.enabled) return runUnsetCsvOnly(deps.csvPath, email)
  return runUnsetDbAuthoritative(email, deps)
}

export async function runReconcile(deps: RunDeps): Promise<string[]> {
  if (!deps.enabled) {
    return ['RECONCILE_SKIP: MON_DB_ENABLED !== \'1\'，--reconcile 需要 DB 權威資料，本次不執行']
  }
  return runReconcileDbAuthoritative(deps)
}

// ─────────────────────────────────────────────────────────────────────────
// CLI 參數解析 + 入口
// ─────────────────────────────────────────────────────────────────────────

export interface ParsedCliArgs {
  mode: 'set' | 'unset' | 'reconcile' | null
  email?: string
  chatId?: string
  csvPath: string
  dryRun: boolean
  force: boolean
  errors: string[]
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let mode: ParsedCliArgs['mode'] = null
  let email: string | undefined
  let chatId: string | undefined
  let csvPath = DEFAULT_CSV_PATH
  let dryRun = false
  let force = false
  const errors: string[] = []
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--set') {
      mode = 'set'
      email = argv[i + 1]
      chatId = argv[i + 2]
      i += 3
      continue
    }
    if (a === '--unset') {
      mode = 'unset'
      email = argv[i + 1]
      i += 2
      continue
    }
    if (a === '--reconcile') {
      mode = 'reconcile'
      i += 1
      continue
    }
    if (a === '--csv') {
      csvPath = argv[i + 1] ?? csvPath
      i += 2
      continue
    }
    if (a === '--dry-run') {
      dryRun = true
      i += 1
      continue
    }
    if (a === '--force') {
      force = true
      i += 1
      continue
    }
    errors.push(`未知參數: ${a}`)
    i += 1
  }
  return { mode, email, chatId, csvPath, dryRun, force, errors }
}

export async function runCli(argv: string[], opts: { enabled: boolean; executor: MonitorDbExecutor | null }): Promise<string[]> {
  const args = parseCliArgs(argv)
  if (args.errors.length > 0) return args.errors

  const deps: RunDeps = { csvPath: args.csvPath, enabled: opts.enabled, dryRun: args.dryRun, executor: opts.executor }

  switch (args.mode) {
    case 'set':
      if (!args.email || args.chatId === undefined || args.chatId === '') return ['SET_ERR_ARGS: need <email> <chat_id>']
      return runSet(args.email, args.chatId, args.force, deps)
    case 'unset':
      if (!args.email) return ['UNSET_ERR_ARGS: need <email>']
      return runUnset(args.email, deps)
    case 'reconcile':
      return runReconcile(deps)
    default:
      return ['usage: tech-users-sync.ts --set <email> <chat_id> [--force] | --unset <email> | --reconcile [--csv <path>] [--dry-run]']
  }
}

async function main(): Promise<void> {
  // env-load.ts 由另一 agent 平行建置中（介面：loadRegistryEnv(): void，把缺的
  // MON_* 從 .env 補進 process.env）；此處 lazy import 並容忍缺檔——不存在時
  // 靜默略過，後續 loadMonitorEnv / field-crypto 的 fail-loud 各自把缺漏抓出來。
  try {
    // 用變數而非字面字串當 specifier：env-load.ts 由另一 agent 平行建置中，
    // 檔案可能尚不存在，字面 import('./env-load.ts') 會讓 tsc 直接對不存在的
    // 模組報 TS2307（即使是動態 import）；繞成執行期才組出的路徑可避開靜態
    // 模組解析，讓「檔案缺失」單純變成執行期的 catch 分支。
    const envLoadSpecifier: string = './env-load.ts'
    const mod = (await import(envLoadSpecifier)) as { loadRegistryEnv?: () => void }
    mod.loadRegistryEnv?.()
  } catch {
    // 容忍缺檔
  }

  const { isMonitorDbEnabled } = await import('../monitor-db/env.ts')
  const enabled = isMonitorDbEnabled()
  const argv = process.argv.slice(2)
  const args = parseCliArgs(argv)

  let pool: import('mysql2/promise').Pool | null = null
  let executor: MonitorDbExecutor | null = null
  if (enabled && !args.dryRun && args.mode !== null) {
    const { createMonitorPool } = await import('../monitor-db/pool.ts')
    pool = createMonitorPool('mon_head', { connectionLimit: 1 })
    executor = pool
  }

  try {
    const lines = await runCli(argv, { enabled, executor })
    for (const line of lines) console.log(line)
  } catch (err) {
    console.error(`[tech-users-sync] 中止：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    if (pool) await pool.end()
  }
}

if (import.meta.main) {
  await main()
}
