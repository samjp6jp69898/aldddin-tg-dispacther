import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { installTechUserFixture, resetTechUserFixture } from './test-support/tech-user-fixture.ts'

beforeEach(installTechUserFixture)
afterEach(resetTechUserFixture)

// 獨立 changelog bot（changelog-bot.ts → registerChangelogBotHandlers）的路由測試，外加
// 「bug_analyst_bot（whitelist.ts）已不再處理 /changelog」的回歸檢查。
// mock.module 必須在第一次 import 之前呼叫——真的執行會 git fetch、建 worktree 並跑
// 20–40 分鐘的 claude -p。只 mock changelog-job.ts 這一個 leaf，格式檢查走真實邏輯。
// 路徑相對於本測試檔而非寫死 /Users/user/aladdin/telegram-dispatcher：在 worktree 等
// 其他位置跑測試時，寫死的路徑會讓 mock 對不上、真的 job 被執行（2026-10-28 實際踩到）。
const JOB_PATH = `${import.meta.dir}/../webhook-server/changelog-job.ts`
let releaseJob: () => void = () => {}
const jobMock = mock((_api: unknown, _chatId: number, _tokens: string[]) => new Promise<void>(resolve => (releaseJob = resolve)))
mock.module(JOB_PATH, () => ({ runChangelogJob: jobMock }))
// 允許群組清單由後台 DB 提供（changelog-group-allowlist.ts，交接中），這裡以 mock 控制。
const ALLOWLIST_PATH = `${import.meta.dir}/../webhook-server/changelog-group-allowlist.ts`
let allowedGroups = new Set<string>()
const allowlistMock = mock(async (chatId: string) => allowedGroups.has(chatId))
mock.module(ALLOWLIST_PATH, () => ({ isChangelogGroupChat: allowlistMock }))

const { registerChangelogBotHandlers } = await import('../webhook-server/changelog-command.ts')
const { registerHandlers } = await import('./whitelist.ts')

const ADMIN_CHAT_ID = 5022865804 // 同 whitelist-bugreport-routing.test.ts
const OTHER_CHAT_ID = 515546393
const GROUP_CHAT_ID = -1001234567890
const BOT_USERNAME = 'aladdin_changelog_bot'

function captureHandlers(register: (bot: any) => void) {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {}
  register({ on: (event: string, handler: (ctx: any) => Promise<void>) => { handlers[event] = handler } })
  return handlers
}

let updateIdCounter = 0
function makeCtx(chat: Record<string, unknown>, text: string) {
  updateIdCounter++
  return {
    update: { update_id: updateIdCounter },
    chat,
    from: { id: 999000111 },
    me: { username: BOT_USERNAME },
    message: { text },
    api: { sendMessage: mock(async () => {}) },
    reply: mock(async () => {}),
    replyWithChatAction: mock(async () => {}),
    replyWithDocument: mock(async () => {}),
    answerCallbackQuery: mock(async () => {}),
  }
}
const dm = (id: number, text: string) => makeCtx({ id, type: 'private' }, text)
const group = (id: number, text: string) => makeCtx({ id, type: 'supergroup', title: '測試群組' }, text)

const ORIGINAL_ADMIN_ENV = process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
afterEach(() => {
  if (ORIGINAL_ADMIN_ENV === undefined) delete process.env.TG_BUG_REPORT_ADMIN_CHAT_ID
  else process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = ORIGINAL_ADMIN_ENV
  allowedGroups = new Set()
  releaseJob()
  jobMock.mockClear()
  allowlistMock.mockClear()
})

