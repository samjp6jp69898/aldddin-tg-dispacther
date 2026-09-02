// lib/registry/tech-users-sync.test.ts — Phase 5（MAJOR-F11）單元測試。
//
// 不打真實 DB：DB 寫入抽象成 MonitorDbExecutor，測試注入一個極簡的假 executor
// （在本檔內以 SQL 前綴比對模擬 tech_users 表；SQL 文字由本檔生產程式碼自己
// 撰寫，前綴穩定可預期）。CSV 一律先複製到 tmp 路徑才寫，絕不觸碰真實
// tech-users.csv；加密走隨機測試金鑰實跑 encryptField/blindIndex/decryptField。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySetToContent,
  applyUnsetToContent,
  findEmailAndChatIdColumns,
  parseCliArgs,
  parseTechUsersCsvStrict,
  regenerateCsvContent,
  runReconcile,
  runSet,
  runUnset,
  TECH_USER_BIDX_SCOPE,
  type RunDeps,
} from './tech-users-sync.ts'
import { blindIndex, encryptField } from '../crypto/field-crypto.ts'
import { decryptField } from '../crypto/roster-decrypt.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

const FIXTURES = join(import.meta.dir, '__fixtures__')

const ORIG_FIELD_KEY = process.env.MON_FIELD_KEY_V1
const ORIG_BIDX_KEY = process.env.MON_BIDX_KEY

function freshKey(): string {
  return randomBytes(32).toString('base64')
}

beforeEach(() => {
  process.env.MON_FIELD_KEY_V1 = freshKey()
  process.env.MON_BIDX_KEY = freshKey()
})

afterEach(() => {
  if (ORIG_FIELD_KEY === undefined) delete process.env.MON_FIELD_KEY_V1
  else process.env.MON_FIELD_KEY_V1 = ORIG_FIELD_KEY
  if (ORIG_BIDX_KEY === undefined) delete process.env.MON_BIDX_KEY
  else process.env.MON_BIDX_KEY = ORIG_BIDX_KEY
})

// ---------- tmp fixture helper ----------

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tech-users-sync-test-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function copyFixtureToTmp(name: string): string {
  const src = join(FIXTURES, name)
  const dest = join(tmpDir, name)
  writeFileSync(dest, readFileSync(src, 'utf8'))
  return dest
}

// ---------- fake tech_users executor ----------

interface FakeRow {
  email: string
  notion_user_name: string
  notion_user_id: string
  pushed_repos: string
  tg_chat_id_enc: string | null
  tg_chat_id_bidx: Buffer | null
  bidx_key_ver: number | null
}

interface RecordedCall {
  sql: string
  params: unknown[]
}

function makeFakeExecutor(initial: FakeRow[] = []): {
  executor: MonitorDbExecutor
  calls: RecordedCall[]
  rows: Map<string, FakeRow>
} {
  const rows = new Map(initial.map((r) => [r.email, r]))
  const calls: RecordedCall[] = []
  const executor: MonitorDbExecutor = {
    async execute<T = unknown>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
      calls.push({ sql, params })
      const s = sql.replace(/\s+/g, ' ').trim()

      if (s.startsWith('SELECT email FROM tech_users WHERE email = ?')) {
        const email = params[0] as string
        const row = rows.get(email)
        return [(row ? [{ email: row.email }] : []) as unknown as T, undefined]
      }
      if (s.startsWith('SELECT email FROM tech_users')) {
        return [Array.from(rows.values()).map((r) => ({ email: r.email })) as unknown as T, undefined]
      }
      if (s.startsWith('SELECT email, tg_chat_id_enc FROM tech_users')) {
        return [
          Array.from(rows.values()).map((r) => ({ email: r.email, tg_chat_id_enc: r.tg_chat_id_enc })) as unknown as T,
          undefined,
        ]
      }
      if (s.startsWith('INSERT INTO tech_users') && s.includes('ON DUPLICATE KEY UPDATE')) {
        const [email, notion_user_name, notion_user_id, pushed_repos, tg_chat_id_enc, tg_chat_id_bidx, bidx_key_ver] =
          params as [string, string, string, string, string | null, Buffer | null, number | null]
        const existing = rows.get(email)
        if (existing) {
          rows.set(email, { ...existing, notion_user_name, notion_user_id, pushed_repos })
        } else {
          rows.set(email, { email, notion_user_name, notion_user_id, pushed_repos, tg_chat_id_enc, tg_chat_id_bidx, bidx_key_ver })
        }
        return [{ affectedRows: 1 } as unknown as T, undefined]
      }
      if (s.startsWith('INSERT INTO tech_users')) {
        const [email, notion_user_name, notion_user_id, pushed_repos, tg_chat_id_enc, tg_chat_id_bidx, bidx_key_ver] =
          params as [string, string, string, string, string, Buffer, number]
        rows.set(email, { email, notion_user_name, notion_user_id, pushed_repos, tg_chat_id_enc, tg_chat_id_bidx, bidx_key_ver })
        return [{ affectedRows: 1 } as unknown as T, undefined]
      }
      if (s.startsWith('UPDATE tech_users SET tg_chat_id_enc = ?, tg_chat_id_bidx = ?, bidx_key_ver = ? WHERE email = ?')) {
        const [enc, bidx, ver, email] = params as [string, Buffer, number, string]
        const existing = rows.get(email)
        if (existing) rows.set(email, { ...existing, tg_chat_id_enc: enc, tg_chat_id_bidx: bidx, bidx_key_ver: ver })
        return [{ affectedRows: 1 } as unknown as T, undefined]
      }
      if (s.startsWith('UPDATE tech_users SET tg_chat_id_enc = NULL, tg_chat_id_bidx = NULL, bidx_key_ver = NULL WHERE email = ?')) {
        const [email] = params as [string]
        const existing = rows.get(email)
        if (existing) rows.set(email, { ...existing, tg_chat_id_enc: null, tg_chat_id_bidx: null, bidx_key_ver: null })
        return [{ affectedRows: 1 } as unknown as T, undefined]
      }
      throw new Error(`fake executor: unrecognized SQL: ${s}`)
    },
  }
  return { executor, calls, rows }
}

