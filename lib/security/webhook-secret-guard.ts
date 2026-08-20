import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { respondUniform401 } from './uniform-401.ts'

const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token'

// T25 review 發現：rate limit（見 rate-limit.ts）必須確定只有真正持有正確
// secret_token 的請求才會消耗全域額度，否則任何知道 webhook 路徑、但沒有
// secret_token 的請求也能把額度打滿，連帶讓持有真正 token 的合法 Telegram
// 請求被 429——而且 429 跟 catch-all 的 401（server.ts app.all('*')）回應
// 不同，會變成一個新的「這條路徑存在」side channel，直接破壞 T14 刻意做的
// 均一回應防線（猜錯路徑／secret 錯誤都回一模一樣的 401 + 空 body）。
//
// grammy 的 secret_token 驗證是 webhookCallback 內部才做（見
// node_modules/grammy/out/convenience/webhook.js compareSecretToken），沒辦法
// 插在 rate limit 跟 webhookCallback 中間、又不重新驗證一次——所以這裡自己
// 做一次等價驗證，通過才放行到 rate limit，沒通過的回應格式刻意跟 grammy
// hono adapter 的 unauthorized()（frameworks.js：c.status(401); c.body('')）
// 完全一致，維持跟 catch-all 401 無法區分。用 node:crypto timingSafeEqual
// 常數時間比較，理由跟 grammy 自己的 compareSecretToken 一樣：header 是明碼
// 傳輸，比較邏輯本身不該用 `===` 這種會因為提早跳出而洩漏差異位置的寫法
// （用naive比較等於在 grammy 已經做好的防護之前，自己重新開一個計時側錄
// 破口）。webhookCallback 通過後還會再驗一次 secret_token，是可接受的
// 重複（cheap，不是本次要解決的問題）。
//
// F-1 之後兩個失敗分支改走 lib/security/uniform-401.ts：回應位元組完全不變，
// 差別是送出之前會先把還在傳輸中的 request body 讀掉丟棄，讓「secret 錯誤」
// 與 catch-all、proxy 各道 guard 連「回應在請求生命週期的哪個時點送出」都
// 一致（理由見該模組檔頭）。只影響驗證失敗的請求——通過驗證的正常 Telegram
// update 直接 next()，body 原封不動交給 bodyLimit 與 webhookCallback。
export function createWebhookSecretGuard(expectedToken: string): MiddlewareHandler {
  const expected = Buffer.from(expectedToken)

  return async (c, next) => {
    const header = c.req.header(SECRET_HEADER)
    if (header === undefined) {
      return respondUniform401(c)
    }
    const actual = Buffer.from(header)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return respondUniform401(c)
    }
    await next()
  }
}
