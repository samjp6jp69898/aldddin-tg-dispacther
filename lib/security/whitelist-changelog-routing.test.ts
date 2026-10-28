import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { installTechUserFixture, resetTechUserFixture } from './test-support/tech-user-fixture.ts'

beforeEach(installTechUserFixture)
afterEach(resetTechUserFixture)

// /changelog 路由測試（見 whitelist.ts 的 bugReportAdmin + /changelog 分支）。
// 跟 whitelist-bugreport-routing.test.ts 同一個理由：mock.module 必須在第一次
// import whitelist.ts 之前呼叫——真的執行會真的 git fetch 並跑 20–40 分鐘的
// claude -p（含把本機 repo 切分支）。這裡只 mock changelog-job.ts 這一個 leaf，
// 格式檢查（parseTriples）走真實邏輯。路徑刻意相對於本測試檔而非寫死
// /Users/user/aladdin/telegram-dispatcher：在 worktree 等其他位置跑測試時，寫死
// 的路徑會讓 mock 對不上、真的 job 被執行（2026-10-28 實際踩到）。
const JOB_PATH = `${import.meta.dir}/../webhook-server/changelog-job.ts`
let releaseJob: () => void = () => {}
const jobMock = mock((_api: unknown, _chatId: number, _tokens: string[]) => new Promise<void>(resolve => (releaseJob = resolve)))
mock.module(JOB_PATH, () => ({ runChangelogJob: jobMock }))

const { registerHandlers } = await import('./whitelist.ts')

const ADMIN_CHAT_ID = 5022865804 // 同 whitelist-bugreport-routing.test.ts
const OTHER_TECH_CHAT_ID = 515546393

function captureHandlers() {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {}
  const fakeBot = { on: (event: string, handler: (ctx: any) => Promise<void>) => { handlers[event] = handler } }
  registerHandlers(fakeBot as any)
  return handlers
}

let updateIdCounter = 0
function makeCtx(chatId: number, text: string) {
  updateIdCounter++
  return {
    update: { update_id: updateIdCounter },
    chat: { id: chatId },
    message: { text },
    api: { sendMessage: mock(async () => {}) },
    reply: mock(async () => {}),
    replyWithChatAction: mock(async () => {}),
    replyWithDocument: mock(async () => {}),
    answerCallbackQuery: mock(async () => {}),
  }
}

const ORIGINAL_ADMIN_ENV = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
afterEach(() => {
  if (ORIGINAL_ADMIN_ENV === undefined) delete process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
  else process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = ORIGINAL_ADMIN_ENV
  releaseJob()
  jobMock.mockClear()
})

describe('registerHandlers — /changelog 路由（mock 掉 runChangelogJob）', () => {
  test('管理員 + 格式正確：回覆收到並以原始三元組 tokens 啟動背景 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249 abu hotfix/20261020 abu_platform_1.10.111')
    await handlers['message']!(ctx)

    expect(jobMock).toHaveBeenCalledTimes(1)
    expect(jobMock.mock.calls[0]![2]).toEqual(['agrabah', 'main', 'agrabah_1.10.249', 'abu', 'hotfix/20261020', 'abu_platform_1.10.111'])
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('收到')
  })

  test('管理員 + 格式錯誤：指出哪一組錯，不啟動 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249 abu main agrabah_1.10.1')
    await handlers['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    const replyText = String(ctx.reply.mock.calls[0]![0])
    expect(replyText).toContain('第 2 組')
    expect(replyText).toContain('與 repo「abu」不符')
  })

  test('管理員 + 參數數量不是 3 的倍數：回格式說明，不啟動 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx(ADMIN_CHAT_ID, '/changelog agrabah main')
    await handlers['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('不是 3 的倍數')
  })

  test('上一份還在跑時再送：回忙碌提示，不重複啟動 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    await handlers['message']!(makeCtx(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249'))
    const second = makeCtx(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249')
    await handlers['message']!(second)

    expect(jobMock).toHaveBeenCalledTimes(1)
    expect(String(second.reply.mock.calls[0]![0])).toContain('正在產生')
  })

  test('白名單內非管理員打 /changelog：不啟動 job、回一般用法提示，且不洩漏 /changelog 存在', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx(OTHER_TECH_CHAT_ID, '/changelog agrabah main agrabah_1.10.249')
    await handlers['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    const replyText = String(ctx.reply.mock.calls[0]![0])
    expect(replyText).toContain('可用指令')
    expect(replyText).not.toContain('/changelog')
  })

  test('管理員 + 未知文字：一般用法提示裡會列出 /changelog', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx(ADMIN_CHAT_ID, '哈囉')
    await handlers['message']!(ctx)

    expect(String(ctx.reply.mock.calls[0]![0])).toContain('/changelog')
  })
})
