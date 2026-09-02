// lib/registry/token-registry.ts — mcp_tokens 的「DB 權威 + 產物投影」核心（§5.9 / v3.2 MJ-E9）。
//
// 本檔是 BL-C4（鑄造攻擊）的關門模組。token 的核發／撤銷／改名一律「先 DB 後投影」，
// 投影出去的名冊檔必須通過**雙向差異白名單閘門**：攻擊者若直接往 `mcp_tokens` 塞一列，
// 那一列不會在下一次合法操作被順手投影進名冊檔，而是**擋住該次操作並告警**。
//
// 邊界（見 lib/crypto/roster-decrypt.ts 檔頭與 lib/crypto/import-boundary.test.ts）：
// 全 repo 只有 `lib/registry/*` 可以 import `roster-decrypt.ts`；本檔是它的第一個
// 合法 importer，也是唯一會把 DB 密文還原成明文 token 的地方。兩支 mcps CLI
// （make-starter-kit.ts / manage-tokens.ts）只組 intent、呼叫本檔，不碰 crypto。
//
// ── 七步流程（§5.9，順序不可換；任一步失敗即中止，舊檔永遠可用）──────────────
//   1. reconcile（檔案 → DB）：讀現行名冊，DB 沒有的 entry 加密後補進去。
//      方向刻意單向（F-MINOR-8 已明文）：檔案側新增無條件入庫，閘門防的是 DB 側鑄造。
//   2. 寫 DB（本次 issue/revoke/rename）：同步 await，失敗即中止回報，**不進 spool**
//      （人觸發的操作一律 fail-loud）。revoke 寫 revoked_at，不刪列。
//   3. 投影：SELECT 該 (server, env) 全部未撤銷列 → decryptField 還原明文
//      → ORDER BY issued_at, token_id 穩定排序（MN-C5）→ 組與現行檔完全同形的 JSON。
//   4. 雙向差異閘門（BL-C4 核心）：diff(現行檔, 投影結果) 逐項分類 added/removed/changed，
//      與 intent 的期望**恰好相等**才放行；任何未預期項（尤其未預期 added）→ 中止、
//      保留舊檔、alert。issue 有兩型期望（首次核發 = 恰一筆 added；rotate = 恰一筆
//      changed），依「現行檔是否已有該 id」在比對前決定，見 assertGate()。
//   5. 解密失敗（缺 `enc:v1:` 前綴／未知版本／GCM tag 不符）→ 整個操作中止，舊檔不動，alert。
//      （實作上由步驟 3 的 decryptField 直接丟例外達成，本檔不吞。）
//   6. 備份 + 原子寫：backupOutsideRepo(現行檔, 'mcp-tokens/<server>') → writeFileAtomic。
//   7. 投影後驗證：重讀檔案，比對 id 集合、display_name、issued_at 逐字元、token 全值
//      （不是長度）；不符 → 從備份還原 + alert。
//
// ── 加密契約（canonical，與 Phase 6 回填一致，不得偏離）──────────────────────
//   AAD ctx：`mcp_tokens.token_enc:<token_id>`；bidx scope：`mcp_tokens.token`；
//   issued_at 存原字串 byte-exact（CHAR(24)，不經任何 Date 轉換，MAJOR-D5）。
//
// ── 告警接線 ──────────────────────────────────────────────────────────────
//   `alert` 預設 `console.error`。**TG 告警接線屬 Phase 5 整合，由掛載端注入**
//   （本檔不 import notify/*，也不自己決定告警通道）。告警訊息只含 token_id 與
//   差異分類，**永遠不含 token 明文**。
//
// ── 明文紀律 ──────────────────────────────────────────────────────────────
//   token 明文只出現在：投影後寫進名冊檔的內容、以及 issueToken() 的回傳值
//   （CLI 要組 starter kit 給人）。不落任何 log、不進任何錯誤訊息。

import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { Pool } from 'mysql2/promise'
import { blindIndex as realBlindIndex, encryptField } from '../crypto/field-crypto.ts'
import { decryptField } from '../crypto/roster-decrypt.ts'
import { createMonitorPool } from '../monitor-db/pool.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'
import { backupOutsideRepo, writeFileAtomic } from './fs-safe.ts'
import { loadRegistryEnv } from './env-load.ts'

