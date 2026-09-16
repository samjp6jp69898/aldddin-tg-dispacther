// lib/registry/tech-users-sync.test.ts — 名冊 CLI 單元測試。
//
// 不打真實 DB：DB 存取抽象成 MonitorDbExecutor，測試注入一個極簡的假 executor
// （在本檔內以 SQL 前綴比對模擬 tech_users 表；SQL 文字由本檔生產程式碼自己
// 撰寫，前綴穩定可預期）。加密走隨機測試金鑰實跑
// encryptField/blindIndex/decryptField。
//
// 2026-09-16（Phase 6：tech-users.csv 退役）：原本涵蓋 CSV 路徑的測試
// （applySetToContent / applyUnsetToContent / --reconcile / flag off 分支 /
// 49 列 CSV fixture）隨那些程式碼一起刪除——不留「測試還在測一個已經不存在
// 的來源」的殘骸。新增的是名冊四欄讀寫（--list-roster / --upsert-user /
// --remove-user），也就是 CSV 被刪掉後接手它職責的那條路。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  parseCliArgs,
  runCheckConnected,
  runCli,
  runListConnected,
  runListRoster,
  runMove,
  runRemoveUser,
  runRepairBidx,
  runResolveChatId,
  runSet,
  runUnset,
  runUpsertUser,
  TECH_USER_BIDX_SCOPE,
  type RunDeps,
} from './tech-users-sync.ts'
import { blindIndex, encryptField } from '../crypto/field-crypto.ts'
import { decryptField } from '../crypto/roster-decrypt.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

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

function row(email: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    email,
    notion_user_name: `name-${email}`,
    notion_user_id: `uid-${email}`,
    pushed_repos: 'abu;rajah',
    tg_chat_id_enc: null,
    tg_chat_id_bidx: null,
    bidx_key_ver: null,
    ...overrides,
  }
}

/** 建一列「已連接」的 fixture（用當下的測試金鑰真的加密 + 算盲索引）。 */
function connectedRow(email: string, chatId: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return row(email, {
    tg_chat_id_enc: encryptField(`tech_users.tg_chat_id:${email}`, chatId),
    tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, chatId),
    bidx_key_ver: 1,
    ...overrides,
  })
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

      if (s.startsWith('SELECT notion_user_name, notion_user_id, email, pushed_repos FROM tech_users ORDER BY email')) {
        return [
          Array.from(rows.values())
            .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
            .map((r) => ({
              notion_user_name: r.notion_user_name,
              notion_user_id: r.notion_user_id,
              email: r.email,
              pushed_repos: r.pushed_repos,
            })) as unknown as T,
          undefined,
        ]
      }
      if (s.startsWith('SELECT email FROM tech_users WHERE email = ?')) {
        const email = params[0] as string
        const found = rows.get(email)
        return [(found ? [{ email: found.email }] : []) as unknown as T, undefined]
      }
      if (s.startsWith('SELECT email, tg_chat_id_enc FROM tech_users')) {
        return [
          Array.from(rows.values()).map((r) => ({ email: r.email, tg_chat_id_enc: r.tg_chat_id_enc })) as unknown as T,
          undefined,
        ]
      }
      if (s.startsWith('SELECT tg_chat_id_enc FROM tech_users WHERE email = ?')) {
        const email = params[0] as string
        const found = rows.get(email)
        return [(found ? [{ tg_chat_id_enc: found.tg_chat_id_enc }] : []) as unknown as T, undefined]
      }
      if (s.startsWith('SELECT email, tg_chat_id_enc, tg_chat_id_bidx FROM tech_users')) {
        return [
          Array.from(rows.values())
            .filter((r) => r.tg_chat_id_enc !== null)
            .map((r) => ({ email: r.email, tg_chat_id_enc: r.tg_chat_id_enc, tg_chat_id_bidx: r.tg_chat_id_bidx })) as unknown as T,
          undefined,
        ]
      }
      if (s.startsWith('UPDATE tech_users SET tg_chat_id_bidx = ?, bidx_key_ver = ? WHERE email = ?')) {
        const [bidx, ver, email] = params as [Buffer | null, number | null, string]
        const existing = rows.get(email)
        if (existing) rows.set(email, { ...existing, tg_chat_id_bidx: bidx, bidx_key_ver: ver })
        return [{ affectedRows: 1 } as unknown as T, undefined]
      }
      if (s.startsWith('SELECT 1 AS x FROM tech_users WHERE tg_chat_id_bidx = ?')) {
        const bidx = params[0] as Buffer
        const found = Array.from(rows.values()).some((r) => r.tg_chat_id_bidx && bidx && r.tg_chat_id_bidx.equals(bidx))
        return [(found ? [{ x: 1 }] : []) as unknown as T, undefined]
      }
      if (s.startsWith('INSERT INTO tech_users') && s.includes('ON DUPLICATE KEY UPDATE')) {
        const [email, notion_user_name, notion_user_id, pushed_repos] = params as [string, string, string, string]
        const existing = rows.get(email)
        if (existing) {
          rows.set(email, { ...existing, notion_user_name, notion_user_id, pushed_repos })
        } else {
          rows.set(email, row(email, { notion_user_name, notion_user_id, pushed_repos }))
        }
        return [{ affectedRows: 1 } as unknown as T, undefined]
      }
      if (s.startsWith('DELETE FROM tech_users WHERE email = ?')) {
        const [email] = params as [string]
        rows.delete(email)
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

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return { dryRun: false, executor: null, ...overrides }
}