function deps(csvPath: string, overrides: Partial<RunDeps> = {}): RunDeps {
  return { csvPath, enabled: true, dryRun: false, executor: null, ...overrides }
}

// ─────────────────────────────────────────────────────────────────────────
// flag off：與 tg-map-chatids.sh 語意一致
// ─────────────────────────────────────────────────────────────────────────

describe('flag off（MON_DB_ENABLED !== \'1\'）：applySetToContent / applyUnsetToContent', () => {
  const content = readFileSync(join(FIXTURES, 'tech-users-flagoff-sample.csv'), 'utf8')

  test('set：新值 → OK，且其他列 byte 不變', () => {
    const r = applySetToContent(content, 'bob@example.test', '999999999', false)
    expect(r.status).toBe('OK')
    const newLines = r.content!.split('\n')
    const oldLines = content.split('\n')
    expect(newLines[0]).toBe(oldLines[0]) // header 原樣
    expect(newLines[1]).toBe(oldLines[1]) // alice 那列不變
    expect(newLines[3]).toBe(oldLines[3]) // carol 那列不變
    expect(newLines[2]).toBe('Bob,uid-2,bob@example.test,abu,999999999')
  })

  test('set：同值 → NOOP', () => {
    const r = applySetToContent(content, 'alice@example.test', '111111111', false)
    expect(r.status).toBe('NOOP')
    expect(r.content).toBeUndefined()
  })

  test('set：既有不同值且未 --force → CONFLICT', () => {
    const r = applySetToContent(content, 'alice@example.test', '000000000', false)
    expect(r.status).toBe('CONFLICT')
  })

  test('set：既有不同值 + force=true → OK，改寫該列', () => {
    const r = applySetToContent(content, 'alice@example.test', '000000000', true)
    expect(r.status).toBe('OK')
    expect(r.content!.split('\n')[1]).toBe('Alice,uid-1,alice@example.test,abu;rajah,000000000')
  })

  test('set：email 不存在 → ERR_NO_EMAIL', () => {
    const r = applySetToContent(content, 'nobody@example.test', '123', false)
    expect(r.status).toBe('ERR_NO_EMAIL')
  })

  test('set：email 或 chat_id 為空 → ERR_ARGS', () => {
    expect(applySetToContent(content, '', '123', false).status).toBe('ERR_ARGS')
    expect(applySetToContent(content, 'bob@example.test', '', false).status).toBe('ERR_ARGS')
  })

  test('unset：既有值 → OK，清空該列 tg_chat_id，其他列不變', () => {
    const r = applyUnsetToContent(content, 'carol@example.test')
    expect(r.status).toBe('OK')
    const newLines = r.content!.split('\n')
    const oldLines = content.split('\n')
    expect(newLines[0]).toBe(oldLines[0])
    expect(newLines[1]).toBe(oldLines[1])
    expect(newLines[3]).toBe('Carol,uid-3,carol@example.test,agrabah;lago,')
  })

  test('unset：已無值 → NOOP', () => {
    const r = applyUnsetToContent(content, 'bob@example.test')
    expect(r.status).toBe('NOOP')
  })

  test('unset：email 不存在 → ERR_NO_EMAIL', () => {
    expect(applyUnsetToContent(content, 'nobody@example.test').status).toBe('ERR_NO_EMAIL')
  })

  test('header 缺 email/tg_chat_id 欄 → ERR_NO_COL', () => {
    const bad = 'a,b,c\nx,y,z\n'
    expect(applySetToContent(bad, 'x', '1', false).status).toBe('ERR_NO_COL')
    expect(applyUnsetToContent(bad, 'x').status).toBe('ERR_NO_COL')
  })
})