// ─────────────────────────────────────────────────────────────────────────
// 常數
// ─────────────────────────────────────────────────────────────────────────

/**
 * tokens*.json 白名單（m-10：**禁遞迴 glob**，硬編這 9 條絕對路徑）。
 *
 * 與 `deploy/monitor-db/backfill/backfill-rosters.ts` 的 `TOKENS_FILES` 逐字元相同，
 * 但**刻意不 import** 它——那是 deploy/ 下的一次性回填腳本，名冊寫入面不該在執行期
 * 依賴回填腳本的存在與否。兩份常數若日後分岔，以本檔為準（本檔是常駐寫入路徑）。
 */
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

/** bidx scope（backfill-rosters.ts:57 的 `MCP_TOKEN_BIDX_SCOPE`，換字串等於換子金鑰，不得改）。 */
export const MCP_TOKEN_BIDX_SCOPE = 'mcp_tokens.token'

/** AAD ctx 前綴（backfill-rosters.ts:192，row-key 為 token_id）。 */
export function tokenEncCtx(tokenId: string): string {
  return `mcp_tokens.token_enc:${tokenId}`
}

/** 備份分類目錄前綴（fs-safe.backupOutsideRepo 的 `type` 參數）。 */
const BACKUP_TYPE_PREFIX = 'mcp-tokens'

// ─────────────────────────────────────────────────────────────────────────
// SQL（常數化，測試的假 DB 以常數識別語句，不做字串猜測）
// ─────────────────────────────────────────────────────────────────────────

/** 步驟 1：檔案 → DB 的單向補列。PK (server, env, token_id) 撞到即 IGNORE。 */
export const RECONCILE_INSERT_SQL = `
INSERT IGNORE INTO mcp_tokens
  (server, env, token_id, token_enc, token_bidx, issued_at, display_name)
VALUES (?, ?, ?, ?, ?, ?, ?)
`.trim()

/**
 * 步驟 2（issue）：**upsert 語意**。
 *
 * toolsmith 的 `manage-tokens.ts --rotate` 與 make-starter-kit 的
 * `ensureToolsmithIssued` 都把重簽委派到 `issueToken()`（不另設 'rotate' op），
 * 所以 newId 已存在時要以新生成的 token 更新 token_enc / token_bidx / issued_at，
 * display_name 依 intent.displayName 更新。
 *
 * `revoked_at` **刻意不在 ODKU 的賦值清單裡**：DB 是權威，已撤銷的列不該被一次
 * 重簽默默復活。若真的撞上「檔案還有、DB 已撤銷」的列，投影會少一筆 → 閘門以
 * 未預期 removed 擋下並告警（那正是要被人看見的狀態，不是要被自動抹平的）。
 */
export const ISSUE_UPSERT_SQL = `
INSERT INTO mcp_tokens
  (server, env, token_id, token_enc, token_bidx, issued_at, display_name)
VALUES (?, ?, ?, ?, ?, ?, ?) AS new
ON DUPLICATE KEY UPDATE
  token_enc = new.token_enc,
  token_bidx = new.token_bidx,
  issued_at = new.issued_at,
  display_name = new.display_name
`.trim()

/**
 * 步驟 2（revoke）：寫 revoked_at，**不刪列**。
 * revoked_at 由 MySQL 的 NOW(3) 供給——這是純 DB 端稽核欄，不參與投影比對，
 * 不需要（也不應該）依賴呼叫端時鐘。
 */
export const REVOKE_UPDATE_SQL = `
UPDATE mcp_tokens
   SET revoked_at = NOW(3)
 WHERE server = ? AND env = ? AND token_id = ? AND revoked_at IS NULL
`.trim()

/** 步驟 2（rename）：只動 display_name，token 與 issued_at 完全不動。 */
export const RENAME_UPDATE_SQL = `
UPDATE mcp_tokens
   SET display_name = ?
 WHERE server = ? AND env = ? AND token_id = ? AND revoked_at IS NULL
`.trim()

