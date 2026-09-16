// lib/user-resolution/tech-user.test.ts
//
// 這個模組原本完全沒有專屬單元測試（resolveTechUserByChatId 只被
// whitelist.test.ts 等透過 registerHandlers 間接測到 happy path）。這裡補上
// 直接測試，特別是 review 點名「DB 不可用」的 fail-closed 路徑——池建立失敗
// 與查詢本身失敗是兩種不同故障模式，都必須讓名冊查詢視為找不到，不能讓
// 例外往外傳。
//
// 2026-09-16（Phase 6：tech-users.csv 退役）：原本 flag off 讀真實 CSV 的那
// 組測試連同該路徑一起刪除；resolveTechUserByEmail 也從「讀 CSV 的同步函式」
// 變成查 DB 的 async 函式，測試比照 chat_id 那組注入假 executor。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { blindIndex } from '../crypto/field-crypto.ts'
import { __resetMonitorTestOverrides, __setMonitorTestOverrides } from '../monitor-db/runtime.ts'
import { TECH_USER_BIDX_SCOPE } from '../registry/tech-users-sync.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'
import { resolveTechUserByChatId, resolveTechUserByEmail } from './tech-user.ts'

const ORIG_MON_BIDX_KEY = process.env.MON_BIDX_KEY

beforeEach(() => {
  process.env.MON_BIDX_KEY = Buffer.from('0'.repeat(64), 'hex').toString('base64')
})

afterEach(() => {
  if (ORIG_MON_BIDX_KEY === undefined) delete process.env.MON_BIDX_KEY
  else process.env.MON_BIDX_KEY = ORIG_MON_BIDX_KEY
  __resetMonitorTestOverrides()
})

describe('resolveTechUserByChatId：查 tg_chat_id_bidx', () => {
  test('bidx 命中 → 回傳對應使用者', async () => {
    const chatId = '700000010'
    const bidx = blindIndex(TECH_USER_BIDX_SCOPE, chatId)
    const fakeExecutor: MonitorDbExecutor = {
      async execute<T = unknown>(_sql: string, params: unknown[] = []): Promise<[T, unknown]> {
        const candidate = params[0] as Buffer | null
        const hit = candidate && bidx && candidate.equals(bidx)
        return [(hit ? [{ email: 'a@b.test', notion_user_name: 'A', notion_user_id: 'uid-a' }] : []) as unknown as T, undefined]
      },
    }
    __setMonitorTestOverrides({ pool: fakeExecutor })
    const user = await resolveTechUserByChatId(chatId)
    expect(user).toEqual({ email: 'a@b.test', notion_user_name: 'A', notion_user_id: 'uid-a' })
  })

  test('bidx 沒有命中任何列 → null', async () => {
    const fakeExecutor: MonitorDbExecutor = {
      async execute<T = unknown>(): Promise<[T, unknown]> {
        return [[] as unknown as T, undefined]
      },
    }
    __setMonitorTestOverrides({ pool: fakeExecutor })
    expect(await resolveTechUserByChatId('700000011')).toBeNull()
  })

  test('空字串 chat_id → null，不查任何東西', async () => {
    __setMonitorTestOverrides({ pool: null })
    expect(await resolveTechUserByChatId('')).toBeNull()
  })

  test('池建立失敗（pool 為 null）→ fail closed 回 null，不丟例外', async () => {
    __setMonitorTestOverrides({ pool: null })
    expect(await resolveTechUserByChatId('700000012')).toBeNull()
  })

  test('查詢本身丟例外（連線中途斷線等）→ 同樣 fail closed 回 null，不把例外往外傳', async () => {
    const fakeExecutor: MonitorDbExecutor = {
      async execute(): Promise<never> {
        throw new Error('simulated connection reset')
      },
    }
    __setMonitorTestOverrides({ pool: fakeExecutor })
    await expect(resolveTechUserByChatId('700000013')).resolves.toBeNull()
  })
})

describe('resolveTechUserByEmail：查 tech_users.email（DB 唯一來源）', () => {
  function executorFor(expectedEmail: string): { executor: MonitorDbExecutor; seen: unknown[][] } {
    const seen: unknown[][] = []
    const executor: MonitorDbExecutor = {
      async execute<T = unknown>(_sql: string, params: unknown[] = []): Promise<[T, unknown]> {
        seen.push(params)
        const hit = params[0] === expectedEmail
        return [
          (hit ? [{ email: expectedEmail, notion_user_name: 'KHH Landon Lo', notion_user_id: 'uid-landon' }] : []) as unknown as T,
          undefined,
        ]
      },
    }
    return { executor, seen }
  }

  test('命中 → 回傳名冊三欄', async () => {
    const { executor } = executorFor('pkh_samjp6jp69898@photons.com.tw')
    __setMonitorTestOverrides({ pool: executor })
    const user = await resolveTechUserByEmail('pkh_samjp6jp69898@photons.com.tw')
    expect(user?.notion_user_name).toBe('KHH Landon Lo')
  })

  test('前後空白會被去掉；大小寫交給 DB collation（不在 SQL 包 LOWER）', async () => {
    const { executor, seen } = executorFor('  pkh_samjp6jp69898@photons.com.tw  '.trim())
    __setMonitorTestOverrides({ pool: executor })
    const user = await resolveTechUserByEmail('  pkh_samjp6jp69898@photons.com.tw  ')
    expect(user).not.toBeNull()
    expect(seen[0]![0]).toBe('pkh_samjp6jp69898@photons.com.tw')
  })

  test('查無 → null', async () => {
    const { executor } = executorFor('someone@example.test')
    __setMonitorTestOverrides({ pool: executor })
    expect(await resolveTechUserByEmail('nobody@example.test')).toBeNull()
  })

  test('空字串／純空白 → null，不查 DB', async () => {
    let called = false
    const executor: MonitorDbExecutor = {
      async execute<T = unknown>(): Promise<[T, unknown]> {
        called = true
        return [[] as unknown as T, undefined]
      },
    }
    __setMonitorTestOverrides({ pool: executor })
    expect(await resolveTechUserByEmail('   ')).toBeNull()
    expect(called).toBe(false)
  })

  test('DB 不可用 → fail closed 回 null，不丟例外', async () => {
    __setMonitorTestOverrides({ pool: null })
    expect(await resolveTechUserByEmail('pkh_samjp6jp69898@photons.com.tw')).toBeNull()
  })
})