describe('flag off：runSet/runUnset 經 I/O 寫入 tmp fixture（不碰真實 CSV）', () => {
  test('runSet 寫入後，磁碟檔案內容與 applySetToContent 純函式結果一致，且 SET_OK 訊息不含明文 chat_id', async () => {
    const csvPath = copyFixtureToTmp('tech-users-flagoff-sample.csv')
    const lines = await runSet('bob@example.test', '888888888', false, deps(csvPath, { enabled: false }))
    expect(lines).toEqual(['SET_OK: bob@example.test'])
    expect(lines.join('\n')).not.toContain('888888888')
    const written = readFileSync(csvPath, 'utf8')
    expect(written.split('\n')[2]).toBe('Bob,uid-2,bob@example.test,abu,888888888')
  })

  test('runUnset CSV 不存在 → ERR_NO_CSV，不丟例外', async () => {
    const lines = await runUnset('x@example.test', deps(join(tmpDir, 'nonexistent.csv'), { enabled: false }))
    expect(lines[0]).toContain('UNSET_ERR_NO_CSV')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// flag on：方向表三型（CSV→DB 覆寫 / chat_id 初始化 / DB→CSV 覆寫回去）
// ─────────────────────────────────────────────────────────────────────────

describe('flag on：--reconcile 方向表（notion_user_name/id/pushed_repos CSV→DB；tg_chat_id 新列初始化、既有列 DB→CSV）', () => {
  test('三型同時驗證：CSV→DB 覆寫 name/id/repos；chat_id 初始化新列；既有列 chat_id 單向 DB→CSV 覆寫回去', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const originalContent = readFileSync(csvPath, 'utf8')

    // 預先在 DB 塞一列 eve（既有列）：name/id 與 CSV 不同、chat_id 也與 CSV 不同（模擬使用者手改 CSV）。
    const eveCtx = 'tech_users.tg_chat_id:eve@example.test'
    const eveDbChatId = '999999999'
    const { executor, rows } = makeFakeExecutor([
      {
        email: 'eve@example.test',
        notion_user_name: 'Eve DB Old Name',
        notion_user_id: 'uid-eve-db-old',
        pushed_repos: 'agrabah',
        tg_chat_id_enc: encryptField(eveCtx, eveDbChatId),
        tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, eveDbChatId),
        bidx_key_ver: 1,
      },
    ])
    // frank 在 DB 尚無此列（chat_id 初始化情境）。

    const lines = await runReconcile(deps(csvPath, { executor }))
    expect(lines[0]).toBe('RECONCILE_OK: 2 CSV row(s) upserted')

    // (a) CSV→DB 覆寫：eve 的 name/id/repos 被 CSV 值覆寫。
    const eveRow = rows.get('eve@example.test')!
    expect(eveRow.notion_user_name).toBe('Eve CSV Name')
    expect(eveRow.notion_user_id).toBe('uid-eve-csv')
    expect(eveRow.pushed_repos).toBe('abu;lago')

    // (c) 既有列 chat_id 單向 DB→CSV：eve 的 DB chat_id 沒被 CSV 的 333333333 覆寫。
    expect(decryptField(eveCtx, eveRow.tg_chat_id_enc!)).toBe(eveDbChatId)

    // (b) chat_id 初始化：frank 在 DB 沒有列 → 由 CSV 的 444444444 初始化。
    const frankRow = rows.get('frank@example.test')!
    expect(frankRow.notion_user_name).toBe('Frank CSV Name')
    const frankCtx = 'tech_users.tg_chat_id:frank@example.test'
    expect(decryptField(frankCtx, frankRow.tg_chat_id_enc!)).toBe('444444444')

    // 重生後的 CSV：frank 欄位不變（DB 值＝CSV 原值）；eve 欄位被改回 DB 的 999999999（覆寫掉手改的 333333333）。
    const regenerated = readFileSync(csvPath, 'utf8')
    const regLines = regenerated.split('\n')
    const origLines = originalContent.split('\n')
    expect(regLines[0]).toBe(origLines[0]) // header 不變
    expect(regLines[2]).toBe(origLines[2]) // frank 那列 byte 不變（值本來就相同）
    expect(regLines[1]).toBe('Eve CSV Name,uid-eve-csv,eve@example.test,abu;lago,999999999')
    expect(regLines[1]).not.toContain('333333333')
  })
})

describe('flag on：--unset 釋出 UNIQUE（enc/bidx/bidx_key_ver 全 NULL 參數）', () => {
  test('既有 DB 列 --unset → UPDATE 呼叫的參數為 email 且 SQL 字面 NULL 三欄同進退', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const ctx = 'tech_users.tg_chat_id:eve@example.test'
    const { executor, calls, rows } = makeFakeExecutor([
      {
        email: 'eve@example.test',
        notion_user_name: 'Eve DB Old Name',
        notion_user_id: 'uid-eve-db-old',
        pushed_repos: 'agrabah',
        tg_chat_id_enc: encryptField(ctx, '111222333'),
        tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, '111222333'),
        bidx_key_ver: 1,
      },
    ])

    const lines = await runUnset('eve@example.test', deps(csvPath, { executor }))
    expect(lines[0]).toBe('UNSET_OK: eve@example.test')

    const updateCall = calls.find((c) => c.sql.includes('tg_chat_id_enc = NULL'))!
    expect(updateCall).toBeTruthy()
    expect(updateCall.sql).toContain('tg_chat_id_enc = NULL')
    expect(updateCall.sql).toContain('tg_chat_id_bidx = NULL')
    expect(updateCall.sql).toContain('bidx_key_ver = NULL')
    expect(updateCall.params).toEqual(['eve@example.test'])

    const row = rows.get('eve@example.test')!
    expect(row.tg_chat_id_enc).toBeNull()
    expect(row.tg_chat_id_bidx).toBeNull()
    expect(row.bidx_key_ver).toBeNull()
  })

  test('DB 與 CSV 皆無此 email → 明確報錯，不自創列', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const { executor } = makeFakeExecutor([])
    const lines = await runUnset('nobody@example.test', deps(csvPath, { executor }))
    expect(lines[0]).toContain('UNSET_ERR_NO_EMAIL')
  })
})

