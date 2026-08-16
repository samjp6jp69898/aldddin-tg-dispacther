import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createWebhookSecretGuard } from './webhook-secret-guard.ts'

const SECRET = 'a'.repeat(32)
const HEADER = 'X-Telegram-Bot-Api-Secret-Token'

function buildApp() {
  const app = new Hono()
  app.post('/webhook', createWebhookSecretGuard(SECRET), c => c.text('ok', 200))
  return app
}

describe('createWebhookSecretGuard', () => {
  test('secret_token 正確：放行到下一個 middleware', async () => {
    const res = await buildApp().request('/webhook', {
      method: 'POST',
      headers: { [HEADER]: SECRET },
    })
    expect(res.status).toBe(200)
  })

  test('secret_token 缺漏：401 + 空 body（跟 grammy hono adapter unauthorized() 一致）', async () => {
    const res = await buildApp().request('/webhook', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })

  test('secret_token 錯誤（長度相同）：401 + 空 body', async () => {
    const res = await buildApp().request('/webhook', {
      method: 'POST',
      headers: { [HEADER]: 'b'.repeat(32) },
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })

  test('secret_token 錯誤（長度不同）：401 + 空 body，不因長度不同就丟例外', async () => {
    const res = await buildApp().request('/webhook', {
      method: 'POST',
      headers: { [HEADER]: 'too-short' },
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })

  // T25 review 核心訴求：401（未過 guard）與量體控制的 429 不能被拿來當
  // 「這條路徑是否存在」的側漏訊號——這裡驗證未過 guard 的請求回應格式，
  // 跟 server.ts catch-all（app.all('*') 對猜錯路徑的回應）完全一致，
  // 都是 401 + 空 body，不會多帶任何其他資訊。
  test('未過 guard 的回應格式跟 catch-all 401 一致：status 401、body 是空字串', async () => {
    const res = await buildApp().request('/webhook', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).toBe('')
    expect(body.length).toBe(0)
  })
})
