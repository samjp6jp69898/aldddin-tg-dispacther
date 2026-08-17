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

// T27：whitelist.ts 的 replayGuard 是 registerHandlers() 呼叫當下建立的
// closure 變數（不是 module-level singleton，review 發現原本設計成
// singleton 會讓測試之間共用追蹤狀態、只能靠人工約定不同 update_id 區段
// 避免互相誤判——已改成每次呼叫 registerHandlers 都拿到全新的 guard，這裡
// 每個測試各自呼叫 captureHandlers() 天生互相隔離）。每個 ctx 預設給一個
// 獨一無二的 update_id（遞增計數器）純粹是方便，不是為了跨測試隔離。
let updateIdCounter = 0
function makeCtx(overrides: Record<string, unknown>) {
  updateIdCounter++
  return {
    update: { update_id: updateIdCounter },
    answerCallbackQuery: mock(async () => {}),
    replyWithChatAction: mock(async () => {}),
    reply: mock(async () => {}),
    ...overrides,
  }
}

describe('registerHandlers — T30 指令式訊息路由（斜線指令） + T29 callback_query 路由', () => {
  test('白名單外 chat_id 發訊息：靜默 return，不回覆任何東西', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: NOT_TECH_CHAT_ID } })
    await handlers['message']!(ctx)
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  // T30（2026-08-17 使用者收尾驗收時定案：改為斜線指令 /bug /req /menu，
  // 取代原本的裸文字 bug/req，避免閒聊訊息剛好整句是 "bug"/"req" 誤觸）：
  // /menu 回頂層選單；/bug 直接列清單；/req 佔位；其他文字回用法提示。
  test('T30：發 /menu：回頂層選單（BUG／需求池兩顆按鈕），不查任何 Notion', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: { text: '/menu' } })
    await handlers['message']!(ctx)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text, opts] = ctx.reply.mock.calls[0]!
    expect(text).toBe('請選擇：')
    const buttonTexts = (opts as any).reply_markup.inline_keyboard.flat().map((b: any) => b.text)
    expect(buttonTexts).toEqual(['BUG', '需求池'])
  })

  // 跟 menu:bug 按鈕的測試同一個理由刻意不 mock Notion：要驗證的正是
  // 「/bug 這個指令路由真的接到會打 Notion 的那段」。
  test('T30：發 /bug（大小寫/空白容忍）：typing 提示 → 觸發真實 T6 查詢列清單', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: { text: '  /BUG ' } })
    await handlers['message']!(ctx)

    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text] = ctx.reply.mock.calls[0]!
    expect(['你的可認領工單：', '目前沒有可認領工單']).toContain(text)
  })

  // T32：/req 從固定佔位改成真的查需求池（T31），刻意不 mock Notion——要
  // 驗證的正是「/req 這個指令路由真的接到會打 Notion 的那段」，同一個理由
  // 跟 /bug 測試一致。
  test('T32：發 /req：typing 提示 → 觸發真實 T31 查詢需求池清單', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: { text: '/req' } })
    await handlers['message']!(ctx)

    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text] = ctx.reply.mock.calls[0]!
    expect(['你的可認領需求單：', '目前沒有可認領需求單']).toContain(text)
  })

  test('T30：發不帶斜線的裸文字 bug/req：不再被當成指令，回用法提示（斜線是唯一合法格式）', async () => {
    const handlers = captureHandlers()
    const ctxBug = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: { text: 'bug' } })
    await handlers['message']!(ctxBug)
    expect(ctxBug.replyWithChatAction).not.toHaveBeenCalled()
    expect(String(ctxBug.reply.mock.calls[0]![0])).toContain('可用指令')

    const ctxReq = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: { text: 'req' } })
    await handlers['message']!(ctxReq)
    expect(String(ctxReq.reply.mock.calls[0]![0])).toContain('可用指令')
  })

  test('T30：發未知文字／無文字訊息：回用法提示，不靜默、不觸發查詢', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: { text: '哈囉' } })
    await handlers['message']!(ctx)
    expect(ctx.replyWithChatAction).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('可用指令')

    const ctxNoText = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, message: {} })
    await handlers['message']!(ctxNoText)
    expect(String(ctxNoText.reply.mock.calls[0]![0])).toContain('可用指令')
  })

  // T32：reqpool:noop 從固定佔位改成真的查需求池，刻意不 mock Notion，理由
  // 同 menu:bug 測試。
  test('callback_query data=reqpool:noop：answer → typing 提示 → 觸發真實 T31 查詢需求池清單', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'reqpool:noop' } })
    await handlers['callback_query:data']!(ctx)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text] = ctx.reply.mock.calls[0]!
    expect(['你的可認領需求單：', '目前沒有可認領需求單']).toContain(text)
  })

  // T32：demand-claim:{ticket} 目前只是可見/可按但功能未實作（T33），要有
  // 明確回覆，不是安靜失敗。
  test('callback_query data=demand-claim:{ticket}：answer + 明確回覆功能開發中，不誤觸發任何 claim 邏輯', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'demand-claim:ALDREQ-741' } })
    await handlers['callback_query:data']!(ctx)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('開發中')
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

  // T27：同一個 update_id 的 message 被送第二次（重放，或 Telegram 因為
  // 我們回應逾時而做的合法重試），第二次不該重複執行任何業務邏輯。
  test('T27：同一個 update_id 的 message 重放：第二次靜默 return，不重複回覆', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, update: { update_id: 900001 } })
    await handlers['message']!(ctx)
    expect(ctx.reply).toHaveBeenCalledTimes(1)

    // 同一個 update_id 再送一次（同一個 ctx 重呼叫一次 handler，模擬重放）——
    // reply 的呼叫次數不會再增加。
    await handlers['message']!(ctx)
    expect(ctx.reply).toHaveBeenCalledTimes(1) // 還是 1，不是 2
  })

  // T27：callback_query 版本——重放的請求連 answerCallbackQuery 都不該做
  // （原始合法請求已經處理過），不只是不重複觸發 claim。
  test('T27：同一個 update_id 的 callback_query 重放：第二次連 answerCallbackQuery 都不做', async () => {
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: REAL_TECH_CHAT_ID }, callbackQuery: { data: 'reqpool:noop' }, update: { update_id: 900002 } })
    await handlers['callback_query:data']!(ctx)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledTimes(1)

    await handlers['callback_query:data']!(ctx)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1) // 還是 1
    expect(ctx.reply).toHaveBeenCalledTimes(1) // 還是 1
  })

  // 不同 update_id（即使其他欄位完全相同）不該互相干擾——這是 makeCtx 預設
  // 自動遞增 update_id 的行為本身就在驗證的事，這裡額外顯式測一次以防
  // 未來有人誤改成固定值。
  test('T27：不同 update_id 的兩則獨立訊息都正常處理，不會被誤判成重放', async () => {
    const handlers = captureHandlers()
    const ctx1 = makeCtx({ chat: { id: REAL_TECH_CHAT_ID } })
    const ctx2 = makeCtx({ chat: { id: REAL_TECH_CHAT_ID } })
    expect((ctx1.update as any).update_id).not.toBe((ctx2.update as any).update_id)

    await handlers['message']!(ctx1)
    await handlers['message']!(ctx2)
    expect(ctx1.reply).toHaveBeenCalledTimes(1)
    expect(ctx2.reply).toHaveBeenCalledTimes(1)
  })

  // review 發現的真實 bug 對應測試：業務邏輯（這裡用 ctx.reply 丟出例外
  // 模擬 sendTopLevelMenu 內部呼叫 Telegram API 失敗）第一次失敗，例外要
  // 原樣往上丟（不吞掉、行為跟 T27 之前一致），且這個 update_id 要被
  // forget 掉——Telegram 之後真正的重試（同一個 update_id 再送一次）必須
  // 能重新跑一次業務邏輯，不能被誤判成重放而永久靜默吞掉。
  test('T27：業務邏輯第一次失敗（例外原樣往上丟）：同一個 update_id 之後的重試不會被誤判成重放，能重新執行', async () => {
    const handlers = captureHandlers()
    let shouldFail = true
    const ctx = makeCtx({
      chat: { id: REAL_TECH_CHAT_ID },
      update: { update_id: 900003 },
      reply: mock(async () => {
        if (shouldFail) throw new Error('模擬 Telegram API 失敗')
      }),
    })

    await expect(handlers['message']!(ctx)).rejects.toThrow('模擬 Telegram API 失敗')
    expect(ctx.reply).toHaveBeenCalledTimes(1)

    shouldFail = false
    // 同一個 update_id 的重試：如果沒有 forget，這裡會被 replayGuard 判定
    // 重複而靜默 return，ctx.reply 不會再被呼叫——這正是本測試要防的迴歸。
    await handlers['message']!(ctx)
    expect(ctx.reply).toHaveBeenCalledTimes(2)
  })
})
