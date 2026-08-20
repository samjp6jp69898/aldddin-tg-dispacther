// 「均一 401」的單一定義處。
//
// 這個 server 對外的所有拒絕都必須長得一模一樣——那正是 T14 / M1 兩輪修正
// 的核心不變式：猜錯 webhook 路徑、猜錯 proxy 前綴、前綴存在但認證失敗、
// 前綴存在但後端沒開，外部都只能看到 `401 + 空 body`，一個請求都問不出拓撲。
// 原本這條不變式是靠三個地方各自手寫 `c.status(401); c.body('')` 維持的
// （server.ts 的 catch-all、webhook-secret-guard.ts、mcp-proxy.ts），三份
// 拷貝就是三個各自會漂移的點，這個模組把它收成一處。
//
// 「一模一樣」不只是回應的位元組，還包含**回應是在請求生命週期的哪個時點
// 送出的**（F-1 的教訓，見下面 consumePendingRequestBody 的說明）。
//
// 安全紀律（沿用 mcp-proxy.ts 檔頭）：本模組嚴禁 console.log / console.error
// 印出 request/response 的 body 或 headers——/login 的明文密碼會流經這裡。

import type { Context } from 'hono'

// 排掉的上限跟 mcp-proxy 的 MAX_PROXY_BODY_SIZE、server.ts 的
// MAX_WEBHOOK_BODY_SIZE 同一個量級，理由見 consumePendingRequestBody。
export const MAX_DISCARD_BODY_SIZE = 1024 * 1024 // 1MB

/**
 * 回 401 之前，先把還在傳輸中的 request body 讀掉丟棄（不緩衝、O(1) 記憶體）。
 *
 * 為什麼「拒絕」也要讀 body——F-1：帶 body 的請求若在 body 還在傳輸途中就被
 * 回應、而且那條入站串流已經被讀過一部分又被中止（proxy 把 `c.req.raw.body`
 * 交給 fetch 串流轉發、上游沒讀 body 就先回認證失敗時就是這個情形），Bun 會
 * 判定這個請求被中止，直接在 Hono 的回應路徑之外送出 `400 + 空 body`。實測
 * 這種 400 只在「前綴存在且後端真的在跑」時出現（600 發約 15 發），前綴不存在
 * 或後端沒開一發都沒有——單一訊號同時還原了 M1 想遮蔽的「前綴是否存在」與
 * 「後端是否活著」。
 *
 * 而「讀完才回應」本身也必須一致地套用到**每一條**拒絕路徑，否則會換來一個更
 * 大的訊號：慢速上傳的攻擊者只要量「回應是不是在我還沒送完 body 就先回來」，
 * 就能區分出哪條路徑有真的在處理這個請求。實測（200KB 分 20 段、每段間隔
 * 15ms）只讓 proxy 轉發那條路徑讀完 body、其他路徑維持立刻回應時，差距是
 * 307ms vs 1ms——比原本那個機率型 400 還好用。所以 proxy 的每道 guard、
 * server.ts 的 catch-all、webhook secret guard 全部走這裡。
 *
 * 上限與提前放棄：
 * - 已宣告 Content-Length 超過上限的請求直接不讀（立刻回 401）。這跟 hono
 *   bodyLimit 在同樣情況下的短路時機一致，兩邊才不會又差出一個時間差。
 * - 沒有 Content-Length（chunked）時邊讀邊計數，讀到上限就停——同樣對齊
 *   bodyLimit 串流模式丟例外的時機。
 * 兩道上限一起保證：拒絕一個請求最多只讀 1MB，攻擊者無法用無限長的 body 讓
 * 這裡永遠讀下去。讀到的內容一律丟棄，不進記憶體、不進 log。
 */
export async function consumePendingRequestBody(req: Request, maxBytes: number = MAX_DISCARD_BODY_SIZE): Promise<void> {
  const body = req.body
  // body 已經被讀完／正在被別人讀（例如 proxy 已經 arrayBuffer() 過）就沒事做。
  if (body === null || body.locked || req.bodyUsed) return

  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return

  const reader = body.getReader()
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      if (seen >= maxBytes) break
    }
  } catch {
    // 連線已經斷了或串流已被中止：沒有可做的補救，也不能 log（見檔頭紀律）。
    // 未處理的 rejection 反而會變成噪音。
  }
}

/**
 * 對外唯一的拒絕回應：401 + 空 body，且在把還在傳輸中的 request body 讀掉
 * 之後才送出。這正是 grammy hono adapter 對 secret_token 錯誤的原生回應
 * （node_modules/grammy/out/convenience/frameworks.js 的 hono() adapter
 * unauthorized 分支：c.status(401); c.body("")），不是我們自己另外編一種
 * 格式去湊巧一致。
 */
export async function respondUniform401(c: Context): Promise<Response> {
  await consumePendingRequestBody(c.req.raw)
  c.status(401)
  return c.body('')
}
