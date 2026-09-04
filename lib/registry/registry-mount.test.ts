// lib/registry/registry-mount.test.ts — TG 告警掛載層測試（A8 修補）。
//
// 驗證三件事：
//   (a) 預設掛載下，閘門中止時 fake notify 恰被呼叫一次，訊息含 '🔐 token-registry'
//       前綴、不含任何 token 明文。
//   (b) 呼叫端自帶 alert 時，掛載層不覆蓋——notify 零呼叫。
//   (c) 四支函式的透傳行為：回傳值與直接呼叫 token-registry 一致。
//
// 沿用 token-registry.test.ts 的 fake harness 模式（真加密、記憶體檔案層、
// SQL 常數辨識假 DB），全部注入式，不碰真實 DB／真實 tokens*.json／真實
// tg-notify.sh。

import { beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { blindIndex, encryptField } from '../crypto/field-crypto.ts'
import {
  ISSUE_UPSERT_SQL,
  PROJECTION_SELECT_SQL,
  RECONCILE_INSERT_SQL,
  RENAME_UPDATE_SQL,
  REVOKE_UPDATE_SQL,
  RegistryGateError,
  issueToken as issueTokenDirect,
  reconcileRegistry as reconcileRegistryDirect,
  renameToken as renameTokenDirect,
  revokeTokens as revokeTokensDirect,
  serializeRegistry,
  tokenEncCtx,
  type RegistryDeps,
  type RegistryEntry,
  type RegistryFileIo,
} from './token-registry.ts'
import {
  createMountedDeps,
  issueToken,
  reconcileRegistry,
  renameToken,
  revokeTokens,
} from './registry-mount.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

// ─────────────────────────────────────────────────────────────────────────
// 測試金鑰（真加密、真解密——與 token-registry.test.ts 同一套慣例）
// ─────────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.MON_FIELD_KEY_V1 = randomBytes(32).toString('base64')
  process.env.MON_BIDX_KEY = randomBytes(32).toString('base64')
})

// ─────────────────────────────────────────────────────────────────────────
// fixture 路徑（白名單以 deps.registryFiles 覆寫；正式 9 路完全不被觸及）
// ─────────────────────────────────────────────────────────────────────────

const ADMIN_DEFAULT = '/fixtures/aladdin-admin/tokens.json'
const FIXTURE_FILES = [ADMIN_DEFAULT] as const

const SERVER = 'aladdin-admin'
const ENV_DEFAULT = 'default'

const NOW = () => new Date('2026-09-02T03:04:05.678Z')

function entry(id: string, token: string, displayName: string | null, issuedAt: string): RegistryEntry {
  return { id, token, display_name: displayName, issued_at: issuedAt }
}

const ALICE = entry('alice', 'tok-alice-aaaaaaaaaaaaaaaaaaaaaaaa', '企劃小A', '2026-01-01T00:00:00.000Z')
const BOB = entry('bob', 'tok-bob-bbbbbbbbbbbbbbbbbbbbbbbbbb', '企劃小B', '2026-02-02T00:00:00.000Z')

// ─────────────────────────────────────────────────────────────────────────
// 假檔案層 / 假 mcp_tokens 表（複製自 token-registry.test.ts 的最小子集）
// ─────────────────────────────────────────────────────────────────────────

class FakeIo implements RegistryFileIo {
  files = new Map<string, string>()
  writes: { path: string; content: string }[] = []
  backupSeq = 0

  exists(path: string): boolean {
    return this.files.has(path)
  }

  read(path: string): string {
    const v = this.files.get(path)
    if (v === undefined) throw new Error(`FakeIo: 檔案不存在 ${path}`)
    return v
  }

  backup(srcPath: string, type: string): string {
    const dest = `/backups/${type}/${++this.backupSeq}`
    this.files.set(dest, this.files.get(srcPath)!)
    return dest
  }