// ─────────────────────────────────────────────────────────────────────────
// 名冊四欄：--list-roster / --upsert-user / --remove-user
// （tech-users.csv 退役後，接手「名冊從哪來、怎麼增修」的那條路）
// ─────────────────────────────────────────────────────────────────────────

describe('runListRoster：四個非敏感欄位，依 email 排序，絕不含 chat_id', () => {
  test('輸出 header + 每列純逗號切分，順序為 name,notion_id,email,repos', async () => {
    const { executor } = makeFakeExecutor([
      connectedRow('b@example.test', '700000001', { notion_user_name: 'Bee', notion_user_id: 'uid-b', pushed_repos: 'abu;lago' }),
      row('a@example.test', { notion_user_name: 'Ay', notion_user_id: 'uid-a', pushed_repos: '' }),
    ])
    const out = await runListRoster(deps({ executor }))
    expect(out[0]).toBe('notion_user_name,notion_user_id,email,pushed_repos')
    expect(out[1]).toBe('Ay,uid-a,a@example.test,')
    expect(out[2]).toBe('Bee,uid-b,b@example.test,abu;lago')
    // 已連接的那列也不得洩漏任何 chat_id 痕跡。
    expect(out.join('\n')).not.toContain('700000001')
  })

  test('DB 欄位值含逗號（有人繞過本 CLI 直接改 DB）→ fail loud，不吐會被切錯欄的名冊', async () => {
    const { executor } = makeFakeExecutor([row('x@example.test', { notion_user_name: 'Lo, Landon' })])
    await expect(runListRoster(deps({ executor }))).rejects.toThrow(/無法安全切分/)
  })

  test('--dry-run：零 DB 呼叫', async () => {
    const { executor, calls } = makeFakeExecutor([row('a@example.test')])
    const out = await runListRoster(deps({ executor, dryRun: true }))
    expect(out[0]).toContain('LIST_ROSTER_DRYRUN')
    expect(calls.length).toBe(0)
  })
})

