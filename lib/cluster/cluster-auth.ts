import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { respondUniform401 } from '../security/uniform-401.ts'

// cluster 內部請求（head↔worker）的認證守門。兩個方向共用：
// - head 的 /cluster/* 路由（worker 登記、job-done 回報）
// - worker-agent 的所有路由（/health 除外，見 worker-agent.ts）
//
// 驗證手法完全比照 webhook-secret-guard.ts：自訂 header + timingSafeEqual
// 常數時間比較 + 失敗一律走 respondUniform401（401 + 空 body，先把傳輸中的
// body 讀掉再回，維持 T14/F-1 的均一回應不變式——head 的 /cluster/* 掛在
// 同一個對外 server 上，拒絕回應必須跟 catch-all/webhook guard 無法區分）。
//
// 額外一道結構性防線（僅 head 需要，worker 不經 tunnel）：head 的 8787 同時
// 被 cloudflared tunnel 對公網轉發，/cluster/* 語意上只該給同網段 worker 用。
// Cloudflare 轉發的請求必帶 CF-Connecting-IP header（邊緣注入，外部呼叫端
// 無法移除），LAN 直連的請求不會有——rejectTunnel 模式下看到這個 header
// 就直接 401，等於把整條 tunnel 路徑對 /cluster/* 封死，公網拿到 secret 也
// 打不進來（防 secret 外洩後的縱深）。LAN 上的攻擊者偽造這個 header 只會
// 害自己被拒，不構成繞過。

export const CLUSTER_TOKEN_HEADER = 'x-cluster-token'

export function createClusterAuthGuard(secret: string, opts: { rejectTunnel?: boolean } = {}): MiddlewareHandler {
  const expected = Buffer.from(secret)

  return async (c, next) => {
    if (opts.rejectTunnel && c.req.header('cf-connecting-ip') !== undefined) {
      return respondUniform401(c)
    }
    const header = c.req.header(CLUSTER_TOKEN_HEADER)
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