describe('flag on：--set email 在 DB 與 CSV 都不存在 → 明確報錯不自創列', () => {
  test('SET_ERR_NO_EMAIL，且未呼叫任何寫入 SQL', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const { executor, calls } = makeFakeExecutor([])
    const lines = await runSet('nobody@example.test', '123456789', false, deps(csvPath, { executor }))
    expect(lines[0]).toContain('SET_ERR_NO_EMAIL')
    const writeCalls = calls.filter((c) => /^(INSERT|UPDATE)/i.test(c.sql.trim()))
    expect(writeCalls.length).toBe(0)
  })

  test('chat_id 格式不合法 → SET_ERR_BAD_CHATID，不呼叫 DB', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const { executor, calls } = makeFakeExecutor([])
    const lines = await runSet('eve@example.test', 'not-a-number', false, deps(csvPath, { executor }))
    expect(lines[0]).toContain('SET_ERR_BAD_CHATID')
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 49 列規模 fixture reconcile（31 空值）
// ─────────────────────────────────────────────────────────────────────────

describe('49 列規模 fixture（31 空值）：--reconcile 跑通，結構不變', () => {
  test('全新 DB（無既有列）：49 列全數 upsert，31 列 NULL、18 列加密成功；重生後行數/header/其他欄 byte 不變', async () => {
    const csvPath = copyFixtureToTmp('tech-users-49.csv')
    const originalContent = readFileSync(csvPath, 'utf8')
    const { executor, rows } = makeFakeExecutor([])

    const lines = await runReconcile(deps(csvPath, { executor }))
    expect(lines[0]).toBe('RECONCILE_OK: 49 CSV row(s) upserted')
    expect(rows.size).toBe(49)

    let nullCount = 0
    let nonNullCount = 0
    for (const r of rows.values()) {
      if (r.tg_chat_id_enc === null) nullCount++
      else nonNullCount++
    }
    expect(nullCount).toBe(31)
    expect(nonNullCount).toBe(18)

    const regenerated = readFileSync(csvPath, 'utf8')
    const regLines = regenerated.split('\n')
    const origLines = originalContent.split('\n')
    expect(regLines.length).toBe(origLines.length) // 行數不變
    expect(regLines[0]).toBe(origLines[0]) // header 原樣

    // 每一列：notion_user_name/notion_user_id/pushed_repos 三欄 byte 不變（regen 只動 tg_chat_id）。
    for (let i = 1; i < origLines.length; i++) {
      if (origLines[i] === '') continue
      const origFields = origLines[i]!.split(',')
      const regFields = regLines[i]!.split(',')
      expect(regFields[0]).toBe(origFields[0])
      expect(regFields[1]).toBe(origFields[1])
      expect(regFields[2]).toBe(origFields[2])
      expect(regFields[3]).toBe(origFields[3])
    }
    // 首次 reconcile：DB 值即由 CSV 初始化，往返後理論上整份內容不變。
    expect(regenerated).toBe(originalContent)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 格式防呆（m6）：兩案例中止
// ─────────────────────────────────────────────────────────────────────────

describe('parseTechUsersCsvStrict 格式防呆（m6）', () => {
  test('值含逗號 → throw（欄位數非 5）', () => {
    const content = readFileSync(join(FIXTURES, 'tech-users-bad-comma.csv'), 'utf8')
    expect(() => parseTechUsersCsvStrict(content)).toThrow()
  })

  test('tg_chat_id 非空且非數字 → throw', () => {
    const content = readFileSync(join(FIXTURES, 'tech-users-bad-chatid.csv'), 'utf8')
    expect(() => parseTechUsersCsvStrict(content)).toThrow()
  })

  test('--reconcile 遇格式錯誤 CSV → 整支中止，不呼叫任何 DB', async () => {
    const csvPath = copyFixtureToTmp('tech-users-bad-comma.csv')
    const { executor, calls } = makeFakeExecutor([])
    await expect(runReconcile(deps(csvPath, { executor }))).rejects.toThrow()
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 孤兒列 WARN
// ─────────────────────────────────────────────────────────────────────────

describe('flag on：--reconcile 孤兒列（DB 有、CSV 沒有）→ WARN，不自動刪', () => {
  test('orphan@example.test 只存在於 DB → 輸出含 RECONCILE_WARN_ORPHAN', async () => {
    const csvPath = copyFixtureToTmp('tech-users-orphan.csv')
    const orphanCtx = 'tech_users.tg_chat_id:orphan@example.test'
    const { executor, rows } = makeFakeExecutor([
      {
        email: 'orphan@example.test',
        notion_user_name: 'Orphan Name',
        notion_user_id: 'uid-orphan',
        pushed_repos: 'abu',
        tg_chat_id_enc: encryptField(orphanCtx, '700000001'),
        tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, '700000001'),
        bidx_key_ver: 1,
      },
    ])
    const lines = await runReconcile(deps(csvPath, { executor }))
    expect(lines.some((l) => l.includes('RECONCILE_WARN_ORPHAN') && l.includes('orphan@example.test'))).toBe(true)
    // 孤兒列本身在 DB 未被刪除。
    expect(rows.has('orphan@example.test')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// --dry-run：零寫入
// ─────────────────────────────────────────────────────────────────────────

describe('--dry-run：零寫入（fixture byte 不變 + executor 零呼叫）', () => {
  test('reconcile --dry-run：fixture 未被改動，executor 完全未被呼叫', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const before = readFileSync(csvPath, 'utf8')
    const { executor, calls } = makeFakeExecutor([
      {
        email: 'eve@example.test',
        notion_user_name: 'x',
        notion_user_id: 'y',
        pushed_repos: 'z',
        tg_chat_id_enc: null,
        tg_chat_id_bidx: null,
        bidx_key_ver: null,
      },
    ])
    const lines = await runReconcile(deps(csvPath, { executor, dryRun: true }))
    expect(lines[0]).toContain('RECONCILE_DRYRUN')
    expect(calls.length).toBe(0)
    expect(readFileSync(csvPath, 'utf8')).toBe(before)
  })

  test('set --dry-run：fixture 未被改動，executor 完全未被呼叫', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const before = readFileSync(csvPath, 'utf8')
    const { executor, calls } = makeFakeExecutor([])
    const lines = await runSet('eve@example.test', '123456789', false, deps(csvPath, { executor, dryRun: true }))
    expect(lines[0]).toContain('SET_DRYRUN')
    expect(calls.length).toBe(0)
    expect(readFileSync(csvPath, 'utf8')).toBe(before)
  })

  test('unset --dry-run：fixture 未被改動，executor 完全未被呼叫', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const before = readFileSync(csvPath, 'utf8')
    const { executor, calls } = makeFakeExecutor([])
    const lines = await runUnset('eve@example.test', deps(csvPath, { executor, dryRun: true }))
    expect(lines[0]).toContain('UNSET_DRYRUN')
    expect(calls.length).toBe(0)
    expect(readFileSync(csvPath, 'utf8')).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 安全邊界：chat_id 明文不得出現在任何 CLI 輸出
// ─────────────────────────────────────────────────────────────────────────

describe('安全邊界：chat_id 明文不得出現在輸出', () => {
  test('flag on set/unset/reconcile 的輸出訊息皆不含明文 chat_id', async () => {
    const csvPath = copyFixtureToTmp('tech-users-direction.csv')
    const { executor } = makeFakeExecutor([])
    const secretChatIds = ['333333333', '444444444', '555555555', '666666666']

    const l1 = await runSet('eve@example.test', '555555555', false, deps(csvPath, { executor }))
    const l2 = await runUnset('eve@example.test', deps(csvPath, { executor }))
    const l3 = await runReconcile(deps(csvPath, { executor }))
    const l4 = await runSet('eve@example.test', '666666666', false, deps(csvPath, { executor }))

    const combined = [...l1, ...l2, ...l3, ...l4].join('\n')
    for (const secret of secretChatIds) {
      expect(combined.includes(secret)).toBe(false)
    }
  })

  test('flag off set/unset 的輸出訊息皆不含明文 chat_id', async () => {
    const csvPath = copyFixtureToTmp('tech-users-flagoff-sample.csv')
    const l1 = await runSet('bob@example.test', '777777777', false, deps(csvPath, { enabled: false }))
    const l2 = await runUnset('carol@example.test', deps(csvPath, { enabled: false }))
    const combined = [...l1, ...l2].join('\n')
    expect(combined.includes('777777777')).toBe(false)
    expect(combined.includes('222222222')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// regenerateCsvContent 純函式邊界情境
// ─────────────────────────────────────────────────────────────────────────

describe('regenerateCsvContent（純函式）', () => {
  const content = readFileSync(join(FIXTURES, 'tech-users-flagoff-sample.csv'), 'utf8')

  test('DB map 沒有某 email → 保留該列原值', () => {
    const map = new Map<string, string | null>() // 空 map：全部保留原值
    const result = regenerateCsvContent(content, map)
    expect(result).toBe(content)
  })

  test('DB map 有 email 且值為 null → 該列 tg_chat_id 覆寫成空字串', () => {
    const map = new Map<string, string | null>([['alice@example.test', null]])
    const result = regenerateCsvContent(content, map)
    expect(result.split('\n')[1]).toBe('Alice,uid-1,alice@example.test,abu;rajah,')
  })

  test('header 缺欄 → throw', () => {
    expect(() => regenerateCsvContent('a,b,c\nx,y,z\n', new Map())).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// CLI 參數解析
// ─────────────────────────────────────────────────────────────────────────

describe('parseCliArgs / findEmailAndChatIdColumns', () => {
  test('--set <email> <chat_id> [--force] [--csv <path>]', () => {
    const args = parseCliArgs(['--set', 'a@b.test', '123', '--force', '--csv', '/tmp/x.csv'])
    expect(args.mode).toBe('set')
    expect(args.email).toBe('a@b.test')
    expect(args.chatId).toBe('123')
    expect(args.force).toBe(true)
    expect(args.csvPath).toBe('/tmp/x.csv')
  })

  test('--reconcile --dry-run', () => {
    const args = parseCliArgs(['--reconcile', '--dry-run'])
    expect(args.mode).toBe('reconcile')
    expect(args.dryRun).toBe(true)
  })

  test('findEmailAndChatIdColumns：header 缺欄回 null', () => {
    expect(findEmailAndChatIdColumns('a,b,c')).toBeNull()
    expect(findEmailAndChatIdColumns('notion_user_name,notion_user_id,email,pushed_repos,tg_chat_id')).toEqual({
      emailCol: 2,
      chatCol: 4,
    })
  })
})
