// lib/registry/token-registry.test.ts — §5.9 七步流程 + BL-C4 雙向差異閘門的單元測試。
//
// 全部注入式，**不需要真實 DB、不碰任何真實 tokens*.json、不碰 ~/.aladdin-backups**：
//   - DB：`FakeMcpTokensDb` 以匯出的 SQL 常數辨識語句，模擬 INSERT IGNORE 的 PK 冪等、
//     INSERT 的 ER_DUP_ENTRY、守衛式 UPDATE（revoked_at IS NULL）與投影 SELECT 的
//     ORDER BY (issued_at, token_id)。
//   - 檔案層：`FakeIo` 是純記憶體 Map，備份也存在同一個 Map——所以「byte-level 不變」
//     這類斷言比對的是真的 byte，而 fs-safe.ts 的真實實作（會寫進使用者家目錄）
//     完全不被觸發。
//   - 加密：用**真的** field-crypto / roster-decrypt，金鑰是本檔在 beforeAll 產生的
//     測試隨機金鑰（32 bytes base64），寫回 process.env。所以 AAD 綁定、GCM tag、
//     缺前綴丟例外等行為都是真實行為，不是假物件。
//
// 禁 sleep：本檔沒有任何 setTimeout / sleep / 輪詢（末尾另有一條靜態斷言把關）。

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { blindIndex, encryptField } from '../crypto/field-crypto.ts'
import {
  ISSUE_UPSERT_SQL,
  PROJECTION_SELECT_SQL,
  RECONCILE_INSERT_SQL,
  RENAME_UPDATE_SQL,
  REVOKE_UPDATE_SQL,
  RegistryGateError,
  diffEntries,
  issueToken,
  reconcileRegistry,
  renameToken,
  revokeTokens,
  serializeRegistry,
  tokenEncCtx,
  type RegistryDeps,
  type RegistryEntry,
  type RegistryFileIo,
} from './token-registry.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

// ─────────────────────────────────────────────────────────────────────────
// 測試金鑰（真加密、真解密）
// ─────────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.MON_FIELD_KEY_V1 = randomBytes(32).toString('base64')
  process.env.MON_BIDX_KEY = randomBytes(32).toString('base64')
})

// ─────────────────────────────────────────────────────────────────────────
// fixture 路徑（白名單以 deps.registryFiles 覆寫；正式 9 路完全不被觸及）
// ─────────────────────────────────────────────────────────────────────────

const ADMIN_DEFAULT = '/fixtures/aladdin-admin/tokens.json'
const ADMIN_PRE = '/fixtures/aladdin-admin/tokens.pre.json'
const FIXTURE_FILES = [ADMIN_DEFAULT, ADMIN_PRE] as const

const SERVER = 'aladdin-admin'
const ENV_DEFAULT = 'default'

const NOW = () => new Date('2026-09-02T03:04:05.678Z')

function entry(id: string, token: string, displayName: string | null, issuedAt: string): RegistryEntry {
  return { id, token, display_name: displayName, issued_at: issuedAt }
}

const ALICE = entry('alice', 'tok-alice-aaaaaaaaaaaaaaaaaaaaaaaa', '企劃小A', '2026-01-01T00:00:00.000Z')
const BOB = entry('bob', 'tok-bob-bbbbbbbbbbbbbbbbbbbbbbbbbb', '企劃小B', '2026-02-02T00:00:00.000Z')

// ─────────────────────────────────────────────────────────────────────────
// 假檔案層
// ─────────────────────────────────────────────────────────────────────────

class FakeIo implements RegistryFileIo {
  files = new Map<string, string>()
  /** 每一次 writeAtomic 寫出的內容（含還原寫入），供「假列不得出現在任何寫出檔案」斷言。 */
  writes: { path: string; content: string }[] = []
  backupSeq = 0
  /** 第 N 次 writeAtomic 後把檔案內容改掉（模擬寫入後被篡改），null = 不篡改。 */
  tamperOnWrite: number | null = null

  constructor(readonly log: string[]) {}

  exists(path: string): boolean {
    return this.files.has(path)
  }

  read(path: string): string {
    const v = this.files.get(path)
    if (v === undefined) throw new Error(`FakeIo: 檔案不存在 ${path}`)
    this.log.push(`io:read:${path}`)
    return v
  }

