// head only：監控 log 的專用 loopback intake（9429）。
//
// Phase 0 骨架只實作了 doctor 身分驗證需要的兩條路由（/health、
// /cluster/intake-identity）。本檔在此基礎上補上 Phase 2 工項：
// `POST /cluster/logs`（guard + bodyLimit(8MB) + 每 worker/全域速率限制 +
// host 覆寫 + LRU 去重 + 轉寫 VictoriaLogs）。
//
// 見 plan-db-as-truth-v3.2.md §3.3(a)(b)(b2)(c)(d)(e)（BL-G1，9429 埠號定案、
// 三條 doctor 身分驗證、§3.3(c) 的具體數值、§3.3(d) 的失敗/offset/去重語意、
// §3.3(e) 的 host 覆寫）。
//
// 範圍聲明（誠實記錄，不在本檔內、留給後續工項）：
// - worker 端實際的檔案 tailing + 遮罩（lib/log-shipper/redaction.ts）+
//   常駐 shipper 迴圈**不在本檔**——那是 worker-agent.ts 的工項，且遮罩模組
//   （§7.3 的 11 條 regex）尚未存在。派工 prompt 明訂「若計畫歸 Phase 7 就
//   只留介面不實作」，本輪判斷：完整遮罩規則需要獨立驗證（L1/L2 兩層關門
//   條件），不應由本檔憑空杜撰，留待該模組就位後再串接。
// - §7.3 明訂「head 端不再信任 worker 已遮罩、再套一次」——這一步依賴同一支
//   尚不存在的 redaction.ts，本檔目前**未對收到的內容做二次遮罩**，是已知
//   缺口，不是遺漏，見下方 forwardToVictoriaLogs 的註解。

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createHash, createHmac } from 'node:crypto'
import { join } from 'node:path'
import { getClusterSecret, WORKER_NAME_RE } from '../cluster/cluster-env.ts'
import { createClusterAuthGuard } from '../cluster/cluster-auth.ts'
import { createWorkerRegistry } from '../cluster/worker-registry.ts'
import { respondUniform401 } from '../security/uniform-401.ts'
import { MON_HOST } from '../monitor-db/env.ts'

const IDENTITY = 'com.aladdin.monitor-log-intake'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const WORKERS_FILE = join(LOG_DIR, 'cluster-workers.json')

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

// ─────────────────────────────────────────────────────────────────────────
// POST /cluster/logs（§3.3(c) 的具體數值）
// ─────────────────────────────────────────────────────────────────────────

const BODY_LIMIT_BYTES = 8 * 1024 * 1024 // §3.3(c)：bodyLimit 8MB，掛在 route 自己身上
const MAX_LINE_BYTES = 2 * 1024 * 1024 // §7.2：單行上限 2MB（-insert.maxLineSizeBytes 對齊）
const RETRY_AFTER_SECONDS = '30'

/** 簡單 token bucket，支援一次消耗任意 amount（既有 lib/security/rate-limit.ts
 * 的 createTokenBucket 只支援每次消耗 1 顆，byte 額度需要變動消耗量，故在此
 * 自成一支——本檔自己的路由專用，不影響既有模組）。export 供單元測試直接
 * 驗證額度演算法，不需要經過完整 HTTP 路由（那需要 CLUSTER_SHARED_SECRET
 * 與真實名冊檔，見 intake-server.test.ts 的檔頭說明）。 */
export function createAmountBucket(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
  let tokens = capacity
  let last = now()
  return {
    tryConsume(amount: number): boolean {
      const t = now()
      const elapsedSeconds = (t - last) / 1000
      if (elapsedSeconds > 0) {
        tokens = Math.min(capacity, tokens + elapsedSeconds * refillPerSecond)
        last = t
      }
      if (tokens >= amount) {
        tokens -= amount
        return true
      }
      return false
    },
  }
}

type AmountBucket = ReturnType<typeof createAmountBucket>

// 每 worker：60 req/min（burst 120）且 48MB/min；全域（所有 worker 合計）：256MB/min。
const PER_WORKER_REQ_CAPACITY = 120
const PER_WORKER_REQ_REFILL_PER_SEC = 60 / 60
const PER_WORKER_BYTES_CAPACITY = 48 * 1024 * 1024
const PER_WORKER_BYTES_REFILL_PER_SEC = (48 * 1024 * 1024) / 60
const GLOBAL_BYTES_CAPACITY = 256 * 1024 * 1024
const GLOBAL_BYTES_REFILL_PER_SEC = (256 * 1024 * 1024) / 60

const perWorkerReqBuckets = new Map<string, AmountBucket>()
const perWorkerByteBuckets = new Map<string, AmountBucket>()
const globalByteBucket = createAmountBucket(GLOBAL_BYTES_CAPACITY, GLOBAL_BYTES_REFILL_PER_SEC)

