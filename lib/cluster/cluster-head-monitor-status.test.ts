import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { CLUSTER_TOKEN_HEADER } from './cluster-auth.ts'
import { __resetWorkerMonitorStatusesForTest, getWorkerMonitorStatus, listWorkerMonitorStatuses } from './worker-monitor-status.ts'

// POST /cluster/monitor-status（plan-db-as-truth-v3.2.md MJ-E4，§6.8(e)）：
// 本案往 head 8787 唯一新增的路由（【G:MN-G8】），與既有 /cluster/register、
// /cluster/job-done 完全同型——同一組 guard、同一個 secret、低頻小 payload。
//
// cluster-head.ts 在 module load 當下就讀 CLUSTER_SHARED_SECRET（沒設就整組
// 路由 no-op），所以這裡必須先設環境變數、再動態 import。

const SECRET = 'monitor-status-test-secret-0123456789'

let app: Hono

beforeAll(async () => {
  process.env.CLUSTER_SHARED_SECRET = SECRET
  const { registerClusterRoutes } = await import('./cluster-head.ts')
  app = new Hono()
  registerClusterRoutes(app)
})

beforeEach(() => {
  __resetWorkerMonitorStatusesForTest()
})

async function post(body: unknown, headers: Record<string, string> = { [CLUSTER_TOKEN_HEADER]: SECRET }): Promise<Response> {
  return await app.request('/cluster/monitor-status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /cluster/monitor-status — guard', () => {
  test('沒帶 token → 401（均一回應，不寫入任何狀態）', async () => {
    const res = await post({ worker: 'w1', spool_depth: 1 }, {})
    expect(res.status).toBe(401)
    expect(listWorkerMonitorStatuses()).toHaveLength(0)
  })

  test('token 錯 → 401', async () => {
    const res = await post({ worker: 'w1', spool_depth: 1 }, { [CLUSTER_TOKEN_HEADER]: `${SECRET}x` })
    expect(res.status).toBe(401)
    expect(listWorkerMonitorStatuses()).toHaveLength(0)
  })

  test('經 cloudflared tunnel 進來（帶 CF-Connecting-IP）→ 401，即使 token 正確', async () => {
    const res = await post({ worker: 'w1', spool_depth: 1 }, { [CLUSTER_TOKEN_HEADER]: SECRET, 'cf-connecting-ip': '1.2.3.4' })
    expect(res.status).toBe(401)
    expect(listWorkerMonitorStatuses()).toHaveLength(0)
  })
})

describe('POST /cluster/monitor-status — 正常寫入與輸入收斂', () => {
  test('合法 payload → 200 並存進記憶體（receivedAt 由 head 蓋章）', async () => {
    const before = Date.now()
    const res = await post({ worker: 'landon2', spool_depth: 12, oldest_age_s: 34, db_writable: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const st = getWorkerMonitorStatus('landon2')
    expect(st).toMatchObject({ worker: 'landon2', spoolDepth: 12, oldestAgeS: 34, dbWritable: true })
    expect(st!.receivedAt).toBeGreaterThanOrEqual(before)
  })

  test('同一台重複回報 → 覆蓋成最新一筆，不累積', async () => {
    await post({ worker: 'landon2', spool_depth: 1, oldest_age_s: 1, db_writable: true })
    await post({ worker: 'landon2', spool_depth: 999, oldest_age_s: 2, db_writable: false })

    expect(listWorkerMonitorStatuses()).toHaveLength(1)
    expect(getWorkerMonitorStatus('landon2')).toMatchObject({ spoolDepth: 999, dbWritable: false })
  })

  test('worker 名稱格式不合（含路徑字元）→ 400，不寫入', async () => {
    const res = await post({ worker: '../../etc/passwd', spool_depth: 1 })
    expect(res.status).toBe(400)
    expect(listWorkerMonitorStatuses()).toHaveLength(0)
  })

  test('worker 缺欄 → 400', async () => {
    expect((await post({ spool_depth: 1 })).status).toBe(400)
  })

  test('數值欄不合法（NaN／負數／型別錯）→ 收斂成 null，但回報本身仍留下時間戳', async () => {
    const res = await post({ worker: 'landon2', spool_depth: 'lots', oldest_age_s: -1, db_writable: 'yes' })
    expect(res.status).toBe(200)
    expect(getWorkerMonitorStatus('landon2')).toMatchObject({ spoolDepth: null, oldestAgeS: null, dbWritable: null })
  })

  test('body 不是 JSON → 400', async () => {
    const res = await app.request('/cluster/monitor-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLUSTER_TOKEN_HEADER]: SECRET },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