  writeAtomic(path: string, content: string): void {
    this.writes.push({ path, content })
    this.files.set(path, content)
  }
}

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

  private find(server: string, env: string, id: string): FakeRow | undefined {
    return this.rows.find((r) => r.server === server && r.env === env && r.token_id === id)
  }

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
      const existing = this.find(server, env, token_id)
      if (existing) {
        if (isReconcile) return [{ affectedRows: 0 } as unknown as T, undefined]
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

interface Harness {
  io: FakeIo
  db: FakeMcpTokensDb
  baseDeps: Omit<RegistryDeps, 'alert'>
}

function makeHarness(entries: RegistryEntry[]): Harness {
  const io = new FakeIo()
  const db = new FakeMcpTokensDb()
  io.files.set(ADMIN_DEFAULT, serializeRegistry(entries))
  for (const e of entries) db.seed(SERVER, ENV_DEFAULT, e)
  return {
    io,
    db,
    baseDeps: {
      executor: db,
      io,
      now: NOW,
      registryFiles: FIXTURE_FILES,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (a) 預設掛載：閘門中止 → fake notify 恰一次，訊息含前綴、不含 token 明文
// ─────────────────────────────────────────────────────────────────────────

describe('預設掛載：閘門中止時的告警行為', () => {
  test('DB 塞假列 + 合法 rename → 中止；notify 恰一次，訊息含前綴且不含任何 token 明文', async () => {
    const h = makeHarness([ALICE, BOB])
    const forged = entry('mallory', 'FORGED-TOKEN-VALUE-DO-NOT-PROJECT', '偽造者', '2026-03-03T00:00:00.000Z')
    h.db.seed(SERVER, ENV_DEFAULT, forged)

    const notifyCalls: string[] = []
    const fakeNotify = (text: string): boolean => {
      notifyCalls.push(text)
      return true
    }

    let caught: unknown
    try {
      await renameToken(
        { op: 'rename', id: 'alice', newName: '改名', server: SERVER, env: ENV_DEFAULT },
        { ...h.baseDeps, alert: createMountedDeps({}, fakeNotify).alert },
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RegistryGateError)
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]).toContain('🔐 token-registry')
    expect(notifyCalls[0]).toContain('mallory') // token_id 可以出現
    expect(notifyCalls[0]).not.toContain(forged.token)
    expect(notifyCalls[0]).not.toContain(ALICE.token)
    expect(notifyCalls[0]).not.toContain(BOB.token)
  })

  test('未帶 deps 時直接呼叫掛載層四支函式，預設也會走同一條 alert 邏輯（用 createMountedDeps 顯式驗證）', () => {
    const notifyCalls: string[] = []
    const mounted = createMountedDeps({}, (t) => {
      notifyCalls.push(t)
      return true
    })
    expect(mounted.alert).toBeDefined()
    mounted.alert!('測試訊息')
    expect(notifyCalls).toEqual(['🔐 token-registry: 測試訊息'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (b) 呼叫端自帶 alert → 不覆蓋，notify 零呼叫
// ─────────────────────────────────────────────────────────────────────────

describe('呼叫端自帶 alert：掛載層不覆蓋', () => {
  test('createMountedDeps 對已帶 alert 的 deps 原樣返回（同一個函式參考）', () => {
    const notifyCalls: string[] = []
    const fakeNotify = (t: string): boolean => {
      notifyCalls.push(t)
      return true
    }
    const ownAlerts: string[] = []
    const deps: RegistryDeps = { alert: (m) => ownAlerts.push(m) }
    const mounted = createMountedDeps(deps, fakeNotify)
    expect(mounted.alert).toBe(deps.alert)
  })

  test('端到端：呼叫端自帶 alert 時，閘門中止只打呼叫端的 alert，notify 零呼叫', async () => {
    const h = makeHarness([ALICE, BOB])
    h.db.seed(SERVER, ENV_DEFAULT, entry('mallory', 'FORGED', 'M', '2026-03-03T00:00:00.000Z'))

    const notifyCalls: string[] = []
    const fakeNotify = (t: string): boolean => {
      notifyCalls.push(t)
      return true
    }
    const ownAlerts: string[] = []

    await expect(
      revokeTokens(
        { op: 'revoke', ids: ['bob'], server: SERVER, env: ENV_DEFAULT },
        { ...h.baseDeps, alert: (m) => ownAlerts.push(m) },
      ),
    ).rejects.toThrow(RegistryGateError)

    expect(ownAlerts).toHaveLength(1)
    expect(notifyCalls).toEqual([]) // 掛載層完全沒接手，fake notify 零呼叫
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (c) 四支函式透傳行為：回傳值與直接呼叫 token-registry 一致
// ─────────────────────────────────────────────────────────────────────────

describe('透傳行為：掛載層回傳值與直接呼叫 token-registry 一致', () => {
  test('issueToken：相同 intent/deps（固定 generateToken/now）→ 回傳值逐欄相等', async () => {
    const hMounted = makeHarness([ALICE, BOB])
    const hDirect = makeHarness([ALICE, BOB])
    const intent = { op: 'issue' as const, server: SERVER, env: ENV_DEFAULT, newId: 'carol', displayName: '企劃小C' }
    const generateToken = () => 'fixed-test-token-value'

    const resMounted = await issueToken(intent, { ...hMounted.baseDeps, generateToken, alert: () => {} })
    const resDirect = await issueTokenDirect(intent, { ...hDirect.baseDeps, generateToken, alert: () => {} })

    expect(resMounted).toEqual(resDirect)
  })

  test('revokeTokens：回傳值一致', async () => {
    const hMounted = makeHarness([ALICE, BOB])
    const hDirect = makeHarness([ALICE, BOB])
    const intent = { op: 'revoke' as const, ids: ['bob'], server: SERVER, env: ENV_DEFAULT }

    const resMounted = await revokeTokens(intent, { ...hMounted.baseDeps, alert: () => {} })
    const resDirect = await revokeTokensDirect(intent, { ...hDirect.baseDeps, alert: () => {} })

    expect(resMounted).toEqual(resDirect)
  })

  test('renameToken：回傳值一致', async () => {
    const hMounted = makeHarness([ALICE, BOB])
    const hDirect = makeHarness([ALICE, BOB])
    const intent = { op: 'rename' as const, id: 'alice', newName: '改過的名字', server: SERVER, env: ENV_DEFAULT }

    const resMounted = await renameToken(intent, { ...hMounted.baseDeps, alert: () => {} })
    const resDirect = await renameTokenDirect(intent, { ...hDirect.baseDeps, alert: () => {} })

    expect(resMounted).toEqual(resDirect)
  })

  test('reconcileRegistry：回傳值一致（恆等變換，皆 written=[]）', async () => {
    const hMounted = makeHarness([ALICE, BOB])
    const hDirect = makeHarness([ALICE, BOB])
    const intent = { op: 'reconcile' as const, server: SERVER, env: ENV_DEFAULT }

    const resMounted = await reconcileRegistry(intent, { ...hMounted.baseDeps, alert: () => {} })
    const resDirect = await reconcileRegistryDirect(intent, { ...hDirect.baseDeps, alert: () => {} })

    expect(resMounted).toEqual(resDirect)
  })
})
