import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { CLUSTER_TOKEN_HEADER } from './cluster-auth.ts'
import { TEST_CLUSTER_SECRET } from './test-support/test-cluster-secret.ts'

// POST /cluster/retry（task 2，2026-09-04）：tg-monitor 的 `/api/pipelines/retry`
// 改走這條路徑，讓續跑跟一般派工共用 dispatchBug() 的分派判斷（見
// cluster-head.ts 新增的路由與檔內註解）。
//
// 這裡只驗證 guard／輸入驗證分支（401/400）——絕不能呼叫到真正的
// dispatchBug() 成功路徑：cluster-head.ts 在沒有已註冊 worker 時
// dispatch()（dispatch.ts）會退回 `submitLocal()`，也就是真的呼叫
// submitCreateMr() 去 spawn 一個背景 pipeline 行程，這在單元測試裡是絕對不
//該發生的真實副作用。「resume 走跟一般派工相同的分派判斷」這件事的核心
// 邏輯已經在 dispatch.test.ts 用完整 mock 的 DispatchDeps 驗證過（resume 透傳
// 進 job payload / local submit opts、techUser 可為 null），這裡只補 HTTP 層
// 的 guard 與輸入驗證，兩者互補、不重疊。
//
// cluster-head.ts 在 module load 當下就讀 CLUSTER_SHARED_SECRET（沒設就整組
// 路由 no-op），所以這裡必須先設環境變數、再動態 import（比照
// cluster-head-monitor-status.test.ts 既有手法）。

// 跨測試檔共用的常數（見 test-support/test-cluster-secret.ts 檔頭：bun test
// 不會給每個測試檔各自獨立的 module registry，同一次進程裡不管哪個測試檔先
// 動態 import cluster-head.ts，那個模組捕捉到的 secret 值是全部測試檔共用
// 的——各檔各自寫死不同字面值會讓後 import 的檔案 guard 測試全部誤判 401，
// 2026-09-04 實際踩過）。
const SECRET = TEST_CLUSTER_SECRET

let app: Hono

beforeAll(async () => {
  process.env.CLUSTER_SHARED_SECRET = SECRET
  const { registerClusterRoutes } = await import('./cluster-head.ts')
  app = new Hono()
  registerClusterRoutes(app)
})

async function post(body: unknown, headers: Record<string, string> = { [CLUSTER_TOKEN_HEADER]: SECRET }): Promise<Response> {
  return await app.request('/cluster/retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /cluster/retry — guard', () => {
  test('沒帶 token → 401', async () => {
    const res = await post({ ticket: 'FAQ-1' }, {})
    expect(res.status).toBe(401)
  })

  test('token 錯 → 401', async () => {
    const res = await post({ ticket: 'FAQ-1' }, { [CLUSTER_TOKEN_HEADER]: `${SECRET}x` })
    expect(res.status).toBe(401)
  })

  test('經 cloudflared tunnel 進來（帶 CF-Connecting-IP）→ 401，即使 token 正確', async () => {
    const res = await post({ ticket: 'FAQ-1' }, { [CLUSTER_TOKEN_HEADER]: SECRET, 'cf-connecting-ip': '1.2.3.4' })
    expect(res.status).toBe(401)
  })
})

describe('POST /cluster/retry — 輸入驗證（不觸及真正的派工）', () => {
  test('ticket 缺欄 → 400', async () => {
    expect((await post({})).status).toBe(400)
  })

  test('ticket 格式不是 FAQ-\\d+ → 400（含 ALDREQ- 需求單，這個按鈕不支援）', async () => {
    expect((await post({ ticket: 'ALDREQ-1' })).status).toBe(400)
    expect((await post({ ticket: 'not-a-ticket' })).status).toBe(400)
  })

  test('body 不是 JSON → 400', async () => {
    const res = await app.request('/cluster/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLUSTER_TOKEN_HEADER]: SECRET },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('triggeredByEmail 帶了但 tech-users.csv 查無此人 → 400，不靜默丟掉發起人', async () => {
    const res = await post({ ticket: 'FAQ-1', triggeredByEmail: 'definitely-not-a-real-tech-user@example.invalid' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('查無此 email')
  })
})
