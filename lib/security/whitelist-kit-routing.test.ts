import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// /kit 路由測試（見 whitelist.ts /^\/kit(\s|$)/i 分支）。跟
// whitelist-claim-routing.test.ts 同一個理由：mock.module 必須在第一次
// import whitelist.ts（進而 transitively import kit-issue.ts →
// spawn_kit_script.ts）之前呼叫——runKitScript 真的執行會對 aladdin-admin/
// aladdin-platform 的名冊檔案做真實寫入，不是單元測試該做的事。這裡只 mock
// spawn_kit_script.ts 這一個 leaf（repo 裡沒有其他測試檔案碰它），跟
// whitelist.test.ts／kit-issue.test.ts 用的都是真的模組，不會互相污染
// （mock.module 是 process 全域生效，實測驗證過同一個 leaf 若被兩個檔案
// 各自 mock 才會有先後互相覆蓋的風險——這裡刻意只有這一個檔案碰它）。
const SPAWN_KIT_SCRIPT_PATH = '/Users/user/aladdin/obsidian/mcps/aladdin-kit-admin/src/spawn_kit_script.ts'
const runKitScriptMock = mock((_args: string[]) => ({ success: true, stdout: '', stderr: '' }))
mock.module(SPAWN_KIT_SCRIPT_PATH, () => ({ runKitScript: runKitScriptMock }))

const { registerHandlers } = await import('./whitelist.ts')

const KIT_ADMIN_CHAT_ID = 5022865804 // Landon，見 tech-users.csv／.env TG_KIT_ADMIN_CHAT_ID 真實值
const OTHER_TECH_CHAT_ID = 2095624031 // 另一位真實白名單內技術（Eden Li KHH，見 tech-users.csv），非 kit admin
const KIT_DIST_DIR = '/Users/user/aladdin/obsidian/mcps/aladdin-ai-assistant-kit/dist'

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

const ORIGINAL_ADMIN_ENV = process.env.TG_KIT_ADMIN_CHAT_ID
afterEach(() => {
  if (ORIGINAL_ADMIN_ENV === undefined) delete process.env.TG_KIT_ADMIN_CHAT_ID
  else process.env.TG_KIT_ADMIN_CHAT_ID = ORIGINAL_ADMIN_ENV
  runKitScriptMock.mockClear()
})

describe('registerHandlers — /kit 路由（mock 掉 runKitScript，只測路由＋打包送出，不測 make-starter-kit.ts 真邏輯）', () => {
  test('kitAdmin + 指令格式正確 + runKitScript 成功：打包 dist/<id>/ 成 zip 並 replyWithDocument 送出', async () => {
    process.env.TG_KIT_ADMIN_CHAT_ID = String(KIT_ADMIN_CHAT_ID)
    const testId = 'kit-routing-test-fixture'
    const distDir = join(KIT_DIST_DIR, testId)
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'dummy.txt'), 'hello')

    try {
      runKitScriptMock.mockImplementationOnce(() => ({ success: true, stdout: '完成：測試輸出', stderr: '' }))
      const handlers = captureHandlers()
      const ctx = makeCtx({ chat: { id: KIT_ADMIN_CHAT_ID }, message: { text: `/kit ${testId} 測試` } })
      await handlers['message']!(ctx)

      expect(runKitScriptMock).toHaveBeenCalledTimes(1)
      expect(runKitScriptMock.mock.calls[0]![0]).toEqual(['--id', testId, '--name', '測試'])
      expect(ctx.replyWithChatAction).toHaveBeenCalledWith('upload_document')
      expect(ctx.reply).toHaveBeenCalledWith('完成：測試輸出')
      expect(ctx.replyWithDocument).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(distDir, { recursive: true, force: true })
    }
  })

  test('kitAdmin + runKitScript 失敗（例如 id 已存在未加 rotate）：原樣回 stderr，不打包不送檔案', async () => {
    process.env.TG_KIT_ADMIN_CHAT_ID = String(KIT_ADMIN_CHAT_ID)
    runKitScriptMock.mockImplementationOnce(() => ({ success: false, stdout: '', stderr: 'id "angelo" 已經存在，本次不做任何修改' }))
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: KIT_ADMIN_CHAT_ID }, message: { text: '/kit angelo 信融' } })
    await handlers['message']!(ctx)

    expect(runKitScriptMock).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith('id "angelo" 已經存在，本次不做任何修改')
    expect(ctx.replyWithDocument).not.toHaveBeenCalled()
  })

  test('kitAdmin + 指令格式錯誤（缺 name）：回用法提示，不呼叫 runKitScript', async () => {
    process.env.TG_KIT_ADMIN_CHAT_ID = String(KIT_ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: KIT_ADMIN_CHAT_ID }, message: { text: '/kit angelo' } })
    await handlers['message']!(ctx)

    expect(runKitScriptMock).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('用法')
  })

  test('kitAdmin + 未知文字：一般用法提示裡會列出 /kit（讓 admin 知道有這個指令）', async () => {
    process.env.TG_KIT_ADMIN_CHAT_ID = String(KIT_ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: KIT_ADMIN_CHAT_ID }, message: { text: '哈囉' } })
    await handlers['message']!(ctx)

    expect(runKitScriptMock).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0]![0])).toContain('/kit')
  })

  test('白名單內但非 kitAdmin 的技術打 /kit：不呼叫 runKitScript、回一般用法提示，且不洩漏 /kit 存在', async () => {
    process.env.TG_KIT_ADMIN_CHAT_ID = String(KIT_ADMIN_CHAT_ID)
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: OTHER_TECH_CHAT_ID }, message: { text: '/kit angelo 信融' } })
    await handlers['message']!(ctx)

    expect(runKitScriptMock).not.toHaveBeenCalled()
    expect(ctx.replyWithDocument).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [replyText] = ctx.reply.mock.calls[0]!
    expect(String(replyText)).toContain('可用指令')
    expect(String(replyText)).not.toContain('/kit')
  })

  test('TG_KIT_ADMIN_CHAT_ID 未設定：即使 chat_id 剛好等於平常的 admin id，/kit 功能整個關閉', async () => {
    delete process.env.TG_KIT_ADMIN_CHAT_ID
    const handlers = captureHandlers()
    const ctx = makeCtx({ chat: { id: KIT_ADMIN_CHAT_ID }, message: { text: '/kit angelo 信融' } })
    await handlers['message']!(ctx)

    expect(runKitScriptMock).not.toHaveBeenCalled()
    const [replyText] = ctx.reply.mock.calls[0]!
    expect(String(replyText)).not.toContain('/kit')
  })
})
