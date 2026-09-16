import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { installTechUserFixture, resetTechUserFixture } from './test-support/tech-user-fixture.ts'

beforeEach(installTechUserFixture)
afterEach(resetTechUserFixture)

// /bugreport 路由測試（見 whitelist.ts bugReportAdmin 分支）。跟
// whitelist-kit-routing.test.ts 同一個理由：mock.module 必須在第一次 import
// whitelist.ts（進而 transitively import bug-report-command.ts →
// run-bug-assignee-report.ts）之前呼叫——真的執行會真的打 Notion API。這裡
// 只 mock run-bug-assignee-report.ts 這一個 leaf（repo 裡沒有其他測試檔案
// 碰它，不會跟 kit-issue.ts 用的 node:child_process/execFileSync 互相污染
// ——同一個理由見該檔對 spawn_kit_script.ts 的說明）。
const RUN_SCRIPT_PATH = '/Users/user/aladdin/telegram-dispatcher/lib/webhook-server/run-bug-assignee-report.ts'
const runScriptMock = mock((_outBase: string) => ({ success: true }) as { success: true } | { success: false; stderr: string })
mock.module(RUN_SCRIPT_PATH, () => ({ runBugAssigneeReportScript: runScriptMock }))

const { registerHandlers } = await import('./whitelist.ts')

const BUG_REPORT_ADMIN_CHAT_ID = 5022865804 // Landon，見 test-support/tech-user-fixture.ts／.env TG_BUG_REPORT_ADMIN_CHAT_ID 真實值
// 另一位真實白名單內技術（Blast，非 bug report admin）。原本用 Eden Li KHH，
// 2026-09-15 使用者告知她已離職、CSV 已無她的 tg_chat_id，改用仍在職的人。
const OTHER_TECH_CHAT_ID = 515546393

function captureHandlers() {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {}
  const fakeBot = { on: (event: string, handler: (ctx: any) => Promise<void>) => { handlers[event] = handler } }
  registerHandlers(fakeBot as any)
  return handlers
}

let updateIdCounter = 0
function makeCtx(overrides: Record<string, unknown>) {
  updateIdCounter++
  return {
    update: { update_id: updateIdCounter },
    reply: mock(async () => {}),
    replyWithChatAction: mock(async () => {}),
    replyWithDocument: mock(async () => {}),
    answerCallbackQuery: mock(async () => {}),
    ...overrides,
  }
}

const ORIGINAL_ADMIN_ENV = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
afterEach(() => {
  if (ORIGINAL_ADMIN_ENV === undefined) delete process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
  else process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = ORIGINAL_ADMIN_ENV
  runScriptMock.mockClear()
})

describe('registerHandlers — /bugreport 路由（mock 掉 runBugAssigneeReportScript，只測路由＋三份 CSV 送出，不測 bug-assignee-report.ts 真邏輯）', () => {
  test('bugReportAdmin + /bugreport + 腳本成功：各自 replyWithDocument 送出三份品牌 CSV', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(BUG_REPORT_ADMIN_CHAT_ID)
    runScriptMock.mockImplementationOnce(() => ({ success: true }))
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: BUG_REPORT_ADMIN_CHAT_ID }, message: { text: '/bugreport' } })
    await handlers['message']!(ctx)

    expect(runScriptMock).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('upload_document')
    // mock 沒有真的寫出 CSV 檔案，三份都會落到「CSV 未產生」分支，驗證的是
    // 路由＋三品牌迴圈跑完，不是真的檔案存在（那是 bug-assignee-report.ts
    // 自己的職責，不在這支測試範圍內）。
    expect(ctx.reply).toHaveBeenCalledTimes(3)
    for (const call of ctx.reply.mock.calls) {
      expect(String(call[0])).toContain('CSV 未產生')
    }
  })

  test('bugReportAdmin + /bugreport + 腳本失敗：回報失敗訊息，不進三品牌迴圈', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(BUG_REPORT_ADMIN_CHAT_ID)
    runScriptMock.mockImplementationOnce(() => ({ success: false, stderr: 'Notion API error 401' }))
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: BUG_REPORT_ADMIN_CHAT_ID }, message: { text: '/bugreport' } })
    await handlers['message']!(ctx)

    expect(runScriptMock).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithDocument).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('Notion API error 401')
  })

  test('bugReportAdmin + 未知文字：一般用法提示裡會列出 /bugreport（讓 admin 知道有這個指令）', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(BUG_REPORT_ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: BUG_REPORT_ADMIN_CHAT_ID }, message: { text: '哈囉' } })
    await handlers['message']!(ctx)

    expect(runScriptMock).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('/bugreport')
  })

  test('白名單內但非 bugReportAdmin 的技術打 /bugreport：不呼叫報表腳本、回一般用法提示，且不洩漏 /bugreport 存在', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(BUG_REPORT_ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: OTHER_TECH_CHAT_ID }, message: { text: '/bugreport' } })
    await handlers['message']!(ctx)

    expect(runScriptMock).not.toHaveBeenCalled()
    expect(ctx.replyWithDocument).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [replyText] = ctx.reply.mock.calls[0]!
    expect(String(replyText)).toContain('可用指令')
    expect(String(replyText)).not.toContain('/bugreport')
  })

  test('TG_BUG_REPORT_ADMIN_CHAT_ID 未設定：即使 chat_id 剛好等於平常的 admin id，/bugreport 功能整個關閉', async () => {
    delete process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: BUG_REPORT_ADMIN_CHAT_ID }, message: { text: '/bugreport' } })
    await handlers['message']!(ctx)

    expect(runScriptMock).not.toHaveBeenCalled()
    const [replyText] = ctx.reply.mock.calls[0]!
    expect(String(replyText)).not.toContain('/bugreport')
  })
})
