// head only：監控 log 的專用 loopback intake（9429）。
//
// Phase 0 骨架：只實作 doctor 身分驗證需要的兩條路由（/health、
// /cluster/intake-identity）。真正的 POST /cluster/logs（guard + bodyLimit(8MB)
// + 每 worker/全域速率限制 + host 覆寫 + LRU 去重）是 Phase 2 的工項，本檔
// 刻意不提前實作（Rule 2：不做計畫沒寫的事）——本階段 MON_DB_ENABLED=0、
// shipper 不啟用，沒有任何呼叫端會打這條路由。
//
// 見 plan-db-as-truth-v3.2.md §3.3(a)(b)(b2)（BL-G1，9429 埠號定案 + 三條
// doctor 身分驗證）。

import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { getClusterSecret } from '../cluster/cluster-env.ts'
import { createClusterAuthGuard } from '../cluster/cluster-auth.ts'
import { respondUniform401 } from '../security/uniform-401.ts'

const IDENTITY = 'com.aladdin.monitor-log-intake'

const secret = getClusterSecret()
if (secret === null) {
  throw new Error('monitor-log-intake: CLUSTER_SHARED_SECRET 未設定（或長度不足），拒絕啟動')
}

const guard = createClusterAuthGuard(secret, { rejectTunnel: true })

const app = new Hono()

// 比照 worker-agent.ts:151-153 的既有紀律：/health 不驗證、只回存活資訊。
app.get('/health', c => c.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }))

// 只給 doctor 用（不在資料路徑上）：doctor 帶 x-cluster-token 打這條，
// 拿一組以同一把 CLUSTER_SHARED_SECRET 算出的 HMAC 簽名，藉此同時驗證
// 「監聽者是不是真的持有這把 secret」（pid 比對可能因 launchctl 重啟而
// 短暫失準，簽名驗證是內容層的證明，見 §3.3(b2)）。
app.get('/cluster/intake-identity', guard, c => {
  const nonce = c.req.query('nonce')
  if (nonce === undefined || nonce === '' || !/^[0-9a-f]+$/i.test(nonce)) {
    return c.json({ error: 'nonce required (hex)' }, 400)
  }
  const sig = createHmac('sha256', secret).update(`${nonce}:${IDENTITY}`).digest('hex')
  return c.json({ identity: IDENTITY, nonce, sig })
})

// POST /cluster/logs：Phase 2 工項，本階段尚未實作，一律 uniform 401
// （與其餘未知路徑無法區分，維持既有拒絕不變式）。
app.all('*', c => respondUniform401(c))

export default {
  fetch: app.fetch,
  port: 9429,
  hostname: '127.0.0.1',
}