function getWorkerBuckets(worker: string): { req: AmountBucket; bytes: AmountBucket } {
  let req = perWorkerReqBuckets.get(worker)
  if (!req) {
    req = createAmountBucket(PER_WORKER_REQ_CAPACITY, PER_WORKER_REQ_REFILL_PER_SEC)
    perWorkerReqBuckets.set(worker, req)
  }
  let bytes = perWorkerByteBuckets.get(worker)
  if (!bytes) {
    bytes = createAmountBucket(PER_WORKER_BYTES_CAPACITY, PER_WORKER_BYTES_REFILL_PER_SEC)
    perWorkerByteBuckets.set(worker, bytes)
  }
  return { req, bytes }
}

// §3.3(d)：去重由 head 端做，不靠 VictoriaLogs。固定容量 100 萬筆的 LRU
// 集合（純記憶體，行程重啟即清空）。best-effort，誠實聲明見檔頭引用的
// §3.3(d) 原文——重複行不影響正確性判定，只影響檢視體驗；缺口才是結構上
// 不會發生的那一半。
const DEDUP_CAPACITY = 1_000_000

export interface LruDedupSet {
  /** 命中即回 true（並把該 id touch 到最新）；未命中則記錄下來並回 false。 */
  isDuplicate: (id: string) => boolean
  size: () => number
}

/** capacity 可注入，供測試用小容量驗證滿載淘汰行為，不用真的塞 100 萬筆。 */
export function createLruDedupSet(capacity: number = DEDUP_CAPACITY): LruDedupSet {
  const seen = new Map<string, true>()
  return {
    isDuplicate(id: string): boolean {
      if (seen.has(id)) {
        // LRU touch：刪了再插回去，讓它排到 Map 迭代順序的最後（最新）。
        seen.delete(id)
        seen.set(id, true)
        return true
      }
      seen.set(id, true)
      if (seen.size > capacity) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      return false
    },
    size: () => seen.size,
  }
}

const dedupSet = createLruDedupSet(DEDUP_CAPACITY)

/** line_id = SHA-256(host ‖ path ‖ inode ‖ byte_offset).slice(0,16)（§3.3(d) 原文）。
 * host 用「驗證過的 worker 名稱」（即將覆寫進每一行 stream field 的那個值），
 * 不用 body 內可能夾帶的任何值。 */
export function computeLineId(host: string, path: string, inode: number, offset: number): string {
  return createHash('sha256').update(`${host}␟${path}␟${inode}␟${offset}`).digest('hex').slice(0, 16)
}

export interface LogLineIn {
  path: string
  inode: number
  offset: number
  ts?: string
  content?: string
  /** §7.2：>2MB 的行不送原文，改送截斷摘要。 */
  truncated?: boolean
  origBytes?: number
  head4k?: string
  tail4k?: string
  ticket?: string | null
  runId?: string | null
  kind?: string | null
  source?: string
}

export function isLogLineIn(v: unknown): v is LogLineIn {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Partial<LogLineIn>
  return typeof o.path === 'string' && o.path.length > 0 && o.path.length <= 512 && typeof o.inode === 'number' && typeof o.offset === 'number'
}

/** 伺服器端也做一次超大行防護（縱深防禦——worker 理論上已依 §7.2 截斷過，
 * head 端不信任這件事，見檔頭「未對收到的內容做二次遮罩」旁的同一個理由：
 * 不信任來源已經做過的事）。原地改寫傳入的物件，不複製整份陣列。 */
export function enforceLineSizeLimit(line: LogLineIn): void {
  if (line.truncated) return
  const content = line.content ?? ''
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes <= MAX_LINE_BYTES) return
  line.truncated = true
  line.origBytes = bytes
  line.head4k = content.slice(0, 4096)
  line.tail4k = content.slice(-4096)
  line.content = undefined
}

function loadWorkerNames(): Set<string> {
  try {
    return new Set(createWorkerRegistry(WORKERS_FILE).list().map(w => w.name))
  } catch {
    // 名冊檔不存在／壞掉：保守當「沒有任何已知 worker」，全部請求會被拒絕
    // 在 400（而不是誤放行未知來源）——這條路徑本來就只該在名冊真的存在
    // 內容時被打。
    return new Set()
  }
}

/**
 * 轉寫 VictoriaLogs（127.0.0.1:9428，Basic Auth，§3.3(a)(d)）。
 *
 * 誠實聲明（§7.3 的缺口，見檔頭）：正確做法是「head 端不再信任 worker 已
 * 遮罩、再套一次」，但 lib/log-shipper/redaction.ts（11 條規則的遮罩模組）
 * 尚未存在——本函式目前直接轉送 worker 送來的內容，**沒有二次遮罩**。這不
 * 是被忽略，是明確不在本檔案所有權範圍內杜撰安全規則（Rule 1：拿不準就
 * 不要猜）。等 redaction.ts 就位，這裡要加一行 `line.content =
 * redact(line.content)`（含 head_4k/tail_4k，見 §7.2 的要求）。
 */
