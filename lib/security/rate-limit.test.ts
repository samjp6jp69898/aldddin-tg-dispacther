import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { DEFAULT_CAPACITY, DEFAULT_REFILL_PER_SECOND, createRateLimitMiddleware, createTokenBucket } from './rate-limit.ts'

// 硬規則：測試不得靠 sleep/等待時間成立。這裡全程用可控的假時鐘（一個閉包
// 變數 + 手動遞增），不呼叫真正的 Date.now() 或等待，時間推進是確定性的。
function makeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('createTokenBucket — 純邏輯層', () => {
  test('額度內的請求全部通過', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1, now: clock.now })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
  })

  test('超過瞬間爆發量的請求被拒絕（不崩潰、單純回 false）', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1, now: clock.now })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false) // 第三顆：額度用盡
    expect(bucket.tryConsume()).toBe(false) // 持續拒絕，不會意外放行
  })

  test('時間經過後依 refill rate 補回額度，且不超過 capacity 上限', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1, now: clock.now })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)

    clock.advance(500) // 0.5 秒 * 1/s = 補回 0.5 顆，還不夠 1 顆
    expect(bucket.tryConsume()).toBe(false)

    clock.advance(600) // 累計 1.1 秒 = 補回 1.1 顆，足夠消耗 1 顆
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false) // 沒有多的額度

    clock.advance(10_000) // 補回遠超過 capacity，驗證有被夾住不會無限累積
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false) // 只夾在 capacity=2，不會因為長時間累積變成可以連續消耗 3 次
  })

  test('正常使用情境（單一使用者、間隔遠大於 refill 速度）不會被誤擋：模擬 5 分鐘內每 10 秒一次請求', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 30, refillPerSecond: 30 / 60, now: clock.now })
    for (let i = 0; i < 30; i++) {
      expect(bucket.tryConsume()).toBe(true)
      clock.advance(10_000)
    }
  })

  // review 發現的驗證缺口：先前只測過「單一使用者」，沒測過「白名單內多位
  // 技術人員同時活動」這個真實會發生的正常情境——全域 bucket 不分使用者，
  // 多人同時開選單/翻頁/認領的請求會疊加在同一份額度上。這裡用真實預設值
  // （DEFAULT_CAPACITY/DEFAULT_REFILL_PER_SECOND）模擬 5 位技術人員在 20 秒
  // 內各自操作 8 次（開選單、查 BUG 列表、翻頁兩次、認領…等典型單次 session
  // 的請求數量級），共 40 次、彼此交錯，驗證即使疊加也不會被誤擋。
  test('正常使用情境（多位技術人員同時活動）不會被誤擋：5 人各 8 次請求、20 秒內交錯發生', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: DEFAULT_CAPACITY, refillPerSecond: DEFAULT_REFILL_PER_SECOND, now: clock.now })

    const USERS = 5
    const REQUESTS_PER_USER = 8
    for (let round = 0; round < REQUESTS_PER_USER; round++) {
      for (let user = 0; user < USERS; user++) {
        expect(bucket.tryConsume()).toBe(true)
      }
      clock.advance(2_500) // 20 秒 / 8 輪 ≈ 每輪間隔 2.5 秒
    }
  })

  test('真的高頻重放：用掉真實預設 capacity 之後才會被擋，確認調高門檻後防護依舊有效', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: DEFAULT_CAPACITY, refillPerSecond: DEFAULT_REFILL_PER_SECOND, now: clock.now })

    for (let i = 0; i < DEFAULT_CAPACITY; i++) {
      expect(bucket.tryConsume()).toBe(true)
    }
    // 同一瞬間（時間沒推進，refill 為 0）繼續打，應立即被擋
    expect(bucket.tryConsume()).toBe(false)
    expect(bucket.tryConsume()).toBe(false)
  })
})

// M4：proxy 的已認證額度要「轉發前先查、確定認證成功後才扣」，所以需要一個
// 不消耗 token 的查詢（見 mcp-proxy.ts 的 quota gate）。
describe('createTokenBucket.hasTokens — 只查詢、不消耗', () => {
  test('查詢本身不扣額度：連查多次之後仍能消耗滿額', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 0, now: clock.now })
    for (let i = 0; i < 10; i++) {
      expect(bucket.hasTokens()).toBe(true)
    }
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)
  })

  test('額度用盡時回 false，與 tryConsume 的判定一致', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 0, now: clock.now })
    expect(bucket.hasTokens()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.hasTokens()).toBe(false)
    expect(bucket.tryConsume()).toBe(false)
  })

  // 這是實作上最容易錯的一點：hasTokens 若忘了先補回時間額度，就會在額度其實
  // 已經補回來的時候回報 false，讓合法請求被擋在轉發之前。
  test('查詢前會先補回這段時間累積的額度（不會回報過期的「已用盡」）', () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: clock.now })
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.hasTokens()).toBe(false)

    clock.advance(500) // 補回 0.5 顆，還不夠
    expect(bucket.hasTokens()).toBe(false)

    clock.advance(600) // 累計 1.1 秒，足夠 1 顆
    expect(bucket.hasTokens()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
  })
})

describe('createRateLimitMiddleware — Hono 路由層', () => {
  function buildApp(bucket: ReturnType<typeof createTokenBucket>) {
    const app = new Hono()
    app.post('/webhook', createRateLimitMiddleware(bucket), c => c.text('ok', 200))
    return app
  }

  test('額度內：回應正常放行，不是 429', async () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 0, now: clock.now })
    const app = buildApp(bucket)

    const res = await app.request('/webhook', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('超額請求：明確回 429，不是崩潰或掛起（fetch 正常拿到回應）', async () => {
    const clock = makeClock()
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 0, now: clock.now })
    const app = buildApp(bucket)

    const first = await app.request('/webhook', { method: 'POST' })
    expect(first.status).toBe(200)

    const second = await app.request('/webhook', { method: 'POST' })
    expect(second.status).toBe(429)
    expect(await second.text()).toBe('Too Many Requests')
  })
})
