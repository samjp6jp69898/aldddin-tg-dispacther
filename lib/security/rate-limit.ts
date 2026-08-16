import type { MiddlewareHandler } from 'hono'

// T25：webhook route 的量體控制。secret_token（見 server.ts）只驗證請求真的
// 來自 Telegram，白名單（lib/security/whitelist.ts）只驗證是不是授權
// chat_id——兩者都不擋「白名單通過之後」的高頻請求：token 一旦外洩、或有人
// 對著猜對的 webhook 路徑 + secret_token 重放，都可能在正常驗證邏輯跑完前
// 就把 ngrok 免費方案的連線配額打滿，或把下游 Notion/tracker 查詢打到過量
// （見 tasks.json T25 risk_notes）。
//
// 用最簡單的 in-memory token bucket、全域（不分來源 IP）計數：威脅情境是
// 「同一個外洩 token 被高頻重放」，不是「多個不同來源同時攻擊」，分 IP 反而
// 無助於擋下這個情境，還要多背 per-IP 記憶體成長/清理的複雜度（Rule 2：
// 不做用不到的抽象）。
//
// 前提（review 發現，見 server.ts 掛載順序）：這個 middleware 必須掛在
// lib/security/webhook-secret-guard.ts 之後——只有先確定請求真的持有正確
// secret_token，才讓它消耗全域額度，否則任何知道路徑但沒有 token 的請求也
// 能把額度打滿，連帶擋住合法 Telegram 請求。
//
// 全域 bucket 不分「哪個技術人員」是刻意的（review 發現的取捨：白名單內
// 可能不只一人同時活動，例如多人同時開選單/翻頁/認領，這些請求會疊加在
// 同一份額度上）——capacity/refill 訂得比單人操作速度寬裕不少（見下方數字），
// 換取不用做 per-chat_id 分桶的複雜度；chat_id 本來也要等 grammy 解析完
// body 才拿得到，HTTP middleware 這一層做不到，勉強做代表要打亂 T24
// bodyLimit 之前短路的設計。若之後實測仍有多人同時使用被誤擋，再考慮加
// per-chat_id 分桶（YAGNI，先不用預先做）。
// export 出來供測試直接引用真實預設值（避免測試裡的數字跟這裡的定義各自
// 為政、改一邊忘了改另一邊）。
export const DEFAULT_CAPACITY = 60 // 允許的最大瞬間爆發量：預留給「多位技術人員同時操作」的餘裕
export const DEFAULT_REFILL_PER_SECOND = 60 / 60 // 對應「每分鐘 60 次」的長期平均上限

export type TokenBucket = {
  /** 嘗試消耗一顆 token；額度足夠回 true 並扣掉，額度不足回 false（不扣）。 */
  tryConsume: () => boolean
}

/**
 * 建立一個 token bucket。`now` 可注入假時鐘供測試用（硬規則：測試不得靠
 * sleep/等待時間成立），預設用真實 Date.now()。
 */
export function createTokenBucket(
  opts: { capacity?: number; refillPerSecond?: number; now?: () => number } = {},
): TokenBucket {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY
  const refillPerSecond = opts.refillPerSecond ?? DEFAULT_REFILL_PER_SECOND
  const now = opts.now ?? Date.now

  let tokens = capacity
  let lastRefill = now()

  function tryConsume(): boolean {
    const current = now()
    const elapsedSeconds = (current - lastRefill) / 1000
    if (elapsedSeconds > 0) {
      tokens = Math.min(capacity, tokens + elapsedSeconds * refillPerSecond)
      lastRefill = current
    }
    if (tokens >= 1) {
      tokens -= 1
      return true
    }
    return false
  }

  return { tryConsume }
}

/**
 * Hono middleware：額度足夠就放行，額度用盡回 429（明確拒絕，不崩潰、不
 * 掛起）。預設吃一個全域共用的 bucket——同一個 process 內所有請求共用同一份
 * 額度，符合「全域每分鐘請求數上限」的設計（見檔頭註解）。
 */
export function createRateLimitMiddleware(bucket: TokenBucket = createTokenBucket()): MiddlewareHandler {
  return async (c, next) => {
    if (!bucket.tryConsume()) {
      return c.text('Too Many Requests', 429)
    }
    await next()
  }
}
