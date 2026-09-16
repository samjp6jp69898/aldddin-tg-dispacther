// lib/security/test-support/tech-user-fixture.ts
//
// 2026-09-15（DB 為 tg_chat_id 唯一權威）：resolveTechUserByChatId 改查
// monitor DB 的 tg_chat_id_bidx，不再讀 tech-users.csv（該檔 2026-09-16 已
// 刪檔退役）。whitelist*.test.ts 系列原本靠「真的 CSV 裡有這個人」讓白名單
// 命中分支跑得到，現在改注入假 executor + 固定盲索引金鑰，讓白名單命中完全
// 由測試本身控制，不依賴任何真實環境（monitor DB 是否連得上、tech_users 表
// 現況皆與此無關）。
//
// 用法：`beforeEach(installTechUserFixture)` + `afterEach(resetTechUserFixture)`。

import { blindIndex } from '../../crypto/field-crypto.ts'
import { __resetMonitorTestOverrides, __setMonitorTestOverrides } from '../../monitor-db/runtime.ts'
import { TECH_USER_BIDX_SCOPE } from '../../registry/tech-users-sync.ts'
import type { MonitorDbExecutor } from '../../monitor-db/writes.ts'

/**
 * 對應 tech_users 名冊裡 KHH Landon Lo 那一列（tech-users.csv 退役前的同一
 * 筆資料）。用真的值（不是隨便編的 email/uuid）——`/bug` `/req` `/status` 這類
 * 測試刻意不 mock Notion、直接打真的 Notion API 用 notion_user_id 過濾，假值
 * 會讓 Notion 回 validation_error（people.contains 需要合法 UUID）。
 */
export const REAL_TECH_CHAT_ID = 5022865804
export const NOT_TECH_CHAT_ID = 111222333444
export const REAL_TECH_USER = {
  email: 'pkh_samjp6jp69898@photons.com.tw',
  notion_user_name: 'KHH Landon Lo',
  notion_user_id: '11ad872b-594c-8196-a694-0002759ea4f7',
}

/**
 * 第二位真實白名單內、非 kit/bugreport admin 的技術（名冊裡的 Blast）。原本
 * 這個角色用 Eden Li KHH 的 chat_id，2026-09-15 使用者告知 Eden 已離職、名冊
 * 已無她的 tg_chat_id，改用仍在職、仍已連接的人。
 */
export const OTHER_REAL_TECH_CHAT_ID = 515546393
export const OTHER_REAL_TECH_USER = {
  email: 'pkh_blast@photons.com.tw',
  notion_user_name: 'Blast',
  notion_user_id: 'ed581589-9b3e-4362-b91f-c7ae4140f6c3',
}

let origEnabled: string | undefined
let origBidxKey: string | undefined

export function installTechUserFixture(): void {
  origEnabled = process.env.MON_DB_ENABLED
  origBidxKey = process.env.MON_BIDX_KEY
  process.env.MON_DB_ENABLED = '1'
  process.env.MON_BIDX_KEY = Buffer.from('0'.repeat(64), 'hex').toString('base64') // 固定測試金鑰，非真實密鑰

  const byBidxHex = new Map<string, (typeof REAL_TECH_USER)[]>()
  const put = (chatId: number, user: typeof REAL_TECH_USER) => {
    const bidx = blindIndex(TECH_USER_BIDX_SCOPE, String(chatId))
    if (bidx) byBidxHex.set(bidx.toString('hex'), [user])
  }
  put(REAL_TECH_CHAT_ID, REAL_TECH_USER)
  put(OTHER_REAL_TECH_CHAT_ID, OTHER_REAL_TECH_USER)

  const fakeExecutor: MonitorDbExecutor = {
    async execute<T = unknown>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('SELECT email, notion_user_name, notion_user_id FROM tech_users WHERE tg_chat_id_bidx = ?')) {
        const candidate = params[0] as Buffer | null
        const hit = candidate ? byBidxHex.get(candidate.toString('hex')) : undefined
        return [(hit ?? []) as unknown as T, undefined]
      }
      throw new Error(`tech-user-fixture: unrecognized SQL: ${s}`)
    },
  }
  __setMonitorTestOverrides({ pool: fakeExecutor })
}

export function resetTechUserFixture(): void {
  if (origEnabled === undefined) delete process.env.MON_DB_ENABLED
  else process.env.MON_DB_ENABLED = origEnabled
  if (origBidxKey === undefined) delete process.env.MON_BIDX_KEY
  else process.env.MON_BIDX_KEY = origBidxKey
  __resetMonitorTestOverrides()
}