describe('changelog bot — 私訊', () => {
  test('管理員 + 格式正確：回覆收到並以原始三元組 tokens 啟動背景 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const ctx = dm(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249 abu hotfix/20261020 abu_platform_1.10.111')
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).toHaveBeenCalledTimes(1)
    expect(jobMock.mock.calls[0]![2]).toEqual(['agrabah', 'main', 'agrabah_1.10.249', 'abu', 'hotfix/20261020', 'abu_platform_1.10.111'])
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('收到')
  })

  test('管理員 + 格式錯誤：指出哪一組錯，不啟動 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const ctx = dm(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249 abu main agrabah_1.10.1')
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('第 2 組')
  })

  test('管理員 + 非指令文字：回用法說明', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const ctx = dm(ADMIN_CHAT_ID, '哈囉')
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('/changelog <repo> <branch> <tag>')
  })

  test('非管理員私訊 /changelog：靜默忽略，不回覆、不啟動 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const ctx = dm(OTHER_CHAT_ID, '/changelog agrabah main agrabah_1.10.249')
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test('上一份還在跑時再送：回忙碌提示，不重複啟動 job', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const handlers = captureHandlers(registerChangelogBotHandlers)
    await handlers['message']!(dm(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249'))
    const second = dm(ADMIN_CHAT_ID, '/changelog agrabah main agrabah_1.10.249')
    await handlers['message']!(second)

    expect(jobMock).toHaveBeenCalledTimes(1)
    expect(String(second.reply.mock.calls[0]![0])).toContain('正在產生')
  })
})

describe('changelog bot — 群組 @bot /changelog', () => {
  test('允許的群組 + 任何成員 @bot /changelog：以去掉 @bot 的 tokens 啟動 job，回覆到群組', async () => {
    allowedGroups = new Set(['-100999', String(GROUP_CHAT_ID)])
    const ctx = group(GROUP_CHAT_ID, `@${BOT_USERNAME} /changelog agrabah main agrabah_1.10.241 lago main lago_pk-gaming_0.10.71`)
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).toHaveBeenCalledTimes(1)
    expect(jobMock.mock.calls[0]![1]).toBe(GROUP_CHAT_ID)
    expect(jobMock.mock.calls[0]![2]).toEqual(['agrabah', 'main', 'agrabah_1.10.241', 'lago', 'main', 'lago_pk-gaming_0.10.71'])
  })

  test('允許的群組 + @bot 但格式錯：在群組回覆是哪一組錯，不啟動 job', async () => {
    allowedGroups = new Set([String(GROUP_CHAT_ID)])
    const ctx = group(GROUP_CHAT_ID, `@${BOT_USERNAME} /changelog abu main agrabah_1.10.1`)
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('第 1 組')
  })

  test('沒有 @bot 的 /changelog、@ 別的 bot、或一般閒聊：全部靜默忽略', async () => {
    allowedGroups = new Set([String(GROUP_CHAT_ID)])
    const handlers = captureHandlers(registerChangelogBotHandlers)
    for (const text of ['/changelog agrabah main agrabah_1.10.241', '@other_bot /changelog agrabah main agrabah_1.10.241', `@${BOT_USERNAME} 你好`, '大家好']) {
      const ctx = group(GROUP_CHAT_ID, text)
      await handlers['message']!(ctx)
      expect(ctx.reply).not.toHaveBeenCalled()
    }
    expect(jobMock).not.toHaveBeenCalled()
    // 格式不符就不查允許清單（之後是查 DB，群組閒聊不該每則都打一次）
    expect(allowlistMock).not.toHaveBeenCalled()
  })

  test('未設定的群組 @bot /changelog：不回覆、不啟動 job', async () => {
    allowedGroups = new Set(['-100999'])
    const ctx = group(GROUP_CHAT_ID, `@${BOT_USERNAME} /changelog agrabah main agrabah_1.10.241`)
    await captureHandlers(registerChangelogBotHandlers)['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

describe('bug_analyst_bot（whitelist.ts）不再處理 /changelog', () => {
  test('bugreport 管理員私訊 /changelog：不啟動 job，回一般用法提示且不列出 /changelog', async () => {
    process.env.TG_BUG_REPORT_ADMIN_CHAT_ID = String(ADMIN_CHAT_ID)
    const ctx = makeCtx({ id: ADMIN_CHAT_ID }, '/changelog agrabah main agrabah_1.10.249')
    await captureHandlers(registerHandlers)['message']!(ctx)

    expect(jobMock).not.toHaveBeenCalled()
    const replyText = String(ctx.reply.mock.calls[0]![0])
    expect(replyText).toContain('可用指令')
    expect(replyText).not.toContain('/changelog')
  })
})
