import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installTechUserFixture, resetTechUserFixture } from './test-support/tech-user-fixture.ts'

beforeEach(installTechUserFixture)
afterEach(resetTechUserFixture)

// 只 mock triggerTgAutoSync（trigger-auto-sync.ts 沒有自己的真實邏輯單元
// 測試，mock 掉不會跟其他測試檔搶同一個 module registry）。logUnknownSender
// 刻意不 mock、讓真邏輯真的跑——用 TG_UNKNOWN_SENDERS_LOG_PATH 指向本測試的
// 專屬 tmp 檔案即可安全隔離，不會碰到正式 log。這樣才不會重蹈
// unknown-sender-log.test.ts 也 import 同一個 module 的真實實作、卻被別的
// 測試檔 mock.module 覆蓋掉的問題（mock.module 是 process 全域的，同一次
// `bun test` 執行內，被 mock 過的 module 對所有測試檔都是同一份，兩邊都想
// 用同一個 module 的「真實版」跟「mock 版」會互相踩到）。
//
// TG_UNKNOWN_SENDERS_LOG_PATH 必須在動態 import whitelist.ts 之前設好：見
// unknown-sender-log.ts 的參數預設值改成「呼叫當下才求值」，就是為了讓這裡
// 的設定順序不受「哪個測試檔先 import 到 unknown-sender-log.ts」影響。
const testLogDir = mkdtempSync(join(tmpdir(), 'tg-auto-sync-trigger-'))
process.env.TG_UNKNOWN_SENDERS_LOG_PATH = join(testLogDir, 'unknown-senders.jsonl')

const triggerTgAutoSyncSpy = mock(() => {})
mock.module('../webhook-server/trigger-auto-sync.ts', () => ({ triggerTgAutoSync: triggerTgAutoSyncSpy }))

const { registerHandlers } = await import('./whitelist.ts')
const { logUnknownSender } = await import('../webhook-server/unknown-sender-log.ts')

const NOT_TECH_CHAT_ID = 111222333444
const ALREADY_SEEN_CHAT_ID = 222333444555
const REAL_TECH_CHAT_ID = 5022865804 // 見 test-support/tech-user-fixture.ts

let updateIdCounter = 0
function captureHandlers() {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {}
  const fakeBot = { on: (event: string, handler: (ctx: any) => Promise<void>) => { handlers[event] = handler } }
  registerHandlers(fakeBot as any)
  return handlers
}
function makeCtx(overrides: Record<string, unknown>) {
  updateIdCounter++
  return { update: { update_id: updateIdCounter }, reply: mock(async () => {}), ...overrides }
}

describe('registerHandlers — 白名單外私聊訊息觸發 tg-auto-sync（真實 logUnknownSender + tmp log，mock 掉 triggerTgAutoSync）', () => {
  test('全新（第一次見過的）chat_id：觸發 triggerTgAutoSync', async () => {
    triggerTgAutoSyncSpy.mockClear()
    const handlers = captureHandlers()
    await handlers['message']!(makeCtx({ chat: { id: NOT_TECH_CHAT_ID, type: 'private', first_name: 'Newbie' } }))
    expect(triggerTgAutoSyncSpy).toHaveBeenCalledTimes(1)
  })

  test('已經在 log 裡出現過的 chat_id（同一人還在等待人工確認）：不重複觸發', async () => {
    logUnknownSender({ id: ALREADY_SEEN_CHAT_ID, type: 'private', first_name: '先前已記過' }) // 預先寫一筆，模擬第一次已發生過
    triggerTgAutoSyncSpy.mockClear()
    const handlers = captureHandlers()
    await handlers['message']!(makeCtx({ chat: { id: ALREADY_SEEN_CHAT_ID, type: 'private' } }))
    expect(triggerTgAutoSyncSpy).not.toHaveBeenCalled()
  })

  test('白名單內 chat_id：不觸發（走正常路由，不進到未知 sender 分支）', async () => {
    triggerTgAutoSyncSpy.mockClear()
    const handlers = captureHandlers()
    await handlers['message']!(makeCtx({ chat: { id: REAL_TECH_CHAT_ID, type: 'private' }, message: { text: '/menu' } }))
    expect(triggerTgAutoSyncSpy).not.toHaveBeenCalled()
  })

  afterAll(() => {
    rmSync(testLogDir, { recursive: true, force: true })
  })
})
