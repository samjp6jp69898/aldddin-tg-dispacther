import { Hono, type Context } from 'hono'

// ops-ui 獨立 process 版（2026-09-08，使用者定案：要讓 tg-monitor 像監控其他
// hosted server 一樣，把它當一個有自己 port／PID／launchd label 的服務單獨
// 列一行）。這支 process 是純反向代理，把 /ops* 原封不動轉給主 dispatcher
// process（8787）已經掛載好、已驗證過的 /ops 實作（lib/ops-ui/routes.ts）。
//
// 為什麼不在這裡重新 import claimBugTicket／pipeline-queue／dispatch-registry
// 自己做一份：那些狀態（bugQueue/demandQueue 的 in-memory Map、
// dispatchRegistry、bug-lock 目錄觀察）只有 dispatcher 主 process 是唯一權威
// 來源。若這裡也 import 那些模組，會各自產生一份空的 in-memory 狀態——兩個
// process 對同一張票各自以為「我才是唯一在跑的」，claim.ts 原本靠同一份
// in-memory 佇列擋掉的連點/重複認領防護就整個失效。所以這支 process 刻意
// 什麼業務邏輯都不做，只搬 bytes。
//
// 只轉發 /ops 與 /health：這支 process 的職責邊界只到「幫 /ops 撐一個獨立
// 對外門面」，不是把整個 dispatcher 的攻擊面複製一份到新 port 上（webhook
// secret 路徑、mcp-proxy、cluster 路由都不該從這裡也打得到）。
//
// 安全邊界（必讀）：這支 process 只能綁 127.0.0.1（同 tg-monitor 自己的既有
// 慣例）。對外可達性完全靠 cloudflared 的 path 規則（launchd/
// cloudflared-config.yml 的 `path: ^/ops(/.*)?$`）決定，絕不能綁 0.0.0.0——
// 下游 /ops 的公司網路白名單信任 CF-Connecting-IP header（Cloudflare 邊緣
// 注入、外部呼叫端無法移除，見 lib/ops-ui/ip-allowlist.ts 檔頭），這個假設
// 只在「此 port 只能透過本機的 cloudflared connector 觸及」時成立；一旦這個
// port 對 LAN／公網直接開放，任何人偽造這個 header 轉發過去，下游就會誤判
// 成通過公司網路白名單，繞過整道防線（同 lib/cluster/cluster-auth.ts 的
// rejectTunnel 依賴同一個假設，方向相反：那邊是「有這個 header 就拒絕」，
// 這裡是「這個 header 必須只可能來自真正的 cloudflared」）。

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

const MAX_PROXY_BODY_SIZE = 1024 * 1024 // 1MB；跟 mcp-proxy.ts／webhook 同量級，防呆用，不是業務上限（下游 /ops/api/* 自己另有更嚴的 4KB）。

function stripForwardHeaders(src: Headers): Headers {
  const connectionListed = new Set(
    (src.get('connection') ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  )
  const out = new Headers()
  for (const [name, value] of src) {
    if (HOP_BY_HOP_HEADERS.has(name) || connectionListed.has(name)) continue
    if (name === 'host' || name === 'content-length' || name === 'accept-encoding') continue
    out.set(name, value)
  }
  return out
}

/** 回應 header 同理剝 hop-by-hop／content-length／content-encoding／date（本
 * process 對外回應時會自己補一個 Date，保留 upstream 的會變成重複兩個）。
 * Set-Cookie 另外處理：Headers 的 for...of 迭代對多個同名 Set-Cookie 的行為
 * 不可靠（historically 會被合併成逗號分隔字串），用 getSetCookie()（Bun/
 * Node 18+ 支援）逐條取回、逐條 append，登入/登出各自只設一個 cookie 時
 * 這條路徑跟 for...of 結果一致，但寫成保證正確的版本不留隱患。 */
function stripResponseHeaders(src: Headers): Headers {
  const out = new Headers()
  for (const [name, value] of src) {
    if (name === 'set-cookie') continue
    if (HOP_BY_HOP_HEADERS.has(name)) continue
    if (name === 'content-length' || name === 'content-encoding' || name === 'date') continue
    out.set(name, value)
  }
  const getSetCookie = (src as Headers & { getSetCookie?: () => string[] }).getSetCookie
  for (const c of typeof getSetCookie === 'function' ? getSetCookie.call(src) : []) out.append('set-cookie', c)
  return out
}

export type EdgeProxyOptions = {
  /** 上游 dispatcher 的 base URL，如 'http://127.0.0.1:8787'。不帶結尾斜線。 */
  upstreamBase: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export function createOpsUiEdgeApp(opts: EdgeProxyOptions): Hono {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())
  const startedAt = now()
  const app = new Hono()

  app.get('/health', c => c.json({ status: 'ok', uptime_seconds: Math.floor((now() - startedAt) / 1000) }))

  const forward = async (c: Context) => {
    const incoming = c.req.raw
    const url = new URL(incoming.url)
    const target = `${opts.upstreamBase}${url.pathname}${url.search}`

    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
    if (hasBody) {
      const len = incoming.headers.get('content-length')
      if (len !== null && Number(len) > MAX_PROXY_BODY_SIZE) return c.text('Payload Too Large', 413)
    }

    let upstream: Response
    try {
      upstream = await doFetch(target, {
        method: incoming.method,
        headers: stripForwardHeaders(incoming.headers),
        body: hasBody ? incoming.body : undefined,
        // Bun/undici 要求：body 是串流時必須明講 half-duplex，否則 fetch 會丟例外。
        ...(hasBody ? { duplex: 'half' } : {}),
        // /ops/auth/telegram 登入成功會回 302 → /ops/：fetch 預設會自己跟隨
        // 重導向再把「跟完之後」的最終回應交給呼叫端，等於呼叫端（瀏覽器）
        // 永遠看不到那個 302／Location，Set-Cookie 也會跟著在跟隨過程中被
        // 忽略、瀏覽器最終拿到的網址還停在 /ops/auth/telegram。必須原封不動
        // 把 upstream 的 3xx 狀態碼與 Location 交還給呼叫端，讓瀏覽器自己對
        // 公開網域重新導向（而不是對內部 upstreamBase 網址）。
        redirect: 'manual',
      } as RequestInit)
    } catch (err) {
      console.error(`ops-ui-edge: 轉發到 ${opts.upstreamBase} 失敗: ${err}`)
      return c.text('Bad Gateway', 502)
    }
    return new Response(upstream.body, { status: upstream.status, headers: stripResponseHeaders(upstream.headers) })
  }

  app.all('/ops', forward)
  app.all('/ops/*', forward)
  app.all('*', c => c.text('Not Found', 404))

  return app
}