/** 步驟 3：投影來源。ORDER BY (issued_at, token_id) 是全序（token_id 屬 PK），排序穩定（MN-C5）。 */
export const PROJECTION_SELECT_SQL = `
SELECT token_id, token_enc, issued_at, display_name
  FROM mcp_tokens
 WHERE server = ? AND env = ? AND revoked_at IS NULL
 ORDER BY issued_at, token_id
`.trim()

// ─────────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────────

export interface IssueIntent {
  op: 'issue'
  server: string
  env: string
  newId: string
  displayName: string
  registryPath?: string
}

export interface RevokeIntent {
  op: 'revoke'
  ids: string[]
  server?: string
  env?: string
  registryPath?: string
}

export interface RenameIntent {
  op: 'rename'
  id: string
  newName: string
  server?: string
  env?: string
  registryPath?: string
}

/** 純 reconcile（無 intent）：閘門期望「空差異」，用於對帳與恆等變換驗證。 */
export interface ReconcileIntent {
  op: 'reconcile'
  server?: string
  env?: string
  registryPath?: string
}

export type RegistryIntent = IssueIntent | RevokeIntent | RenameIntent | ReconcileIntent

/** 名冊檔內一筆條目（與 tokens*.json 完全同形，欄位順序即序列化順序）。 */
export interface RegistryEntry {
  id: string
  token: string
  display_name: string | null
  issued_at: string
}

export interface RegistryDiff {
  added: string[]
  removed: string[]
  changed: { id: string; fields: string[] }[]
}

/** 檔案層抽象（測試以記憶體實作取代，避免碰真實名冊與 ~/.aladdin-backups）。 */
export interface RegistryFileIo {
  exists(path: string): boolean
  read(path: string): string
  /** 回傳備份檔絕對路徑（供步驟 7 還原時讀回）。 */
  backup(srcPath: string, type: string): string
  writeAtomic(path: string, content: string): void
}

export interface RegistryDeps {
  /** 不注入時自行建立 mon_head pool，並在流程結束時關閉。 */
  executor?: MonitorDbExecutor
  encrypt?: (ctx: string, plaintext: string) => string
  decrypt?: (ctx: string, value: string) => string
  blindIndex?: (scope: string, plaintext: string) => Buffer | null
  /** 預設 console.error；TG 告警接線屬 Phase 5 整合，由掛載端注入。 */
  alert?: (message: string) => void
  now?: () => Date
  io?: RegistryFileIo
  /** token 生成器。預設值見 `generateToken()`。 */
  generateToken?: () => string
  /** **test-only**：覆寫 9 路白名單以指向 fixture。CLI 側沒有這個入口（只傳 intent）。 */
  registryFiles?: readonly string[]
}

export interface RegistryWriteResult {
  /** 本次實際寫出的名冊檔路徑；投影結果與現行檔 byte 完全相同時為空陣列。 */
  written: string[]
}

export interface IssueResult extends RegistryWriteResult {
  tokenId: string
  /** 明文 token。**只在回傳值出現**，不落任何 log。 */
  token: string
}

