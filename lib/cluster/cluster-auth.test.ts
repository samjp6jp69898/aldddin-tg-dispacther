import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createClusterAuthGuard, CLUSTER_TOKEN_HEADER } from './cluster-auth.ts'

const SECRET = 'x'.repeat(40)

function makeApp(opts: { rejectTunnel?: boolean } = {}) {
  const app = new Hono()
  app.get('/protected', createClusterAuthGuard(SECRET, opts), c => c.json({ ok: true }))
  return app
}

describe('createClusterAuthGuard', () => {
  test('正確 token 放行', async () => {
    const res = await makeApp().request('/protected', { headers: { [CLUSTER_TOKEN_HEADER]: SECRET } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('缺 header / 錯誤 token / 長度不同的 token 一律 401 + 空 body（uniform 401 不變式）', async () => {
    const app = makeApp()
    for (const headers of [{}, { [CLUSTER_TOKEN_HEADER]: 'wrong-token-of-the-same-length-aaaaaaaaa' }, { [CLUSTER_TOKEN_HEADER]: 'short' }]) {
      const res = await app.request('/protected', { headers })
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('')
    }
  })

  test('rejectTunnel：帶 CF-Connecting-IP（經 cloudflared tunnel 進來）即使 token 正確也 401', async () => {
    const app = makeApp({ rejectTunnel: true })
    const res = await app.request('/protected', {
      headers: { [CLUSTER_TOKEN_HEADER]: SECRET, 'cf-connecting-ip': '203.0.113.9' },
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    // 沒帶 CF header（LAN 直連）+ 正確 token 才放行
    const lan = await app.request('/protected', { headers: { [CLUSTER_TOKEN_HEADER]: SECRET } })
    expect(lan.status).toBe(200)
  })

  test('未開 rejectTunnel（worker 端）時 CF header 不影響判定', async () => {
    const res = await makeApp().request('/protected', {
      headers: { [CLUSTER_TOKEN_HEADER]: SECRET, 'cf-connecting-ip': '203.0.113.9' },
    })
    expect(res.status).toBe(200)
  })
})
