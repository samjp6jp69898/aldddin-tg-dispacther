import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from 'hono/bun'
import { respondUniform401 } from '../security/uniform-401.ts'

// ops-ui 的「公司網路」門檻（2026-09-08）：/ops/* 只允許 OPS_ALLOWED_CIDRS
// 名單內的來源 IP。來源 IP 的判定：
//   1. 經 cloudflared tunnel 進來的請求，Cloudflare 邊緣一定注入
//      CF-Connecting-IP（外部呼叫端無法移除），以它為準——這是公網使用者
//      唯一的進入路徑（cluster-auth.ts 對同一個 header 的依賴說明同樣適用：
//      換掉 cloudflared 就要重新評估這道防線）。
//   2. 沒有這個 header（LAN 直連 8787）就退回 socket 的對端位址。
//   3. 兩者都拿不到（測試環境 app.request() 沒有 Bun server、或未知位址）
//      一律視為未知 → 拒絕（fail-closed）。
// 名單為空（未設定 OPS_ALLOWED_CIDRS）同樣全部拒絕：寧可整個 UI 打不開，
// 也不要因為漏填一個變數就把認領入口對公網敞開。
//
// 拒絕回應與 server.ts 的 catch-all 完全一致（401 + 空 body，見
// uniform-401.ts）：公司網路以外的人看 /ops 跟看一條不存在的路徑無法區分。
// 被拒的 IP 只記到 stderr（launchd-server.err.log），讓維運者能從 log 找出
// 該加進白名單的實際出口 IP，不對外提供任何「你的 IP 是什麼」端點。

export type Cidr = { family: 4 | 6; base: bigint; bits: number }

const MAX_BITS: Record<4 | 6, number> = { 4: 32, 6: 128 }

function parseIpv4(s: string): bigint | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function parseIpv6(s: string): bigint | null {
  if (s.includes('%')) s = s.slice(0, s.indexOf('%')) // zone id（fe80::1%en0）
  const doubleColon = s.split('::')
  if (doubleColon.length > 2) return null
  const expand = (part: string): string[] => (part === '' ? [] : part.split(':'))
  let head = expand(doubleColon[0] ?? '')
  let tail = doubleColon.length === 2 ? expand(doubleColon[1] ?? '') : []
  // 結尾可能是內嵌的 IPv4（::ffff:1.2.3.4）
  const last = (tail.length > 0 ? tail : head)[(tail.length > 0 ? tail : head).length - 1]
  if (last !== undefined && last.includes('.')) {
    const v4 = parseIpv4(last)
    if (v4 === null) return null
    const hi = ((v4 >> 16n) & 0xffffn).toString(16)
    const lo = (v4 & 0xffffn).toString(16)
    if (tail.length > 0) tail = [...tail.slice(0, -1), hi, lo]
    else head = [...head.slice(0, -1), hi, lo]
  }
  const groups = head.length + tail.length
  if (doubleColon.length === 2 ? groups > 7 : groups !== 8) return null
  const full = [...head, ...Array(8 - groups).fill('0'), ...tail]
  let value = 0n
  for (const g of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    value = (value << 16n) | BigInt(parseInt(g, 16))
  }
  return value
}

/** 把 IP 字串正規化成可比對的數值；IPv4-mapped IPv6（::ffff:a.b.c.d）視為
 * IPv4，讓白名單只寫 IPv4 也能命中 Bun requestIP 回的 mapped 位址。 */
export function parseIp(raw: string): { family: 4 | 6; value: bigint } | null {
  const s = raw.trim()
  if (s === '') return null
  if (!s.includes(':')) {
    const v4 = parseIpv4(s)
    return v4 === null ? null : { family: 4, value: v4 }
  }
  const v6 = parseIpv6(s)
  if (v6 === null) return null
  // ::ffff:a.b.c.d → 高 96 bit 恰為 0x0000_0000_0000_0000_0000_ffff
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn }
  return { family: 6, value: v6 }
}

/**
 * 解析逗號分隔的 CIDR 清單（`61.222.239.250/32, 10.0.0.0/8, 2001:db8::/32`；
 * 沒寫 /bits 視為單一位址）。任何一項格式錯誤就整個丟例外——啟動時就炸，
 * 不要讓一個打錯的項目被靜默忽略後其他項目照常放行。
 */
export function parseCidrList(raw: string | undefined): Cidr[] {
  const out: Cidr[] = []
  for (const item of (raw ?? '').split(',')) {
    const entry = item.trim()
    if (entry === '') continue
    const [ipPart, bitsPart, ...rest] = entry.split('/')
    if (rest.length > 0 || ipPart === undefined) throw new Error(`OPS_ALLOWED_CIDRS 格式錯誤：${entry}`)
    const ip = parseIp(ipPart)
    if (ip === null) throw new Error(`OPS_ALLOWED_CIDRS 不是合法 IP：${entry}`)
    const maxBits = MAX_BITS[ip.family]
    const bits = bitsPart === undefined ? maxBits : Number(bitsPart)
    if (!/^\d+$/.test(bitsPart ?? '0') || !Number.isInteger(bits) || bits < 0 || bits > maxBits) {
      throw new Error(`OPS_ALLOWED_CIDRS 前綴長度不合法：${entry}`)
    }
    const mask = bits === 0 ? 0n : ((1n << BigInt(maxBits)) - 1n) ^ ((1n << BigInt(maxBits - bits)) - 1n)
    out.push({ family: ip.family, base: ip.value & mask, bits })
  }
  return out
}

export function isIpAllowed(ip: string, cidrs: Cidr[]): boolean {
  const parsed = parseIp(ip)
  if (parsed === null) return false
  for (const cidr of cidrs) {
    if (cidr.family !== parsed.family) continue
    const maxBits = MAX_BITS[cidr.family]
    const shift = BigInt(maxBits - cidr.bits)
    if (parsed.value >> shift === cidr.base >> shift) return true
  }
  return false
}

/** 預設的來源 IP 判定（見檔頭 1.→2.→3.）。測試可透過 opts.resolveIp 覆寫。 */
export function resolveClientIp(c: Context): string | null {
  const cf = c.req.header('cf-connecting-ip')
  if (cf !== undefined && cf.trim() !== '') return cf.trim()
  try {
    // hono/bun 的 getConnInfo 在沒有 Bun server 的環境（測試 app.request()）
    // 會 throw，接住視為未知。
    const addr = getConnInfo(c).remote.address
    return addr && addr.trim() !== '' ? addr : null
  } catch {
    return null
  }
}

export function createIpAllowlistGuard(opts: {
  cidrs: Cidr[]
  resolveIp?: (c: Context) => string | null
  onDeny?: (ip: string | null, path: string) => void
}): MiddlewareHandler {
  const resolveIp = opts.resolveIp ?? resolveClientIp
  const onDeny = opts.onDeny ?? ((ip, path) => console.error(`ops-ui: 來源 IP 不在 OPS_ALLOWED_CIDRS 內，拒絕 ip=${ip ?? '(未知)'} path=${path}`))
  return async (c, next) => {
    const ip = resolveIp(c)
    if (ip === null || !isIpAllowed(ip, opts.cidrs)) {
      onDeny(ip, c.req.path)
      return respondUniform401(c)
    }
    await next()
  }
}
