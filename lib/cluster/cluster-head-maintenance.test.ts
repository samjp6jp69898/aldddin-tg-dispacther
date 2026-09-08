import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { CLUSTER_TOKEN_HEADER } from './cluster-auth.ts'
import { TEST_CLUSTER_SECRET } from './test-support/test-cluster-secret.ts'

// POST /cluster/maintenance（2026-09-08，tg-monitor 手動控制維護模式）：跟
// cluster-head-retry.test.ts 同一套紀律——這裡只驗證 guard／輸入驗證分支
// （401/400），絕不能呼叫到真正成功的 `{on: true|false}` + 合法 token 路徑：
// 那會呼叫 maintenanceMode.setOn() 真的寫入
// telegram-dispatcher/logs/maintenance-mode.json（這台機器上 head 實際部署
// 讀寫的同一份檔案，不是測試專用的隔離路徑——跟 /cluster/worker/:name/disable
// 等既有路由完全同一種風險，那幾支也是只到 guard 層就不再往下測，見
// worker-registry.ts 的獨立單元測試已經覆蓋 setOn 本身的邏輯）。
//
// cluster-head.ts 在 module load 當下就讀 CLUSTER_SHARED_SECRET，所以必須先
// 設環境變數、再動態 import（比照 cluster-head-monitor-status.test.ts）。
const SECRET = TEST_CLUSTER_SECRET

let app: Hono

beforeAll(async () => {
  process.env.CLUSTER_SHARED_SECRET = SECRET
  const { registerClusterRoutes } = await import('./cluster-head.ts')
  app = new Hono()
  registerClusterRoutes(app)
})

async function post(body: unknown, headers: Record<string, string> = { [CLUSTER_TOKEN_HEADER]: SECRET }): Promise<Response> {
  return await app.request('/cluster/maintenance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /cluster/maintenance — guard', () => {
  test('沒帶 token → 401', async () => {
    const res = await post({ on: true }, {})
    expect(res.status).toBe(401)
  })

  test('token 錯 → 401', async () => {
    const res = await post({ on: true }, { [CLUSTER_TOKEN_HEADER]: `${SECRET}x` })
    expect(res.status).toBe(401)
  })

  test('經 cloudflared tunnel 進來（帶 CF-Connecting-IP）→ 401，即使 token 正確', async () => {
    const res = await post({ on: true }, { [CLUSTER_TOKEN_HEADER]: SECRET, 'cf-connecting-ip': '1.2.3.4' })
    expect(res.status).toBe(401)
  })
})

describe('POST /cluster/maintenance — 輸入驗證', () => {
  test('缺 on 欄位 → 400', async () => {
    expect((await post({})).status).toBe(400)
  })

  test('on 不是 boolean → 400', async () => {
    expect((await post({ on: 'yes' })).status).toBe(400)
  })

  test('body 不是 JSON → 400', async () => {
    const res = await app.request('/cluster/maintenance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLUSTER_TOKEN_HEADER]: SECRET },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
