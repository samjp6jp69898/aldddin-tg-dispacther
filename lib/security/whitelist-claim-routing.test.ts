import { describe, expect, mock, test } from 'bun:test'

// review 發現的測試空白：whitelist.test.ts 完全沒測到 `claim:` 前綴的路由。
// 不能直接用真的 handleClaim（claim.ts）——它有真實副作用（bug-lock.sh
// claim/release、tracker-sync、最重的是 spawnCreateMr 會真的 spawn 一個
// `timeout 3600 claude -p /create-mr:create-mr <ticket>` 背景行程），對一個假 ticket
// 這樣測會實際觸發一次真的 pipeline 執行，不是單元測試該做的事。
//
// 用 mock.module 在 import whitelist.ts 之前先替換掉 claim.ts 的
// handleClaim 匯出，只驗證『whitelist.ts 的路由邏輯有沒有把 claim:{ticket}
// 正確拆解、正確呼叫 handleClaim』，不執行它的真實邏輯。mock.module 必須在
// 這個測試檔第一次 import whitelist.ts（進而 transitively import claim.ts）
// 之前呼叫，所以用動態 import 而非檔案頂端的靜態 import——這是這份檔案要
// 獨立於 whitelist.test.ts（後者用真的 claim.ts）的原因，兩者不能共用同一
// 個 module registry 狀態。
const handleClaimSpy = mock(async () => {})
mock.module('../locking/claim.ts', () => ({ handleClaim: handleClaimSpy }))

const { registerHandlers } = await import('./whitelist.ts')

const REAL_TECH_CHAT_ID = 5022865804 // 同 whitelist.test.ts，見 tech-users.csv

function captureHandlers() {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {}
  const fakeBot = { on: (event: string, handler: (ctx: any) => Promise<void>) => { handlers[event] = handler } }
  registerHandlers(fakeBot as any)
  return handlers
}

describe('registerHandlers — claim: 路由（mock 掉 handleClaim，只測路由不測真邏輯）', () => {
  test('callback_query data=claim:FAQ-9999999：正確拆出 ticket 並呼叫 handleClaim(ctx, techUser, ticket)', async () => {
    handleClaimSpy.mockClear()
    const handlers = captureHandlers()
    const ctx = { chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'claim:FAQ-9999999' } }
    await handlers['callback_query:data']!(ctx)

    expect(handleClaimSpy).toHaveBeenCalledTimes(1)
    const [passedCtx, techUser, ticket] = handleClaimSpy.mock.calls[0]!
    expect(passedCtx).toBe(ctx)
    expect((techUser as any).notion_user_id).toBe('11ad872b-594c-8196-a694-0002759ea4f7')
    expect(ticket).toBe('FAQ-9999999')
  })
})