describe('runUpsertUser：名冊增修（取代「手改 CSV 一列 + --reconcile」）', () => {
  test('新 email → 建列；既有 email → 覆寫三欄但不動 tg_chat_id（連接不因改名冊而斷）', async () => {
    const { executor, rows } = makeFakeExecutor([connectedRow('old@example.test', '700000002')])
    const encBefore = rows.get('old@example.test')!.tg_chat_id_enc

    expect(await runUpsertUser({ email: 'new@example.test', notion_user_name: 'New Guy', notion_user_id: 'uid-new', pushed_repos: 'abu' }, deps({ executor }))).toEqual([
      'UPSERT_OK: new@example.test',
    ])
    expect(rows.get('new@example.test')?.notion_user_id).toBe('uid-new')
    expect(rows.get('new@example.test')?.tg_chat_id_enc).toBeNull()

    expect(await runUpsertUser({ email: 'old@example.test', notion_user_name: 'Renamed', notion_user_id: 'uid-old2', pushed_repos: 'lago' }, deps({ executor }))).toEqual([
      'UPSERT_OK: old@example.test',
    ])
    const after = rows.get('old@example.test')!
    expect(after.notion_user_name).toBe('Renamed')
    expect(after.notion_user_id).toBe('uid-old2')
    expect(after.pushed_repos).toBe('lago')
    expect(after.tg_chat_id_enc).toBe(encBefore)
  })

  test('欄位值含逗號／雙引號／換行 → 拒絕（讓 --list-roster 的輸出永遠可被純逗號切分）', async () => {
    const { executor, calls } = makeFakeExecutor()
    const out = await runUpsertUser({ email: 'x@example.test', notion_user_name: 'Lo, Landon', notion_user_id: 'uid', pushed_repos: '' }, deps({ executor }))
    expect(out[0]).toBe('UPSERT_ERR_BAD_FIELD: notion_user_name 不得含逗號／雙引號／換行')
    expect(calls.length).toBe(0)
  })

  test('email 為空 → ERR_ARGS，不呼叫 DB', async () => {
    const { executor, calls } = makeFakeExecutor()
    const out = await runUpsertUser({ email: '', notion_user_name: 'n', notion_user_id: 'i', pushed_repos: '' }, deps({ executor }))
    expect(out[0]).toContain('UPSERT_ERR_ARGS')
    expect(calls.length).toBe(0)
  })

  test('--dry-run：零 DB 呼叫', async () => {
    const { executor, calls } = makeFakeExecutor()
    const out = await runUpsertUser({ email: 'x@example.test', notion_user_name: 'n', notion_user_id: 'i', pushed_repos: '' }, deps({ executor, dryRun: true }))
    expect(out[0]).toContain('UPSERT_DRYRUN')
    expect(calls.length).toBe(0)
  })
})