  backup(srcPath: string, type: string): string {
    this.log.push(`io:backup:${type}`)
    const dest = `/backups/${type}/${++this.backupSeq}`
    this.files.set(dest, this.files.get(srcPath)!)
    return dest
  }

  writeAtomic(path: string, content: string): void {
    this.log.push(`io:write:${path}`)
    this.writes.push({ path, content })
    this.files.set(path, content)
    if (this.tamperOnWrite !== null && this.writes.length === this.tamperOnWrite) {
      const tampered = JSON.parse(content) as { tokens: RegistryEntry[] }
      tampered.tokens[0].token = 'TAMPERED-BY-SOMEONE-ELSE'
      this.files.set(path, JSON.stringify(tampered, null, 2) + '\n')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 假 mcp_tokens 表
// ─────────────────────────────────────────────────────────────────────────

interface FakeRow {
  server: string
  env: string
  token_id: string
  token_enc: string
  token_bidx: Buffer
  issued_at: string
  display_name: string | null
  revoked_at: string | null
}

class FakeMcpTokensDb implements MonitorDbExecutor {
  rows: FakeRow[] = []

  constructor(readonly log: string[]) {}

  private find(server: string, env: string, id: string): FakeRow | undefined {
    return this.rows.find((r) => r.server === server && r.env === env && r.token_id === id)
  }

  /** 直接塞列（模擬攻擊者／DB 側既有狀態），繞過本模組。 */
  seed(server: string, env: string, e: RegistryEntry, revokedAt: string | null = null): void {
    this.rows.push({
      server,
      env,
      token_id: e.id,
      token_enc: encryptField(tokenEncCtx(e.id), e.token),
      token_bidx: blindIndex('mcp_tokens.token', e.token)!,
      issued_at: e.issued_at,
      display_name: e.display_name,
      revoked_at: revokedAt,
    })
  }

  async execute<T>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    if (sql === RECONCILE_INSERT_SQL || sql === ISSUE_UPSERT_SQL) {
      const [server, env, token_id, token_enc, token_bidx, issued_at, display_name] = params as [
        string,
        string,
        string,
        string,
        Buffer,
        string,
        string | null,
      ]
      const isReconcile = sql === RECONCILE_INSERT_SQL
      this.log.push(isReconcile ? `db:reconcile-insert:${token_id}` : `db:issue-upsert:${token_id}`)
      const existing = this.find(server, env, token_id)
      if (existing) {
        // INSERT IGNORE：撞 PK 什麼都不做。
        if (isReconcile) return [{ affectedRows: 0 } as unknown as T, undefined]
        // 守衛式 ODKU（rotate）：revoked_at 刻意不在賦值清單裡；已撤銷列（revoked_at
        // 非 NULL）的四欄一律維持原值不被覆寫，模擬 IF(revoked_at IS NULL, new.x, x)。
        if (existing.revoked_at === null) {
          existing.token_enc = token_enc
          existing.token_bidx = token_bidx
          existing.issued_at = issued_at
          existing.display_name = display_name
        }
        return [{ affectedRows: 2 } as unknown as T, undefined]
      }
      this.rows.push({ server, env, token_id, token_enc, token_bidx, issued_at, display_name, revoked_at: null })
      return [{ affectedRows: 1 } as unknown as T, undefined]
    }

    if (sql === REVOKE_UPDATE_SQL) {
      const [server, env, id] = params as [string, string, string]
      this.log.push(`db:revoke-update:${id}`)
      const row = this.find(server, env, id)
      let affected = 0
      if (row && row.revoked_at === null) {
        row.revoked_at = '2026-09-02 03:04:05.678'
        affected = 1
      }
      return [{ affectedRows: affected } as unknown as T, undefined]
    }

    if (sql === RENAME_UPDATE_SQL) {
      const [newName, server, env, id] = params as [string, string, string, string]
      this.log.push(`db:rename-update:${id}`)
      const row = this.find(server, env, id)
      let affected = 0
      if (row && row.revoked_at === null) {
        row.display_name = newName
        affected = 1
      }
      return [{ affectedRows: affected } as unknown as T, undefined]
    }

    if (sql === PROJECTION_SELECT_SQL) {
      const [server, env] = params as [string, string]
      this.log.push('db:projection-select')
      const rows = this.rows
        .filter((r) => r.server === server && r.env === env && r.revoked_at === null)
        .sort((a, b) =>
          a.issued_at < b.issued_at
            ? -1
            : a.issued_at > b.issued_at
              ? 1
              : a.token_id < b.token_id
                ? -1
                : a.token_id > b.token_id
                  ? 1
                  : 0,
        )
        .map((r) => ({
          token_id: r.token_id,
          token_enc: r.token_enc,
          issued_at: r.issued_at,
          display_name: r.display_name,
        }))
      return [rows as unknown as T, undefined]
    }

    throw new Error(`FakeMcpTokensDb: 未知 SQL\n${sql}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 共用測試裝置
// ─────────────────────────────────────────────────────────────────────────

interface Harness {
  log: string[]
  io: FakeIo
  db: FakeMcpTokensDb
  alerts: string[]
  deps: RegistryDeps
}

/** 建立一組「檔案有 entries、DB 依 dbSynced 決定是否已同步」的測試裝置。 */
function makeHarness(entries: RegistryEntry[], opts: { dbSynced?: boolean; files?: readonly string[] } = {}): Harness {
  const log: string[] = []
  const io = new FakeIo(log)
  const db = new FakeMcpTokensDb(log)
  const alerts: string[] = []
  io.files.set(ADMIN_DEFAULT, serializeRegistry(entries))
  if (opts.dbSynced ?? true) {
    for (const e of entries) db.seed(SERVER, ENV_DEFAULT, e)
  }
  return {
    log,
    io,
    db,
    alerts,
    deps: {
      executor: db,
      io,
      alert: (m) => alerts.push(m),
      now: NOW,
      registryFiles: opts.files ?? FIXTURE_FILES,
    },
  }
}

function readEntries(io: FakeIo, path = ADMIN_DEFAULT): RegistryEntry[] {
  return (JSON.parse(io.files.get(path)!) as { tokens: RegistryEntry[] }).tokens
}

afterEach(() => {
  // 本檔不建立任何真實資源；此處僅作為「沒有非同步殘留」的意圖宣告。
})

// ─────────────────────────────────────────────────────────────────────────
// 1. 檔案同形 / 序列化
// ─────────────────────────────────────────────────────────────────────────

describe('serializeRegistry：與現行 tokens*.json 完全同形', () => {
  test('欄位順序 id→token→display_name→issued_at、2 空格縮排、結尾換行', () => {
    const out = serializeRegistry([entry('alice', 'T', 'A', '2026-01-01T00:00:00.000Z')])
    expect(out).toBe(
      '{\n' +
        '  "tokens": [\n' +
        '    {\n' +
        '      "id": "alice",\n' +
        '      "token": "T",\n' +
        '      "display_name": "A",\n' +
        '      "issued_at": "2026-01-01T00:00:00.000Z"\n' +
        '    }\n' +
        '  ]\n' +
        '}\n',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. 七步順序
// ─────────────────────────────────────────────────────────────────────────

describe('七步流程順序（§5.9，順序不可換）', () => {
  test('issue：讀檔 → reconcile → 寫 DB → 投影 → (閘門) → 備份 → 寫檔 → 重讀驗證', async () => {
    const h = makeHarness([ALICE, BOB])
    await issueToken(
      { op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'carol', displayName: '企劃小C', registryPath: ADMIN_DEFAULT },
      h.deps,
    )
    expect(h.log).toEqual([
      `io:read:${ADMIN_DEFAULT}`,
      'db:reconcile-insert:alice',
      'db:reconcile-insert:bob',
      'db:issue-upsert:carol',
      'db:projection-select',
      `io:backup:mcp-tokens/${SERVER}`,
      `io:write:${ADMIN_DEFAULT}`,
      `io:read:${ADMIN_DEFAULT}`,
    ])
  })

  test('閘門位在「投影之後、備份之前」：被擋下時 SELECT 已發生、備份與寫檔皆未發生', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.seed(SERVER, ENV_DEFAULT, entry('ghost', 'forged', '偽造', '2026-03-03T00:00:00.000Z'))
    await expect(renameToken({ op: 'rename', id: 'alice', newName: '新名', registryPath: ADMIN_DEFAULT }, h.deps)).rejects.toThrow(
      RegistryGateError,
    )
    expect(h.log).toContain('db:projection-select')
    expect(h.log.some((e) => e.startsWith('io:backup'))).toBe(false)
    expect(h.log.some((e) => e.startsWith('io:write'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. 閘門四型 intent 正例
// ─────────────────────────────────────────────────────────────────────────

describe('雙向差異閘門：四型 intent 各一正例', () => {
  test('issue：恰一筆 added 且 id === newId → 放行，回傳明文 token 且與檔案一致', async () => {
    const h = makeHarness([ALICE, BOB])
    const res = await issueToken(
      { op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'carol', displayName: '企劃小C', registryPath: ADMIN_DEFAULT },
      h.deps,
    )
    expect(res.tokenId).toBe('carol')
    expect(res.written).toEqual([ADMIN_DEFAULT])
    // token 生成格式照抄 make-starter-kit.ts:242-244（randomBytes(32).toString('base64url')）
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const after = readEntries(h.io)
    expect(after.map((e) => e.id)).toEqual(['alice', 'bob', 'carol'])
    const carol = after.find((e) => e.id === 'carol')!
    expect(carol.token).toBe(res.token)
    expect(carol.display_name).toBe('企劃小C')
    expect(carol.issued_at).toBe('2026-09-02T03:04:05.678Z')
    expect(h.alerts).toEqual([])
  })

  test('revoke：removed 集合恰等於 ids → 放行；投影後檔案不含該 id，DB 列仍在只是 revoked', async () => {
    const h = makeHarness([ALICE, BOB])
    const res = await revokeTokens({ op: 'revoke', ids: ['bob'], server: SERVER, env: ENV_DEFAULT }, h.deps)
    expect(res.written).toEqual([ADMIN_DEFAULT])
    expect(readEntries(h.io).map((e) => e.id)).toEqual(['alice'])
    const bobRow = h.db.rows.find((r) => r.token_id === 'bob')!
    expect(bobRow.revoked_at).not.toBeNull() // 寫 revoked_at，不刪列
    expect(h.alerts).toEqual([])
  })

  test('rename：恰一筆 changed 且只有 display_name 不同 → 放行；token 與 issued_at 不動', async () => {
    const h = makeHarness([ALICE, BOB])
    const res = await renameToken({ op: 'rename', id: 'alice', newName: '改過的名字', server: SERVER, env: ENV_DEFAULT }, h.deps)
    expect(res.written).toEqual([ADMIN_DEFAULT])
    const alice = readEntries(h.io).find((e) => e.id === 'alice')!
    expect(alice.display_name).toBe('改過的名字')
    expect(alice.token).toBe(ALICE.token)
    expect(alice.issued_at).toBe(ALICE.issued_at)
    expect(h.alerts).toEqual([])
  })

  test('reconcile（無 intent）：空差異 → 放行', async () => {
    const h = makeHarness([ALICE, BOB])
    const res = await reconcileRegistry({ op: 'reconcile', server: SERVER, env: ENV_DEFAULT }, h.deps)
    expect(res.written).toEqual([])
    expect(h.alerts).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. 負向演練（BL-C4 鑄造攻擊）
// ─────────────────────────────────────────────────────────────────────────

describe('BL-C4 負向演練：DB 側鑄造一列，下一次合法操作必須擋住而不是投影出去', () => {
  test('DB 塞假 token 列 + 跑合法 rename → 中止、舊檔 byte 不變、alert 一次、假列不出現在任何寫出檔案', async () => {
    const h = makeHarness([ALICE, BOB])
    const forged = entry('mallory', 'FORGED-TOKEN-VALUE-DO-NOT-PROJECT', '偽造者', '2026-03-03T00:00:00.000Z')
    h.db.seed(SERVER, ENV_DEFAULT, forged)
    const before = h.io.files.get(ADMIN_DEFAULT)!

    let caught: unknown
    try {
      await renameToken({ op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT }, h.deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RegistryGateError)
    expect((caught as RegistryGateError).diff.added).toEqual(['mallory'])
    // 舊檔 byte-level 完全不變
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    // alert 恰一次
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('mallory')
    // 假列不曾出現在任何寫出的檔案內容裡（一次都沒寫）
    expect(h.io.writes).toEqual([])
    for (const w of h.io.writes) {
      expect(w.content).not.toContain('mallory')
      expect(w.content).not.toContain(forged.token)
    }
  })

  test('未預期 removed（DB 側逕自把一列標成 revoked）→ 擋下，舊檔不變', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.rows.find((r) => r.token_id === 'bob')!.revoked_at = '2026-09-01 00:00:00.000'
    const before = h.io.files.get(ADMIN_DEFAULT)!
    let caught: RegistryGateError | undefined
    try {
      await renameToken({ op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT }, h.deps)
    } catch (err) {
      caught = err as RegistryGateError
    }
    expect(caught).toBeInstanceOf(RegistryGateError)
    expect(caught!.diff.removed).toEqual(['bob'])
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.alerts).toHaveLength(1)
  })

  test('未預期 changed（DB 側逕自改了另一列的 display_name）→ 擋下，舊檔不變', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.rows.find((r) => r.token_id === 'alice')!.display_name = '被偷改的名字'
    const before = h.io.files.get(ADMIN_DEFAULT)!
    let caught: RegistryGateError | undefined
    try {
      await revokeTokens({ op: 'revoke', ids: ['bob'], server: SERVER, env: ENV_DEFAULT }, h.deps)
    } catch (err) {
      caught = err as RegistryGateError
    }
    expect(caught).toBeInstanceOf(RegistryGateError)
    expect(caught!.diff.changed).toEqual([{ id: 'alice', fields: ['display_name'] }])
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.alerts).toHaveLength(1)
  })

  test('未預期 added 同時發生在 issue 上（issue 只允許自己那一筆）→ 擋下', async () => {
    const h = makeHarness([ALICE])
    h.db.seed(SERVER, ENV_DEFAULT, entry('ghost', 'ghost-token', null, '2026-04-04T00:00:00.000Z'))
    await expect(
      issueToken({ op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'carol', displayName: 'C' }, h.deps),
    ).rejects.toThrow(RegistryGateError)
    expect(h.io.writes).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 5. 解密失敗
// ─────────────────────────────────────────────────────────────────────────

describe('解密失敗（步驟 5）', () => {
  test('DB 內某列 token_enc 缺 enc:v1: 前綴 → 整個操作中止，舊檔不動，alert', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.rows.find((r) => r.token_id === 'bob')!.token_enc = 'plaintext-bypass-attempt'
    const before = h.io.files.get(ADMIN_DEFAULT)!
    await expect(
      renameToken({ op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT }, h.deps),
    ).rejects.toThrow(/enc:v1:/)
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.io.writes).toEqual([])
    expect(h.alerts).toHaveLength(1)
  })

  test('AAD 綁錯列（密文被複製到另一個 token_id）→ GCM tag 驗證失敗，中止', async () => {
    const h = makeHarness([ALICE, BOB])
    const aliceRow = h.db.rows.find((r) => r.token_id === 'alice')!
    h.db.rows.find((r) => r.token_id === 'bob')!.token_enc = aliceRow.token_enc
    const before = h.io.files.get(ADMIN_DEFAULT)!
    await expect(
      renameToken({ op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT }, h.deps),
    ).rejects.toThrow()
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.alerts).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 6. 恆等變換（Phase 5 前置第 3 條的單元版）
// ─────────────────────────────────────────────────────────────────────────

describe('恆等變換：檔案與 DB 已同步時，純 reconcile 是 no-op', () => {
  test('空差異、檔案 byte-level 完全不變、issued_at 原字串、排序穩定', async () => {
    // 刻意讓 DB 內的插入順序與 (issued_at, token_id) 排序相反，驗證投影排序穩定。
    const early = entry('zeta', 'tok-zeta-zzzzzzzzzzzzzzzzzzzzzzzz', 'Z', '2026-01-01T00:00:00.000Z')
    const late = entry('alpha', 'tok-alpha-aaaaaaaaaaaaaaaaaaaaaa', 'A', '2026-05-05T00:00:00.000Z')
    const h = makeHarness([early, late], { dbSynced: false })
    h.db.seed(SERVER, ENV_DEFAULT, late)
    h.db.seed(SERVER, ENV_DEFAULT, early)

    const before = h.io.files.get(ADMIN_DEFAULT)!
    const res = await reconcileRegistry({ op: 'reconcile', server: SERVER, env: ENV_DEFAULT }, h.deps)

    expect(res.written).toEqual([])
    expect(h.io.writes).toEqual([])
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before) // byte-level 不變
    expect(readEntries(h.io).map((e) => e.id)).toEqual(['zeta', 'alpha']) // issued_at 遞增，非插入序
    expect(readEntries(h.io)[0].issued_at).toBe('2026-01-01T00:00:00.000Z') // 原字串逐字元
    expect(h.alerts).toEqual([])
  })

  test('reconcile 把檔案側新增（DB 沒有的 entry）單向補進 DB（F-MINOR-8）', async () => {
    const h = makeHarness([ALICE, BOB], { dbSynced: false })
    h.db.seed(SERVER, ENV_DEFAULT, ALICE)
    const res = await reconcileRegistry({ op: 'reconcile', server: SERVER, env: ENV_DEFAULT }, h.deps)
    expect(res.written).toEqual([]) // 補完之後投影與檔案一致
    expect(h.db.rows.map((r) => r.token_id).sort()).toEqual(['alice', 'bob'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 7. 投影後驗證（步驟 7）
// ─────────────────────────────────────────────────────────────────────────

describe('投影後驗證失敗 → 從備份還原', () => {
  test('寫入後檔案被篡改 → 偵測到 token 全值不符、還原成備份內容、alert', async () => {
    const h = makeHarness([ALICE, BOB])
    h.io.tamperOnWrite = 1
    const before = h.io.files.get(ADMIN_DEFAULT)!

    await expect(
      renameToken({ op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT }, h.deps),
    ).rejects.toThrow(/投影後驗證失敗/)

    // 第 2 次 writeAtomic 是還原寫入；最終檔案 byte 等於操作前的舊檔
    expect(h.io.writes).toHaveLength(2)
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('已從備份還原')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 8. 名冊定位 / 白名單
// ─────────────────────────────────────────────────────────────────────────

describe('名冊定位與 9 路白名單（m-10）', () => {
  test('白名單外的 registryPath → 拒絕（不寫任何 DB、不讀任何檔）', async () => {
    const h = makeHarness([ALICE])
    await expect(
      renameToken({ op: 'rename', id: 'alice', newName: 'X', registryPath: '/tmp/evil/tokens.json' }, h.deps),
    ).rejects.toThrow(/不在 9 路白名單內/)
    expect(h.db.rows.filter((r) => r.token_id === 'evil')).toEqual([])
    expect(h.io.writes).toEqual([])
    expect(h.alerts).toHaveLength(1)
  })

  test('registryPath 與 intent 的 server/env 不一致 → 拒絕', async () => {
    const h = makeHarness([ALICE])
    await expect(
      renameToken({ op: 'rename', id: 'alice', newName: 'X', server: 'aladdin-platform', env: ENV_DEFAULT, registryPath: ADMIN_DEFAULT }, h.deps),
    ).rejects.toThrow(/不一致/)
  })

  test('同 id 出現在多份名冊、revoke 未帶 server/env → 中止並要求明示（不猜）', async () => {
    const log: string[] = []
    const io = new FakeIo(log)
    const db = new FakeMcpTokensDb(log)
    const alerts: string[] = []
    io.files.set(ADMIN_DEFAULT, serializeRegistry([ALICE, BOB]))
    io.files.set(ADMIN_PRE, serializeRegistry([ALICE]))
    const deps: RegistryDeps = { executor: db, io, alert: (m) => alerts.push(m), now: NOW, registryFiles: FIXTURE_FILES }

    await expect(revokeTokens({ op: 'revoke', ids: ['alice'] }, deps)).rejects.toThrow(/出現在多份名冊/)
    expect(io.writes).toEqual([])
  })

  test('id 只在一份名冊、未帶 server/env → 自動解析出唯一那份', async () => {
    const log: string[] = []
    const io = new FakeIo(log)
    const db = new FakeMcpTokensDb(log)
    io.files.set(ADMIN_DEFAULT, serializeRegistry([ALICE, BOB]))
    io.files.set(ADMIN_PRE, serializeRegistry([ALICE]))
    db.seed(SERVER, ENV_DEFAULT, ALICE)
    db.seed(SERVER, ENV_DEFAULT, BOB)
    const deps: RegistryDeps = { executor: db, io, alert: () => {}, now: NOW, registryFiles: FIXTURE_FILES }

    const res = await revokeTokens({ op: 'revoke', ids: ['bob'] }, deps)
    expect(res.written).toEqual([ADMIN_DEFAULT])
    expect(io.files.get(ADMIN_PRE)).toBe(serializeRegistry([ALICE])) // 另一份完全沒被動到
  })

  test('id 不在任何名冊 → 中止', async () => {
    const h = makeHarness([ALICE])
    await expect(revokeTokens({ op: 'revoke', ids: ['nobody'] }, h.deps)).rejects.toThrow(/不存在於任何名冊/)
  })

})

// ─────────────────────────────────────────────────────────────────────────
// 8b. rotate（重簽）：mcps 側兩支 CLI 的 --rotate 都委派到 issueToken()
// ─────────────────────────────────────────────────────────────────────────

describe('issue 的 rotate 型：newId 已在現行名冊', () => {
  test('正例：換新 token → 恰一筆 changed（token/issued_at/display_name）→ 放行、投影後驗證過', async () => {
    const h = makeHarness([ALICE, BOB])
    const res = await issueToken(
      { op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'alice', displayName: '企劃小A（重簽）', registryPath: ADMIN_DEFAULT },
      h.deps,
    )

    expect(res.tokenId).toBe('alice')
    expect(res.written).toEqual([ADMIN_DEFAULT])
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.token).not.toBe(ALICE.token)

    const after = readEntries(h.io)
    expect(after.map((e) => e.id).sort()).toEqual(['alice', 'bob'])
    const alice = after.find((e) => e.id === 'alice')!
    expect(alice.token).toBe(res.token) // 舊 token 已從名冊消失
    expect(alice.display_name).toBe('企劃小A（重簽）')
    expect(alice.issued_at).toBe('2026-09-02T03:04:05.678Z')
    // bob 完全沒被動到
    expect(after.find((e) => e.id === 'bob')).toEqual(BOB)
    expect(h.alerts).toEqual([])

    // DB 側：同一列被 ODKU 更新，沒有多長出第二列
    expect(h.db.rows.filter((r) => r.token_id === 'alice')).toHaveLength(1)
  })

  test('rotate 但 DB 另有污染列（額外 added）→ 仍必須擋下，舊檔 byte 不變', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.seed(SERVER, ENV_DEFAULT, entry('mallory', 'FORGED-DURING-ROTATE', 'M', '2026-07-07T00:00:00.000Z'))
    const before = h.io.files.get(ADMIN_DEFAULT)!

    let caught: RegistryGateError | undefined
    try {
      await issueToken({ op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'alice', displayName: '重簽' }, h.deps)
    } catch (err) {
      caught = err as RegistryGateError
    }

    expect(caught).toBeInstanceOf(RegistryGateError)
    expect(caught!.diff.added).toEqual(['mallory'])
    expect(caught!.diff.changed).toEqual([{ id: 'alice', fields: ['token', 'display_name', 'issued_at'] }])
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.io.writes).toEqual([])
    expect(h.alerts).toHaveLength(1)
  })

  test('rotate 撞上「檔案還有、DB 已撤銷」的列 → 未預期 removed，擋下（不默默復活）', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.rows.find((r) => r.token_id === 'alice')!.revoked_at = '2026-08-01 00:00:00.000'
    const before = h.io.files.get(ADMIN_DEFAULT)!
    await expect(
      issueToken({ op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'alice', displayName: '重簽' }, h.deps),
    ).rejects.toThrow(RegistryGateError)
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.db.rows.find((r) => r.token_id === 'alice')!.revoked_at).not.toBeNull()
  })

  test('守衛式 ODKU：rotate 撞上已撤銷列時，該列 token_enc/token_bidx/issued_at/display_name 全部保持原值不被覆寫', async () => {
    const h = makeHarness([ALICE, BOB])
    const aliceRow = h.db.rows.find((r) => r.token_id === 'alice')!
    aliceRow.revoked_at = '2026-08-01 00:00:00.000'
    const beforeEnc = aliceRow.token_enc
    const beforeBidx = aliceRow.token_bidx
    const beforeIssuedAt = aliceRow.issued_at
    const beforeDisplayName = aliceRow.display_name
    const before = h.io.files.get(ADMIN_DEFAULT)!

    await expect(
      issueToken({ op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'alice', displayName: '重簽' }, h.deps),
    ).rejects.toThrow(RegistryGateError)

    // (a) 已撤銷列的密文/bidx/issued_at/display_name 全部不動（守衛式 ODKU：IF(revoked_at IS NULL, new.x, x)）
    expect(aliceRow.token_enc).toBe(beforeEnc)
    expect(aliceRow.token_bidx).toEqual(beforeBidx)
    expect(aliceRow.issued_at).toBe(beforeIssuedAt)
    expect(aliceRow.display_name).toBe(beforeDisplayName)
    expect(aliceRow.revoked_at).not.toBeNull() // revoked_at 仍不重設

    // (b) 閘門仍以未預期 removed 中止；現行檔 byte 完全不變
    expect(h.io.files.get(ADMIN_DEFAULT)).toBe(before)
    expect(h.io.writes).toEqual([])

    // (c) alert 恰被呼叫一次
    expect(h.alerts).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 9. 明文紀律
// ─────────────────────────────────────────────────────────────────────────

describe('token 明文不得出現在任何 console 輸出', () => {
  test('issue 成功 + 閘門擋下（走預設 alert=console.error）皆不印出任何 token 值', async () => {
    const captured: string[] = []
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info }
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    console.log = sink as typeof console.log
    console.error = sink as typeof console.error
    console.warn = sink as typeof console.warn
    console.info = sink as typeof console.info

    let issuedToken = ''
    const forgedToken = 'FORGED-TOKEN-SHOULD-NEVER-BE-PRINTED'
    try {
      const h = makeHarness([ALICE, BOB])
      // 刻意不注入 alert → 用預設的 console.error
      const deps: RegistryDeps = { executor: h.db, io: h.io, now: NOW, registryFiles: FIXTURE_FILES }

      const res = await issueToken(
        { op: 'issue', server: SERVER, env: ENV_DEFAULT, newId: 'carol', displayName: 'C' },
        deps,
      )
      issuedToken = res.token

      h.db.seed(SERVER, ENV_DEFAULT, entry('mallory', forgedToken, 'M', '2026-06-06T00:00:00.000Z'))
      await expect(
        renameToken({ op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT }, deps),
      ).rejects.toThrow(RegistryGateError)
    } finally {
      console.log = orig.log
      console.error = orig.error
      console.warn = orig.warn
      console.info = orig.info
    }

    expect(captured.length).toBeGreaterThan(0) // 閘門確實有告警
    const all = captured.join('\n')
    expect(all).toContain('mallory') // 告警帶得出 id
    expect(all).not.toContain(issuedToken) // 但不帶任何 token 值
    expect(all).not.toContain(forgedToken)
    expect(all).not.toContain(ALICE.token)
    expect(all).not.toContain(BOB.token)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 10. diff 基本性質
// ─────────────────────────────────────────────────────────────────────────

describe('diffEntries', () => {
  test('僅順序不同 → 空差異（首次投影會重排，不該被當成內容變更）', () => {
    expect(diffEntries([ALICE, BOB], [BOB, ALICE])).toEqual({ added: [], removed: [], changed: [] })
  })

  test('token 值變更會被分類為 changed（不是 added/removed）', () => {
    const rotated = { ...ALICE, token: 'different' }
    expect(diffEntries([ALICE], [rotated])).toEqual({ added: [], removed: [], changed: [{ id: 'alice', fields: ['token'] }] })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 11. 靜態紀律
// ─────────────────────────────────────────────────────────────────────────

describe('靜態紀律', () => {
  test('模組與測試皆不使用 sleep / setTimeout / 輪詢等待', () => {
    for (const f of ['token-registry.ts', 'token-registry.test.ts', 'env-load.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(src).not.toMatch(/\bsetTimeout\s*\(/)
      expect(src).not.toMatch(/\bsetInterval\s*\(/)
      expect(src).not.toMatch(/\bBun\.sleep\s*\(/)
    }
  })
})