/** 雙向差異閘門擋下時丟出（BL-C4）。`diff` 只含 id 與欄位名，不含任何 token 值。 */
export class RegistryGateError extends Error {
  readonly diff: RegistryDiff
  constructor(message: string, diff: RegistryDiff) {
    super(message)
    this.name = 'RegistryGateError'
    this.diff = diff
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 預設實作
// ─────────────────────────────────────────────────────────────────────────

export const nodeFileIo: RegistryFileIo = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  backup: (p, type) => backupOutsideRepo(p, type),
  writeAtomic: (p, c) => writeFileAtomic(p, c),
}

/**
 * token 生成：32 bytes CSPRNG → base64url。
 *
 * 格式與熵照抄現行生成邏輯（唯讀參考）：
 * `/Users/user/aladdin/aladdin_mcps/aladdin-ai-assistant-kit/make-starter-kit.ts:242-244`
 *   `function generateToken(): string { return randomBytes(32).toString('base64url'); }`
 * （`aladdin-toolsmith/manage-tokens.ts` 亦同形。）不得降低長度或改編碼——
 * 既有名冊裡的 token 全部是這個形狀，換形狀等於讓新舊 token 可被形狀區分。
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

// ─────────────────────────────────────────────────────────────────────────
// 名冊檔 parse / serialize（與現行檔完全同形）
// ─────────────────────────────────────────────────────────────────────────

/** server = 路徑目錄名；env：tokens.json→'default'，tokens.<env>.json→'<env>'（canonical，已裁定）。 */
export function deriveServerEnv(path: string): { server: string; env: string } {
  const parts = path.split('/')
  const filename = parts[parts.length - 1] ?? ''
  const server = parts[parts.length - 2] ?? ''
  const m = /^tokens\.(.+)\.json$/.exec(filename)
  const env = filename === 'tokens.json' ? 'default' : (m?.[1] ?? 'default')
  return { server, env }
}

/**
 * 解析名冊檔。格式不對一律丟例外（不靜默當成空名冊——那會讓「檔案被清空」
 * 變成「全部 added」而不是被閘門擋下的異常）。
 */
export function parseRegistry(content: string, path: string): RegistryEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new Error(`[token-registry] 名冊檔不是合法 JSON：${path}（${(err as Error).message}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { tokens?: unknown }).tokens)) {
    throw new Error(`[token-registry] 名冊檔格式不對，缺少 tokens 陣列：${path}`)
  }
  const out: RegistryEntry[] = []
  for (const raw of (parsed as { tokens: unknown[] }).tokens) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`[token-registry] 名冊檔含非物件條目：${path}`)
    }
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.token !== 'string' || typeof e.issued_at !== 'string') {
      throw new Error(`[token-registry] 名冊條目缺 id/token/issued_at 或型別不對：${path}`)
    }
    if (e.display_name !== undefined && e.display_name !== null && typeof e.display_name !== 'string') {
      throw new Error(`[token-registry] 名冊條目 display_name 型別不對：${path}`)
    }
    out.push({
      id: e.id,
      token: e.token,
      display_name: (e.display_name as string | null | undefined) ?? null,
      issued_at: e.issued_at,
    })
  }
  return out
}

/**
 * 序列化成與現行檔完全同形的內容：`JSON.stringify(x, null, 2)` + 結尾換行
 * （現行 9 份名冊實測結尾皆為 `\n`；make-starter-kit.ts:229 的
 * `writeRegistryFileAtomic` 也是 `+ '\n'`）。欄位順序 id → token → display_name → issued_at。
 */
export function serializeRegistry(entries: RegistryEntry[]): string {
  const tokens = entries.map((e) => ({
    id: e.id,
    token: e.token,
    display_name: e.display_name,
    issued_at: e.issued_at,
  }))
  return JSON.stringify({ tokens }, null, 2) + '\n'
}

// ─────────────────────────────────────────────────────────────────────────
// 雙向差異閘門（BL-C4 核心）
// ─────────────────────────────────────────────────────────────────────────

const COMPARED_FIELDS = ['token', 'display_name', 'issued_at'] as const

/**
 * 逐項分類 added / removed / changed。以 id 為鍵，**對順序不敏感**——
 * 首次投影會把名冊重排成 (issued_at, token_id) 全序，那不是內容變更，不該擋。
 */
export function diffEntries(before: RegistryEntry[], after: RegistryEntry[]): RegistryDiff {
  const beforeById = new Map(before.map((e) => [e.id, e]))
  const afterById = new Map(after.map((e) => [e.id, e]))
  const added: string[] = []
  const removed: string[] = []
  const changed: { id: string; fields: string[] }[] = []

  for (const [id, a] of afterById) {
    const b = beforeById.get(id)
    if (!b) {
      added.push(id)
      continue
    }
    const fields = COMPARED_FIELDS.filter((f) => b[f] !== a[f])
    if (fields.length > 0) changed.push({ id, fields: [...fields] })
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed.push(id)
  }
  added.sort()
  removed.sort()
  changed.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  return { added, removed, changed }
}

/** issue 可變動的欄位（rotate 型）。 */
const ROTATE_ALLOWED_FIELDS = new Set(['token', 'issued_at', 'display_name'])

/** intent 對應的「唯一允許的差異形狀」。 */
function expectedDiffDescription(intent: RegistryIntent, isRotate: boolean): string {
  switch (intent.op) {
    case 'issue':
      return isRotate
        ? `恰一筆 changed 且 id='${intent.newId}'，變動欄位 ⊆ {token, issued_at, display_name}，無 added、無 removed`
        : `恰一筆 added 且 id='${intent.newId}'，無 removed、無 changed`
    case 'revoke':
      return `removed 恰等於 {${[...new Set(intent.ids)].sort().join(', ')}}，無 added、無 changed`
    case 'rename':
      return `恰一筆 changed（id='${intent.id}'，且只有 display_name 不同），無 added、無 removed`
    case 'reconcile':
      return '空差異（無 added / removed / changed）'
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/**
 * 閘門：差異必須與 intent 期望**恰好相等**才放行。
 * 任何未預期項（尤其未預期的 added ＝ DB 側鑄造）→ 丟 RegistryGateError。
 *
 * `current` 是**比對前**的現行檔內容——issue 的兩型判定（首次核發 vs rotate）
 * 完全由「現行檔是否已有該 id」決定，不看 diff 本身，也不吃呼叫端的旗標。
 */
export function assertGate(diff: RegistryDiff, intent: RegistryIntent, current: RegistryEntry[]): void {
  const isRotate = intent.op === 'issue' && current.some((e) => e.id === intent.newId)
  let ok: boolean
  switch (intent.op) {
    case 'issue':
      ok = isRotate
        ? diff.added.length === 0 &&
          diff.removed.length === 0 &&
          diff.changed.length === 1 &&
          diff.changed[0].id === intent.newId &&
          diff.changed[0].fields.every((f) => ROTATE_ALLOWED_FIELDS.has(f))
        : diff.added.length === 1 &&
          diff.added[0] === intent.newId &&
          diff.removed.length === 0 &&
          diff.changed.length === 0
      break
    case 'revoke': {
      const want = [...new Set(intent.ids)].sort()
      ok = diff.added.length === 0 && diff.changed.length === 0 && sameStringSet(diff.removed, want)
      break
    }
    case 'rename':
      ok =
        diff.added.length === 0 &&
        diff.removed.length === 0 &&
        diff.changed.length === 1 &&
        diff.changed[0].id === intent.id &&
        diff.changed[0].fields.length === 1 &&
        diff.changed[0].fields[0] === 'display_name'
      break
    case 'reconcile':
      ok = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
      break
  }
  if (ok) return
  throw new RegistryGateError(
    `[token-registry] 雙向差異閘門擋下 op='${intent.op}'：` +
      `期望 ${expectedDiffDescription(intent, isRotate)}；` +
      `實得 added=[${diff.added.join(', ')}] removed=[${diff.removed.join(', ')}] ` +
      `changed=[${diff.changed.map((c) => `${c.id}(${c.fields.join('/')})`).join(', ')}]。` +
      '舊檔已保留、未寫出任何內容。',
    diff,
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 目標名冊定位（白名單驗證）
// ─────────────────────────────────────────────────────────────────────────

interface RegistryTarget {
  server: string
  env: string
  path: string
}

function assertWhitelisted(path: string, files: readonly string[]): string {
  const abs = resolvePath(path)
  const hit = files.find((f) => resolvePath(f) === abs)
  if (!hit) {
    throw new Error(
      `[token-registry] registryPath 不在 9 路白名單內，拒絕操作：${path}` +
        '（m-10：白名單為硬編絕對路徑，不做遞迴 glob、不接受任意路徑）',
    )
  }
  return hit
}

/**
 * 定位本次操作的名冊。
 *   - 有 registryPath → 必須通過白名單；同時帶 server/env 時必須與路徑推導結果一致。
 *   - 只有 server/env → 從白名單反查。
 *   - 兩者皆無（revoke/rename）→ 以 ids 掃白名單解析；命中 0 份或 >1 份一律中止，
 *     要求呼叫端明示（不猜）。
 */
function resolveTarget(
  intent: RegistryIntent,
  files: readonly string[],
  io: RegistryFileIo,
): RegistryTarget {
  const server: string | undefined = intent.server
  const env: string | undefined = intent.env

  if (intent.registryPath) {
    const path = assertWhitelisted(intent.registryPath, files)
    const derived = deriveServerEnv(path)
    if ((server && server !== derived.server) || (env && env !== derived.env)) {
      throw new Error(
        `[token-registry] intent 的 server/env 與 registryPath 推導結果不一致：` +
          `intent=(${server}, ${env})，路徑推導=(${derived.server}, ${derived.env})，路徑=${path}`,
      )
    }
    return { ...derived, path }
  }

  if (server && env) {
    const matches = files.filter((f) => {
      const d = deriveServerEnv(f)
      return d.server === server && d.env === env
    })
    if (matches.length !== 1) {
      throw new Error(
        `[token-registry] 白名單內找不到唯一對應 (server='${server}', env='${env}') 的名冊（命中 ${matches.length} 份）`,
      )
    }
    return { server, env, path: matches[0] }
  }

  // 以 ids 掃白名單解析（僅 revoke / rename 會走到）。
  const ids =
    intent.op === 'revoke' ? [...new Set(intent.ids)] : intent.op === 'rename' ? [intent.id] : []
  if (ids.length === 0) {
    throw new Error('[token-registry] 無法定位名冊：intent 未帶 registryPath 也未帶 server/env')
  }
  const hits: string[] = []
  for (const f of files) {
    if (!io.exists(f)) continue
    const entries = parseRegistry(io.read(f), f)
    if (entries.some((e) => ids.includes(e.id))) hits.push(f)
  }
  if (hits.length === 0) {
    throw new Error(`[token-registry] id(${ids.join(', ')}) 不存在於任何名冊，本次不做任何修改`)
  }
  if (hits.length > 1) {
    throw new Error(
      `[token-registry] id(${ids.join(', ')}) 出現在多份名冊（${hits.join(', ')}），` +
        '中止：請以 server/env 或 registryPath 明示要操作哪一份（不猜）',
    )
  }
  return { ...deriveServerEnv(hits[0]), path: hits[0] }
}

// ─────────────────────────────────────────────────────────────────────────
// 七步流程
// ─────────────────────────────────────────────────────────────────────────

interface ResolvedDeps {
  executor: MonitorDbExecutor
  encrypt: (ctx: string, plaintext: string) => string
  decrypt: (ctx: string, value: string) => string
  blindIndex: (scope: string, plaintext: string) => Buffer | null
  alert: (message: string) => void
  now: () => Date
  io: RegistryFileIo
  generateToken: () => string
  files: readonly string[]
}

interface McpTokenRow {
  token_id: string
  token_enc: string
  issued_at: string
  display_name: string | null
}

function encRow(
  d: ResolvedDeps,
  target: RegistryTarget,
  entry: RegistryEntry,
): unknown[] {
  const bidx = d.blindIndex(MCP_TOKEN_BIDX_SCOPE, entry.token)
  if (!bidx) {
    throw new Error(`[token-registry] token 值為空（id=${entry.id}），無法產生 blind index`)
  }
  return [
    target.server,
    target.env,
    entry.id,
    d.encrypt(tokenEncCtx(entry.id), entry.token),
    bidx,
    entry.issued_at, // 原字串 byte-exact，不經 Date（MAJOR-D5）
    entry.display_name,
  ]
}

/** 步驟 1：reconcile（檔案 → DB，單向；F-MINOR-8）。 */
async function reconcileFileIntoDb(
  d: ResolvedDeps,
  target: RegistryTarget,
  current: RegistryEntry[],
): Promise<void> {
  for (const entry of current) {
    await d.executor.execute(RECONCILE_INSERT_SQL, encRow(d, target, entry))
  }
}

/** 步驟 2：本次 intent 的 DB 寫入。回傳 issue 產生的明文 token（其他 op 為 null）。 */
async function applyIntentToDb(
  d: ResolvedDeps,
  target: RegistryTarget,
  intent: RegistryIntent,
): Promise<{ token: string; issuedAt: string } | null> {
  switch (intent.op) {
    case 'issue': {
      const token = d.generateToken()
      const issuedAt = d.now().toISOString()
      const entry: RegistryEntry = {
        id: intent.newId,
        token,
        display_name: intent.displayName,
        issued_at: issuedAt,
      }
      await d.executor.execute(ISSUE_UPSERT_SQL, encRow(d, target, entry))
      return { token, issuedAt }
    }
    case 'revoke': {
      for (const id of [...new Set(intent.ids)]) {
        await d.executor.execute(REVOKE_UPDATE_SQL, [target.server, target.env, id])
      }
      return null
    }
    case 'rename': {
      await d.executor.execute(RENAME_UPDATE_SQL, [intent.newName, target.server, target.env, intent.id])
      return null
    }
    case 'reconcile':
      return null
  }
}

/** 步驟 3：投影（SELECT → 解密 → 組同形結構）。解密失敗一律往外丟（步驟 5）。 */
async function projectFromDb(d: ResolvedDeps, target: RegistryTarget): Promise<RegistryEntry[]> {
  const [rows] = await d.executor.execute<McpTokenRow[]>(PROJECTION_SELECT_SQL, [target.server, target.env])
  return rows.map((r) => ({
    id: r.token_id,
    token: d.decrypt(tokenEncCtx(r.token_id), r.token_enc),
    display_name: r.display_name ?? null,
    issued_at: r.issued_at,
  }))
}

/**
 * 步驟 7：投影後驗證。比對 id 集合、display_name、issued_at 逐字元、token 全值
 * （不是長度）。不符即丟例外，由呼叫端從備份還原。
 */
function assertProjectionPersisted(actual: RegistryEntry[], expected: RegistryEntry[]): void {
  const actualById = new Map(actual.map((e) => [e.id, e]))
  const expectedIds = expected.map((e) => e.id).sort()
  const actualIds = actual.map((e) => e.id).sort()
  if (!sameStringSet(actualIds, expectedIds)) {
    throw new Error(
      `[token-registry] 投影後驗證失敗：id 集合不符（期望 [${expectedIds.join(', ')}]，實得 [${actualIds.join(', ')}]）`,
    )
  }
  for (const want of expected) {
    const got = actualById.get(want.id)!
    if (got.token !== want.token) {
      // 只報 id，不報任何 token 值（明文紀律）。
      throw new Error(`[token-registry] 投影後驗證失敗：id='${want.id}' 的 token 全值不符`)
    }
    if (got.issued_at !== want.issued_at) {
      throw new Error(
        `[token-registry] 投影後驗證失敗：id='${want.id}' 的 issued_at 不符（期望 '${want.issued_at}'，實得 '${got.issued_at}'）`,
      )
    }
    if (got.display_name !== want.display_name) {
      throw new Error(
        `[token-registry] 投影後驗證失敗：id='${want.id}' 的 display_name 不符` +
          `（期望 ${JSON.stringify(want.display_name)}，實得 ${JSON.stringify(got.display_name)}）`,
      )
    }
  }
}

function resolveDeps(deps: RegistryDeps, executor: MonitorDbExecutor): ResolvedDeps {
  return {
    executor,
    encrypt: deps.encrypt ?? encryptField,
    decrypt: deps.decrypt ?? decryptField,
    blindIndex: deps.blindIndex ?? realBlindIndex,
    // TG 告警接線屬 Phase 5 整合，由掛載端注入；本檔預設只印到 stderr。
    alert: deps.alert ?? ((m) => console.error(m)),
    now: deps.now ?? (() => new Date()),
    io: deps.io ?? nodeFileIo,
    generateToken: deps.generateToken ?? generateToken,
    files: deps.registryFiles ?? TOKENS_FILES,
  }
}

interface RunOutcome extends RegistryWriteResult {
  issued: { token: string; issuedAt: string } | null
}

/** 七步流程的單一實作點；三支公開 API 與 reconcileRegistry 都走這裡。 */
async function runRegistryOperation(intent: RegistryIntent, deps: RegistryDeps): Promise<RunOutcome> {
  // 正式路徑（未注入 executor）才需要補 .env——測試一律注入，process.env 不被本檔動到。
  let pool: Pool | null = null
  if (!deps.executor) {
    loadRegistryEnv()
    pool = createMonitorPool('mon_head', { connectionLimit: 2 })
  }
  const d = resolveDeps(deps, deps.executor ?? (pool as unknown as MonitorDbExecutor))

  try {
    const target = resolveTarget(intent, d.files, d.io)
    if (!d.io.exists(target.path)) {
      // 名冊檔理論上一直存在（部署時建立）；不存在是設定問題，明確報錯比當成空名冊安全。
      throw new Error(`[token-registry] 名冊檔不存在：${target.path}（部署設定問題，中止）`)
    }
    const currentContent = d.io.read(target.path)
    const current = parseRegistry(currentContent, target.path)

    // 步驟 1：reconcile（檔案 → DB，單向）
    await reconcileFileIntoDb(d, target, current)

    // 步驟 2：寫 DB（同步 await，失敗即中止，不進 spool）
    const issued = await applyIntentToDb(d, target, intent)

    // 步驟 3：投影（步驟 5：解密失敗在此往外丟，舊檔不動）
    const projected = await projectFromDb(d, target)

    // 步驟 4：雙向差異閘門
    assertGate(diffEntries(current, projected), intent, current)

    // 步驟 6：備份 + 原子寫（投影結果與現行檔 byte 相同時是 no-op，不製造無謂備份）
    const serialized = serializeRegistry(projected)
    const written: string[] = []
    let backupPath: string | null = null
    if (serialized !== currentContent) {
      backupPath = d.io.backup(target.path, `${BACKUP_TYPE_PREFIX}/${target.server}`)
      d.io.writeAtomic(target.path, serialized)
      written.push(target.path)
    }

    // 步驟 7：投影後驗證（重讀檔案比對；不符 → 從備份還原）
    try {
      assertProjectionPersisted(parseRegistry(d.io.read(target.path), target.path), projected)
    } catch (err) {
      if (backupPath) {
        d.io.writeAtomic(target.path, d.io.read(backupPath))
      }
      throw new Error(
        `${(err as Error).message}；` +
          (backupPath ? `已從備份還原：${backupPath}` : '本次未寫出檔案，無需還原'),
      )
    }

    return { written, issued }
  } catch (err) {
    // 單一告警點：整條流程任一步中止都在這裡 alert 恰一次（訊息不含 token 明文）。
    d.alert(`[token-registry] op='${intent.op}' 中止：${(err as Error).message}`)
    throw err
  } finally {
    if (pool) await pool.end()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 公開 API（MJ-E9 簽名）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 核發一把新 token：DB 先寫，再投影回名冊檔。
 *
 * **同時涵蓋 rotate（重簽）**：mcps 側兩支 CLI 的 `--rotate` / `ensureToolsmithIssued`
 * 都委派到本函式（upsert 語意，不另設 'rotate' op）。newId 已存在於現行名冊時，
 * DB 以新 token 更新 token_enc / token_bidx / issued_at / display_name，閘門改用
 * rotate 型判定（恰一筆 changed 且變動欄位 ⊆ {token, issued_at, display_name}）。
 * 兩種情況都回傳新的明文 token。
 *
 * 回傳的 `token` 是明文（CLI 要組 starter kit 給人），**不得寫進任何 log**。
 */
export async function issueToken(intent: IssueIntent, deps: RegistryDeps = {}): Promise<IssueResult> {
  const out = await runRegistryOperation(intent, deps)
  if (!out.issued) {
    throw new Error('[token-registry] 內部錯誤：issue 流程未產生 token')
  }
  return { written: out.written, tokenId: intent.newId, token: out.issued.token }
}

/** 撤銷：DB 寫 revoked_at（不刪列），投影後名冊檔不再含這些 id。 */
export async function revokeTokens(intent: RevokeIntent, deps: RegistryDeps = {}): Promise<RegistryWriteResult> {
  if (intent.ids.length === 0) {
    throw new Error('[token-registry] revoke 未指定任何 id，中止')
  }
  const out = await runRegistryOperation(intent, deps)
  return { written: out.written }
}

/** 改名：只動 display_name，token 與 issued_at 完全不動。 */
export async function renameToken(intent: RenameIntent, deps: RegistryDeps = {}): Promise<RegistryWriteResult> {
  const out = await runRegistryOperation(intent, deps)
  return { written: out.written }
}

/**
 * 純 reconcile（無 intent）：對帳並把檔案側新增補進 DB，閘門期望空差異。
 * 「檔案與 DB 已同步」時是恆等變換——投影結果與現行檔 byte 完全相同，不寫檔。
 */
export async function reconcileRegistry(
  intent: ReconcileIntent,
  deps: RegistryDeps = {},
): Promise<RegistryWriteResult> {
  const out = await runRegistryOperation(intent, deps)
  return { written: out.written }
}