describe('runRemoveUser：離職者下架', () => {
  test('未連接的列 → 直接刪除', async () => {
    const { executor, rows } = makeFakeExecutor([row('gone@example.test')])
    expect(await runRemoveUser('gone@example.test', false, deps({ executor }))).toEqual(['REMOVE_OK: gone@example.test'])
    expect(rows.has('gone@example.test')).toBe(false)
  })

  test('仍連接中且未 --force → CONFLICT，不刪（手滑打錯 email 的防線）', async () => {
    const { executor, rows } = makeFakeExecutor([connectedRow('still@example.test', '700000003')])
    const out = await runRemoveUser('still@example.test', false, deps({ executor }))
    expect(out[0]).toContain('REMOVE_CONFLICT')
    expect(rows.has('still@example.test')).toBe(true)
    expect(out.join('\n')).not.toContain('700000003')
  })

  test('仍連接中 + --force → 刪除', async () => {
    const { executor, rows } = makeFakeExecutor([connectedRow('leaver@example.test', '700000004')])
    expect(await runRemoveUser('leaver@example.test', true, deps({ executor }))).toEqual(['REMOVE_OK: leaver@example.test'])
    expect(rows.has('leaver@example.test')).toBe(false)
  })

  test('email 不存在 → ERR_NO_EMAIL', async () => {
    const { executor } = makeFakeExecutor()
    const out = await runRemoveUser('nobody@example.test', false, deps({ executor }))
    expect(out[0]).toContain('REMOVE_ERR_NO_EMAIL')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// tg_chat_id 寫入
// ─────────────────────────────────────────────────────────────────────────

describe('runSet：名冊列必須先存在，且不靜默換掉既有連接', () => {
  test('DB 名冊無此 email → SET_ERR_NO_EMAIL，不自創殘缺列', async () => {
    const { executor, calls } = makeFakeExecutor()
    const out = await runSet('ghost@example.test', '700000005', false, deps({ executor }))
    expect(out[0]).toContain('SET_ERR_NO_EMAIL')
    expect(calls.some((c) => /INSERT|UPDATE/.test(c.sql))).toBe(false)
  })

  test('chat_id 格式不合法 → SET_ERR_BAD_CHATID，不呼叫 DB', async () => {
    const { executor, calls } = makeFakeExecutor([row('a@example.test')])
    const out = await runSet('a@example.test', 'abc', false, deps({ executor }))
    expect(out).toEqual(['SET_ERR_BAD_CHATID: a@example.test'])
    expect(calls.length).toBe(0)
  })

  test('未連接的列 → 加密寫入三欄，且輸出不含明碼', async () => {
    const { executor, rows } = makeFakeExecutor([row('a@example.test')])
    const out = await runSet('a@example.test', '700000006', false, deps({ executor }))
    expect(out).toEqual(['SET_OK: a@example.test'])
    const saved = rows.get('a@example.test')!
    expect(decryptField('tech_users.tg_chat_id:a@example.test', saved.tg_chat_id_enc!)).toBe('700000006')
    expect(saved.tg_chat_id_bidx!.equals(blindIndex(TECH_USER_BIDX_SCOPE, '700000006')!)).toBe(true)
    expect(saved.bidx_key_ver).toBe(1)
    expect(out.join('\n')).not.toContain('700000006')
  })

  test('已連接同一個 chat_id → NOOP，不寫入', async () => {
    const { executor, calls } = makeFakeExecutor([connectedRow('a@example.test', '700000007')])
    const out = await runSet('a@example.test', '700000007', false, deps({ executor }))
    expect(out[0]).toContain('SET_NOOP')
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  test('已連接不同 chat_id 且未 --force → CONFLICT，不寫入', async () => {
    const { executor, calls } = makeFakeExecutor([connectedRow('a@example.test', '700000008')])
    const out = await runSet('a@example.test', '700000009', false, deps({ executor }))
    expect(out[0]).toContain('SET_CONFLICT')
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
    expect(out.join('\n')).not.toContain('700000008')
  })

  test('已連接不同 chat_id + --force → 換成新值', async () => {
    const { executor, rows } = makeFakeExecutor([connectedRow('a@example.test', '700000010')])
    const out = await runSet('a@example.test', '700000011', true, deps({ executor }))
    expect(out).toEqual(['SET_OK: a@example.test'])
    expect(decryptField('tech_users.tg_chat_id:a@example.test', rows.get('a@example.test')!.tg_chat_id_enc!)).toBe('700000011')
  })

  test('--dry-run：零 DB 呼叫', async () => {
    const { executor, calls } = makeFakeExecutor([row('a@example.test')])
    const out = await runSet('a@example.test', '700000012', false, deps({ executor, dryRun: true }))
    expect(out[0]).toContain('SET_DRYRUN')
    expect(calls.length).toBe(0)
  })
})

describe('runUnset：釋出 UNIQUE（enc/bidx/bidx_key_ver 三欄同進退）', () => {
  test('既有連接 → 三欄全 NULL', async () => {
    const { executor, rows, calls } = makeFakeExecutor([connectedRow('a@example.test', '700000013')])
    expect(await runUnset('a@example.test', deps({ executor }))).toEqual(['UNSET_OK: a@example.test'])
    const saved = rows.get('a@example.test')!
    expect(saved.tg_chat_id_enc).toBeNull()
    expect(saved.tg_chat_id_bidx).toBeNull()
    expect(saved.bidx_key_ver).toBeNull()
    const update = calls.find((c) => c.sql.startsWith('UPDATE'))!
    expect(update.sql).toContain('tg_chat_id_enc = NULL, tg_chat_id_bidx = NULL, bidx_key_ver = NULL')
    expect(update.params).toEqual(['a@example.test'])
  })

  test('已無 chat_id → NOOP', async () => {
    const { executor } = makeFakeExecutor([row('a@example.test')])
    expect((await runUnset('a@example.test', deps({ executor })))[0]).toContain('UNSET_NOOP')
  })

  test('DB 名冊無此 email → ERR_NO_EMAIL', async () => {
    const { executor } = makeFakeExecutor()
    expect((await runUnset('ghost@example.test', deps({ executor })))[0]).toContain('UNSET_ERR_NO_EMAIL')
  })

  test('--dry-run：零 DB 呼叫', async () => {
    const { executor, calls } = makeFakeExecutor([connectedRow('a@example.test', '700000014')])
    const out = await runUnset('a@example.test', deps({ executor, dryRun: true }))
    expect(out[0]).toContain('UNSET_DRYRUN')
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 連接狀態查詢
// ─────────────────────────────────────────────────────────────────────────

describe('runListConnected：只列 email，不含 chat_id', () => {
  test('tg_chat_id_enc 非 NULL 的 email 才列入', async () => {
    const { executor } = makeFakeExecutor([connectedRow('yes@example.test', '700000015'), row('no@example.test')])
    const out = await runListConnected(deps({ executor }))
    expect(out).toEqual(['CONNECTED: yes@example.test'])
    expect(out.join('\n')).not.toContain('700000015')
  })
})

describe('runCheckConnected：依輸入順序回報，不迴響 chat_id', () => {
  test('命中／未命中／格式不合法三種輸入混合，順序對應輸入', async () => {
    const { executor } = makeFakeExecutor([connectedRow('a@example.test', '700000016')])
    const out = await runCheckConnected(['700000016', '999999999', 'not-a-number'], deps({ executor }))
    expect(out).toEqual(['CONNECTED', 'NOT_CONNECTED', 'NOT_CONNECTED'])
  })

  test('空清單 → 回空陣列，不呼叫 DB', async () => {
    const { executor, calls } = makeFakeExecutor()
    expect(await runCheckConnected([], deps({ executor }))).toEqual([])
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// runMove / runResolveChatId / runRepairBidx
// ─────────────────────────────────────────────────────────────────────────

describe('runMove：換綁 tg_chat_id 到另一個 email（解密舊 AAD、重新加密成新 AAD）', () => {
  test('舊列清空、新列拿到同一個明碼值重新加密，bidx 不變', async () => {
    const chatId = '700000017'
    const { executor, rows } = makeFakeExecutor([connectedRow('old@example.test', chatId), row('new@example.test')])
    const bidxBefore = rows.get('old@example.test')!.tg_chat_id_bidx!

    const out = await runMove('old@example.test', 'new@example.test', deps({ executor }))
    expect(out).toEqual(['MOVE_OK: old@example.test -> new@example.test'])

    const oldAfter = rows.get('old@example.test')!
    expect(oldAfter.tg_chat_id_enc).toBeNull()
    expect(oldAfter.tg_chat_id_bidx).toBeNull()
    expect(oldAfter.bidx_key_ver).toBeNull()

    const newAfter = rows.get('new@example.test')!
    expect(decryptField('tech_users.tg_chat_id:new@example.test', newAfter.tg_chat_id_enc!)).toBe(chatId)
    expect(newAfter.tg_chat_id_bidx!.equals(bidxBefore)).toBe(true)
    expect(out.join('\n')).not.toContain(chatId)
  })

  test('舊 email 目前沒有連接 → MOVE_ERR_NOT_CONNECTED，不寫任何 SQL', async () => {
    const { executor, calls } = makeFakeExecutor([row('old@example.test'), row('new@example.test')])
    const out = await runMove('old@example.test', 'new@example.test', deps({ executor }))
    expect(out[0]).toContain('MOVE_ERR_NOT_CONNECTED')
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  test('目的 email 已經連接別的 chat_id → MOVE_ERR_TARGET_CONNECTED', async () => {
    const { executor, calls } = makeFakeExecutor([
      connectedRow('old@example.test', '700000018'),
      connectedRow('new@example.test', '700000019'),
    ])
    const out = await runMove('old@example.test', 'new@example.test', deps({ executor }))
    expect(out[0]).toContain('MOVE_ERR_TARGET_CONNECTED')
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  test('目的 email 不在名冊 → MOVE_ERR_NO_EMAIL', async () => {
    const { executor } = makeFakeExecutor([connectedRow('old@example.test', '700000020')])
    const out = await runMove('old@example.test', 'ghost@example.test', deps({ executor }))
    expect(out[0]).toContain('MOVE_ERR_NO_EMAIL')
  })

  test('新舊信箱相同 → MOVE_ERR_ARGS，不呼叫 DB', async () => {
    const { executor, calls } = makeFakeExecutor()
    expect(await runMove('a@example.test', 'a@example.test', deps({ executor }))).toEqual(['MOVE_ERR_ARGS: 新舊信箱相同'])
    expect(calls.length).toBe(0)
  })

  test('舊列密文損毀（AAD 不符）→ MOVE_ERR_DECRYPT_FAILED，不執行任何 UPDATE', async () => {
    const { executor, calls } = makeFakeExecutor([
      // 用別人的 AAD 加密：解得開金鑰但 AAD 對不上 → decryptField throw。
      row('old@example.test', {
        tg_chat_id_enc: encryptField('tech_users.tg_chat_id:someone-else@example.test', '700000021'),
        tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, '700000021'),
        bidx_key_ver: 1,
      }),
      row('new@example.test'),
    ])
    const out = await runMove('old@example.test', 'new@example.test', deps({ executor }))
    expect(out[0]).toContain('MOVE_ERR_DECRYPT_FAILED')
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  test('--dry-run：零 DB 呼叫', async () => {
    const { executor, calls } = makeFakeExecutor([connectedRow('old@example.test', '700000022'), row('new@example.test')])
    const out = await runMove('old@example.test', 'new@example.test', deps({ executor, dryRun: true }))
    expect(out[0]).toContain('MOVE_DRYRUN')
    expect(calls.length).toBe(0)
  })
})

describe('runResolveChatId：唯一刻意回傳明碼的指令，給 tg-notify.sh 用', () => {
  test('找到列且有 chat_id → RESOLVE_OK 帶明碼', async () => {
    const { executor } = makeFakeExecutor([connectedRow('a@example.test', '700000023')])
    expect(await runResolveChatId('a@example.test', deps({ executor }))).toEqual(['RESOLVE_OK: 700000023'])
  })

  test('email 不在名冊 → RESOLVE_ERR_NOT_TECH', async () => {
    const { executor } = makeFakeExecutor()
    expect((await runResolveChatId('ghost@example.test', deps({ executor })))[0]).toContain('RESOLVE_ERR_NOT_TECH')
  })

  test('列存在但沒有 chat_id → RESOLVE_ERR_NO_CHATID', async () => {
    const { executor } = makeFakeExecutor([row('a@example.test')])
    expect((await runResolveChatId('a@example.test', deps({ executor })))[0]).toContain('RESOLVE_ERR_NO_CHATID')
  })

  test('密文 AAD 不符 → RESOLVE_ERR_DECRYPT_FAILED', async () => {
    const { executor } = makeFakeExecutor([
      row('a@example.test', { tg_chat_id_enc: encryptField('tech_users.tg_chat_id:other@example.test', '700000024') }),
    ])
    expect((await runResolveChatId('a@example.test', deps({ executor })))[0]).toContain('RESOLVE_ERR_DECRYPT_FAILED')
  })
})

describe('runRepairBidx：用目前金鑰解密＋重算 bidx，明碼與 bidx 都不出現在輸出', () => {
  test('bidx 不符 → 重算並寫回；bidx 已正確 → 跳過不寫；解密失敗 → 記錄繼續、不中止整批', async () => {
    const good = connectedRow('good@example.test', '700000025')
    const stale = connectedRow('stale@example.test', '700000026', { tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, '999999999') })
    const broken = row('broken@example.test', {
      tg_chat_id_enc: encryptField('tech_users.tg_chat_id:other@example.test', '700000027'),
      tg_chat_id_bidx: blindIndex(TECH_USER_BIDX_SCOPE, '700000027'),
      bidx_key_ver: 1,
    })
    const { executor, rows } = makeFakeExecutor([good, stale, broken])

    const out = await runRepairBidx(deps({ executor }))
    expect(out[0]).toBe('REPAIR_BIDX_OK: checked=3 repaired=1 unchanged=1 failed=1')
    expect(out[1]).toBe('REPAIR_BIDX_DECRYPT_FAILED: broken@example.test')
    expect(rows.get('stale@example.test')!.tg_chat_id_bidx!.equals(blindIndex(TECH_USER_BIDX_SCOPE, '700000026')!)).toBe(true)
    expect(out.join('\n')).not.toContain('700000026')
  })

  test('沒有任何 tg_chat_id_enc 非空的列 → checked=0，零寫入', async () => {
    const { executor, calls } = makeFakeExecutor([row('a@example.test')])
    const out = await runRepairBidx(deps({ executor }))
    expect(out).toEqual(['REPAIR_BIDX_OK: checked=0 repaired=0 unchanged=0 failed=0'])
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  test('--dry-run → 零 DB 呼叫', async () => {
    const { executor, calls } = makeFakeExecutor([connectedRow('a@example.test', '700000028')])
    const out = await runRepairBidx(deps({ executor, dryRun: true }))
    expect(out[0]).toContain('REPAIR_BIDX_DRYRUN')
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// CLI 參數解析與分派
// ─────────────────────────────────────────────────────────────────────────

describe('parseCliArgs / runCli', () => {
  test('--set / --unset / --move / --resolve-chat-id 位置參數', () => {
    expect(parseCliArgs(['--set', 'a@b.test', '123', '--force'])).toMatchObject({ mode: 'set', email: 'a@b.test', chatId: '123', force: true })
    expect(parseCliArgs(['--unset', 'a@b.test'])).toMatchObject({ mode: 'unset', email: 'a@b.test' })
    expect(parseCliArgs(['--move', 'a@b.test', 'c@d.test'])).toMatchObject({ mode: 'move', email: 'a@b.test', newEmail: 'c@d.test' })
    expect(parseCliArgs(['--resolve-chat-id', 'a@b.test'])).toMatchObject({ mode: 'resolve-chat-id', email: 'a@b.test' })
  })

  test('--upsert-user 四個位置參數，pushed_repos 可省略', () => {
    expect(parseCliArgs(['--upsert-user', 'a@b.test', 'Name', 'uid-1', 'abu;rajah'])).toMatchObject({
      mode: 'upsert-user',
      email: 'a@b.test',
      rosterName: 'Name',
      rosterNotionId: 'uid-1',
      rosterRepos: 'abu;rajah',
    })
    expect(parseCliArgs(['--upsert-user', 'a@b.test', 'Name', 'uid-1'])).toMatchObject({ mode: 'upsert-user', rosterRepos: undefined })
  })

  test('--remove-user / --list-roster', () => {
    expect(parseCliArgs(['--remove-user', 'a@b.test', '--force'])).toMatchObject({ mode: 'remove-user', email: 'a@b.test', force: true })
    expect(parseCliArgs(['--list-roster'])).toMatchObject({ mode: 'list-roster' })
  })

  test('--check-connected 吞掉後面所有 args', () => {
    expect(parseCliArgs(['--check-connected', '1', '2', '3'])).toMatchObject({ mode: 'check-connected', checkChatIds: ['1', '2', '3'] })
  })

  test('已退役的 --csv / --reconcile 變成未知參數（不會靜默被當成別的東西）', () => {
    expect(parseCliArgs(['--reconcile']).errors[0]).toContain('未知參數: --reconcile')
    expect(parseCliArgs(['--csv', '/tmp/x.csv']).errors[0]).toContain('未知參數: --csv')
  })

  test('無模式 → usage', async () => {
    const out = await runCli([], { executor: null })
    expect(out[0]).toContain('usage: tech-users-sync.ts')
    expect(out[0]).toContain('--list-roster')
  })

  test('runCli 把 --upsert-user 的位置參數送進 runUpsertUser', async () => {
    const { executor, rows } = makeFakeExecutor()
    const out = await runCli(['--upsert-user', 'a@b.test', 'Name', 'uid-1', 'abu'], { executor })
    expect(out).toEqual(['UPSERT_OK: a@b.test'])
    expect(rows.get('a@b.test')).toMatchObject({ notion_user_name: 'Name', notion_user_id: 'uid-1', pushed_repos: 'abu' })
  })

  test('runCli --upsert-user 缺參數 → ERR_ARGS', async () => {
    const out = await runCli(['--upsert-user', 'a@b.test'], { executor: null })
    expect(out[0]).toContain('UPSERT_ERR_ARGS')
  })
})