async function forwardToVictoriaLogs(host: string, lines: LogLineIn[]): Promise<boolean> {
  const vlUrl = (process.env.MON_VL_URL ?? '').trim().replace(/\/+$/, '')
  const vlUser = process.env.MON_VL_USER ?? ''
  const vlPassword = process.env.MON_VL_PASSWORD ?? ''
  if (vlUrl === '' || vlUser === '' || vlPassword === '') {
    console.error('log-intake: MON_VL_URL/MON_VL_USER/MON_VL_PASSWORD 未設定，無法轉寫 VictoriaLogs')
    return false
  }
  const ndjson = lines
    .map(line => {
      const msg = line.truncated
        ? JSON.stringify({ truncated: true, orig_bytes: line.origBytes ?? null, head_4k: line.head4k ?? '', tail_4k: line.tail4k ?? '' })
        : (line.content ?? '')
      // stream fields：host, source, ticket, run_id, kind（§7.4）。host 一律
      // 用驗證過的 worker 名稱（呼叫端已覆寫），不用 body 內任何自帶欄位。
      return JSON.stringify({
        _msg: msg,
        _time: line.ts ?? new Date().toISOString(),
        host,
        source: line.source ?? 'unknown',
        ticket: line.ticket ?? '',
        run_id: line.runId ?? '',
        kind: line.kind ?? '',
        path: line.path,
      })
    })
    .join('\n')
  try {
    const auth = Buffer.from(`${vlUser}:${vlPassword}`).toString('base64')
    const res = await fetch(`${vlUrl}/insert/jsonline?_stream_fields=host,source,ticket,run_id,kind`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/stream+json' },
      body: ndjson,
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok
  } catch (err) {
    console.error(`log-intake: 寫入 VictoriaLogs 失敗: ${err}`)
    return false
  }
}

app.post(
  '/cluster/logs',
  guard,
  bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: c => c.text('Payload Too Large', 413) }),
  async c => {
    const raw = await c.req.text().catch(() => null)
    if (raw === null) return c.json({ ok: false, reason: 'bad_request' }, 400)

    let body: { worker?: unknown; lines?: unknown } | null
    try {
      body = JSON.parse(raw) as { worker?: unknown; lines?: unknown }
    } catch {
      return c.json({ ok: false, reason: 'bad_request' }, 400)
    }

    if (!body || typeof body.worker !== 'string' || !WORKER_NAME_RE.test(body.worker)) {
      return c.json({ ok: false, reason: 'bad_request' }, 400)
    }
    const worker = body.worker

    // §3.3(e)：三件事任一不成立即 400 並丟棄整批——worker 通過 WORKER_NAME_RE
    // （已在上面驗過）、存在於名冊、不等於 head 自己的名字（worker 永遠不得
    // 寫 head 歸屬的逐字稿）。
    if (worker === MON_HOST || !loadWorkerNames().has(worker)) {
      return c.json({ ok: false, reason: 'unknown_worker' }, 400)
    }

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return c.json({ ok: false, reason: 'bad_request' }, 400)
    }

    // 速率限制（§3.3(c)）：全域 byte 額度 → 每 worker 請求數額度 → 每 worker
    // byte 額度，任一超過即 429 + Retry-After: 30。用整個請求的原始位元組數
    // 一次結算（含 JSON 框架），不逐行累計——跟 bodyLimit 的度量基準一致。
    const requestBytes = Buffer.byteLength(raw, 'utf8')
    if (!globalByteBucket.tryConsume(requestBytes)) {
      return c.text('Too Many Requests', 429, { 'Retry-After': RETRY_AFTER_SECONDS })
    }
    const { req: reqBucket, bytes: byteBucket } = getWorkerBuckets(worker)
    if (!reqBucket.tryConsume(1) || !byteBucket.tryConsume(requestBytes)) {
      return c.text('Too Many Requests', 429, { 'Retry-After': RETRY_AFTER_SECONDS })
    }

    const lines = body.lines.filter(isLogLineIn)
    if (lines.length === 0) return c.json({ ok: false, reason: 'bad_request' }, 400)
    for (const line of lines) enforceLineSizeLimit(line)

    // §3.3(d) 去重：全部重複時仍回 200/accepted:0（worker 才會推進 offset；
    // 對它而言這批已經送達過，不推進會造成無窮重送）。
    const deduped = lines.filter(line => !dedupSet.isDuplicate(computeLineId(worker, line.path, line.inode, line.offset)))
    if (deduped.length === 0) {
      return c.json({ ok: true, accepted: 0 })
    }

    // §3.3(d)：「回 2xx 的語意明訂為『已持久化到 VictoriaLogs』」——intake
    // 必須先寫成 9428 再回 200；9428 寫入失敗即回 503（worker 因此不推進
    // offset，下一輪從同一 offset 重送——兩條通道故障域不同，結構上只會
    // 產生重複，不會產生缺口）。
    const written = await forwardToVictoriaLogs(worker, deduped)
    if (!written) return c.text('Service Unavailable', 503)
    return c.json({ ok: true, accepted: deduped.length })
  },
)

// POST /cluster/logs 以外的一律 uniform 401（與其餘未知路徑無法區分，維持
// 既有拒絕不變式，比照 worker-agent.ts）。
app.all('*', c => respondUniform401(c))

export default {
  fetch: app.fetch,
  port: 9429,
  hostname: '127.0.0.1',
}
