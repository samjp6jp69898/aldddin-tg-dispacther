import { describe, expect, mock, test } from 'bun:test'
import { registerHandlers } from './whitelist.ts'

// 見 obsidian/commands/create-mr/references/tech-users.csv：Landon 的真實
// tg_chat_id，白名單內；用真的值而非隨便編一個，才能真的測到
// resolveTechUserByChatId 命中的那條分支。
const REAL_TECH_CHAT_ID = 5022865804
const NOT_TECH_CHAT_ID = 111222333444

// T29：Telegram callback_query 的 callback_query_id 沒辦法偽造（真實 API 會
// 拒絕），也無法在本機測試 webhook 尚未登記到 Telegram（T22 閘門）的情況下
// 用真正的按鈕點擊觸發——見 tasks.json T29 changelog。這裡繞開這個限制：直接
// 抓 registerHandlers 註冊給 fake bot 的 handler 函式本體，帶 stub ctx 呼叫，
// 純函式層級驗證路由邏輯本身，不依賴真實 Telegram API 往返。
function captureHandlers() {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {}
  const fakeBot = { on: (event: string, handler: (ctx: any) => Promise<void>) => { handlers[event] = handler } }
  registerHandlers(fakeBot as any)
  return handlers
}

function makeCtx(overrides: Record<string, unknown>) {
  return {
    answerCallbackQuery: mock(async () => {}),
    replyWithChatAction: mock(async () => {}),
    reply: mock(async () => {}),
    ...overrides,
  }
}

describe('registerHandlers — T29 頂層選單 + callback_query 路由', () => {
  test('白名單外 chat_id 發訊息：靜默 return，不回覆任何東西', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: NOT_TECH_CHAT_ID } })
    await handlers['message']!(ctx)
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test('白名單內 chat_id 發訊息：回頂層選單（BUG／需求池兩顆按鈕），不查任何 Notion', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID } })
    await handlers['message']!(ctx)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text, opts] = ctx.reply.mock.calls[0]!
    expect(text).toBe('請選擇：')
    const buttonTexts = (opts as any).reply_markup.inline_keyboard.flat().map((b: any) => b.text)
    expect(buttonTexts).toEqual(['BUG', '需求池'])
  })

  test('callback_query data=reqpool:noop：answer + 固定回開發中，不觸發 typing（沒有 Notion 查詢，T9 行為不變）', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'reqpool:noop' } })
    await handlers['callback_query:data']!(ctx)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithChatAction).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith('開發中')
  })

  // 這條會真的打一次 Notion API（sendTicketList 內部呼叫 T6 的
  // queryCandidateTickets，未 mock）——刻意不 mock：這條測試要驗證的正是
  // 『menu:bug 這個新路由真的會走到會打 Notion 的那段』，mock 掉反而測不出
  // 路由是否接對；耗時與可靠性已在 T17 驗證過（400-720ms，穩定）。
  test('callback_query data=menu:bug：answer → typing 提示 → 觸發真實 T6 查詢列清單', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'menu:bug' } })
    await handlers['callback_query:data']!(ctx)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text] = ctx.reply.mock.calls[0]!
    expect(['你的可認領工單：', '目前沒有可認領工單']).toContain(text)
  })

  // review 發現的測試空白，補上：白名單內使用者但 callback_data 是完全未知
  // 的字串，只應消掉 loading 圈，不該回覆任何文字或觸發任何查詢。
  test('callback_query data=未知字串：只 answer，不回覆任何東西、不觸發查詢', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'something:unexpected' } })
    await handlers['callback_query:data']!(ctx)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithChatAction).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  // review 發現的測試空白，補上：白名單外的人觸發 callback_query（防禦性
  // 重驗分支，whitelist.ts:31-36）——理論上收不到 inline keyboard 所以很少
  // 走到，正因如此更需要測試確保這條防線真的有效。
  test('白名單外 chat_id 觸發 callback_query：只 answer 消掉 loading 圈，不做任何查詢或分流', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: NOT_TECH_CHAT_ID }, callbackQuery: { data: 'claim:FAQ-1234' } })
    await handlers['callback_query:data']!(ctx)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithChatAction).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
