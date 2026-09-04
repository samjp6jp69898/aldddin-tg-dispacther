import { describe, expect, test } from 'bun:test'
// type-only import：純型別，編譯期擦除，不觸發模組真正的執行期載入
// （下面的 env 賦值必須先跑完，才能安全地動態 import 真正的模組）。
import type { LogLineIn } from './intake-server.ts'

// intake-server.ts 在模組載入時就會呼叫 getClusterSecret()，未設定會直接
// throw（比照 worker-agent.ts 的既有紀律：這是一個「拒絕在沒有 secret 時
// 啟動」的常駐 entrypoint，不是純邏輯模組）。這裡只測試檔案內可獨立驗證的
// 純函式（token bucket 演算法、LRU 去重、line_id 計算、行大小防護），不测
// 完整 HTTP 路由——那需要真實名冊檔（WORKERS_FILE 是寫死的正式路徑）與
// VictoriaLogs，屬於 Phase 3 的 curl 級驗收範圍，不在單元測試職責內。
// 用「已設定就沿用、未設定才給假值」而不是直接覆寫，避免在已經配好正式
// secret 的開發機上把它換掉。
process.env.CLUSTER_SHARED_SECRET = process.env.CLUSTER_SHARED_SECRET ?? 'x'.repeat(32)

// 動態 import：必須等上面那行先跑完，靜態 import 會被提升到檔案最前面，
// 那時 env 還沒设好，模組頂層的 throw 會先炸掉。
const { createAmountBucket, createLruDedupSet, computeLineId, isLogLineIn, enforceLineSizeLimit, acceptLogBatch } = await import('./intake-server.ts')

describe('createAmountBucket — token bucket（可變消耗量）', () => {
  test('容量內可消耗，超出容量的單次消耗直接失敗且不扣款', () => {
    let now = 0
    const bucket = createAmountBucket(100, 10, () => now)
    expect(bucket.tryConsume(60)).toBe(true)
    expect(bucket.tryConsume(50)).toBe(false) // 剩 40，不夠
    expect(bucket.tryConsume(40)).toBe(true) // 剩 40 剛好
  })

  test('依時間流逝補回額度，不超過容量上限', () => {
    let now = 0
    const bucket = createAmountBucket(100, 10, () => now) // 每秒補 10
    expect(bucket.tryConsume(100)).toBe(true) // 榨乾
    expect(bucket.tryConsume(1)).toBe(false)
    now += 5_000 // 過 5 秒，補回 50（未達上限）
    expect(bucket.tryConsume(50)).toBe(true)
    expect(bucket.tryConsume(1)).toBe(false)
    now += 100_000 // 過久，補回上限封頂在 100，不會無限累積
    expect(bucket.tryConsume(100)).toBe(true)
    expect(bucket.tryConsume(1)).toBe(false)
  })
})

describe('createLruDedupSet — 去重（§3.3(d)）', () => {
  test('同一個 id 第二次判定為重複；不同 id 各自算新的', () => {
    const set = createLruDedupSet(10)
    expect(set.isDuplicate('a')).toBe(false)
    expect(set.isDuplicate('a')).toBe(true)
    expect(set.isDuplicate('b')).toBe(false)
    expect(set.size()).toBe(2)
  })

  test('滿載時淘汰最舊的（LRU），被淘汰的 id 之後又算新的', () => {
    const set = createLruDedupSet(3)
    set.isDuplicate('a')
    set.isDuplicate('b')
    set.isDuplicate('c')
    expect(set.size()).toBe(3)
    set.isDuplicate('d') // 容量 3，插入第 4 筆會淘汰最舊的 'a'
    expect(set.size()).toBe(3)
    expect(set.isDuplicate('a')).toBe(false) // 'a' 已被淘汰，重新算新的
    expect(set.isDuplicate('d')).toBe(true) // 'd' 還在
  })

  test('touch 命中的 id 會排到最新，不會被優先淘汰', () => {
    const set = createLruDedupSet(2)
    set.isDuplicate('a')
    set.isDuplicate('b')
    set.isDuplicate('a') // touch 'a'，讓它比 'b' 新
    set.isDuplicate('c') // 容量 2，該淘汰最舊的 'b'，不是 'a'
    expect(set.isDuplicate('b')).toBe(false) // 'b' 被淘汰，重新算新的
  })
})

describe('computeLineId', () => {
  test('相同輸入產生相同 id；host/path/inode/offset 任一不同就不同', () => {
    const base = computeLineId('w1', '/logs/a.log', 123, 456)
    expect(base).toBe(computeLineId('w1', '/logs/a.log', 123, 456))
    expect(base).not.toBe(computeLineId('w2', '/logs/a.log', 123, 456))
    expect(base).not.toBe(computeLineId('w1', '/logs/b.log', 123, 456))
    expect(base).not.toBe(computeLineId('w1', '/logs/a.log', 999, 456))
    expect(base).not.toBe(computeLineId('w1', '/logs/a.log', 123, 999))
  })

  test('固定為 16 個十六進位字元（SHA-256 前 16 hex）', () => {
    expect(computeLineId('w1', '/logs/a.log', 1, 2)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('isLogLineIn', () => {
  test('合法形狀通過；缺欄位/型別不對/path 過長都不通過', () => {
    expect(isLogLineIn({ path: '/a.log', inode: 1, offset: 0 })).toBe(true)
    expect(isLogLineIn({ path: '/a.log', inode: 1 })).toBe(false) // 缺 offset
    expect(isLogLineIn({ path: '/a.log', inode: '1', offset: 0 })).toBe(false) // inode 型別錯
    expect(isLogLineIn({ path: '', inode: 1, offset: 0 })).toBe(false) // 空字串
    expect(isLogLineIn({ path: 'x'.repeat(600), inode: 1, offset: 0 })).toBe(false) // 過長
    expect(isLogLineIn(null)).toBe(false)
    expect(isLogLineIn('not an object')).toBe(false)
  })
})

describe('enforceLineSizeLimit（§7.2 超大行防護）', () => {
  test('≤2MB 的內容原封不動', () => {
    const line: LogLineIn = { path: '/a.log', inode: 1, offset: 0, content: 'hello' }
    enforceLineSizeLimit(line)
    expect(line.content).toBe('hello')
    expect(line.truncated).toBeUndefined()
  })

  test('>2MB 的內容改成 truncated 摘要，含 head_4k/tail_4k', () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 10)
    const line: LogLineIn = { path: '/a.log', inode: 1, offset: 0, content: big }
    enforceLineSizeLimit(line)
    expect(line.truncated).toBe(true)
    expect(line.origBytes).toBe(big.length)
    expect(line.head4k).toBe(big.slice(0, 4096))
    expect(line.tail4k).toBe(big.slice(-4096))
    expect(line.content).toBeUndefined()
  })

  test('已經是 truncated 的行不重複處理', () => {
    const line: LogLineIn = { path: '/a.log', inode: 1, offset: 0, truncated: true, origBytes: 999, head4k: 'h', tail4k: 't' }
    enforceLineSizeLimit(line)
    expect(line.origBytes).toBe(999) // 沒被重算
  })
})

// ---------- acceptLogBatch — B-2：登記必須後置於 VL 持久化 ----------
//
// review-final-A-dispatcher.md B-2：舊版在 dedup filter 時就登記 id，一次 VL
// 暫時失敗（503）→ worker 原封重送 → 全判重複 → 200/accepted:0 → worker
// 推進 offset → 該批永久遺失（缺口，違反 §3.3(d) 的核心不變式）。以下用
// 注入的假 forward 釘住「503 後重送必須被完整接受」。

describe('acceptLogBatch — B-2：VL 失敗後重送不得被誤判為重複', () => {
  const batch: LogLineIn[] = [
    { path: '/logs/a.log', inode: 7, offset: 0, content: 'x' },
    { path: '/logs/a.log', inode: 7, offset: 10, content: 'y' },
  ]

  test('第一次 VL 失敗（503、不登記）→ 原封重送被完整接受 → 第三次才是真重複', async () => {
    const dedup = createLruDedupSet(10)
    let calls = 0
    const forward = async () => {
      calls++
      return calls > 1 // 第一次 false（VL 5xx/逾時），之後 true
    }

    const r1 = await acceptLogBatch('w1', batch, { dedup, forward })
    expect(r1).toEqual({ status: 503, accepted: 0 })
    expect(dedup.size()).toBe(0) // 失敗不登記——這正是 B-2 的修復本體

    const r2 = await acceptLogBatch('w1', batch, { dedup, forward })
    expect(r2).toEqual({ status: 200, accepted: batch.length }) // 重送全數接受
    expect(dedup.size()).toBe(batch.length)

    const r3 = await acceptLogBatch('w1', batch, { dedup, forward })
    expect(r3).toEqual({ status: 200, accepted: 0 }) // 已持久化過才算重複
    expect(calls).toBe(2) // 第三次全重複，不會再打 VL
  })

  test('批內重複沿用舊行為：同批相同 id 只轉寫第一份', async () => {
    const dedup = createLruDedupSet(10)
    const forwarded: LogLineIn[][] = []
    const forward = async (_h: string, lines: LogLineIn[]) => {
      forwarded.push(lines)
      return true
    }
    const dup: LogLineIn[] = [batch[0]!, batch[0]!, batch[1]!]
    const r = await acceptLogBatch('w1', dup, { dedup, forward })
    expect(r).toEqual({ status: 200, accepted: 2 })
    expect(forwarded[0]!.length).toBe(2)
  })

  test('全部重複 → 200/accepted:0 且完全不打 VL（worker 需要 2xx 才會推進 offset，避免無窮重送）', async () => {
    const dedup = createLruDedupSet(10)
    let calls = 0
    const forward = async () => {
      calls++
      return true
    }
    await acceptLogBatch('w1', batch, { dedup, forward })
    const r = await acceptLogBatch('w1', batch, { dedup, forward })
    expect(r).toEqual({ status: 200, accepted: 0 })
    expect(calls).toBe(1)
  })

  test('has() 不登記（查詢與登記分離的介面契約）；add() 才登記', () => {
    const dedup = createLruDedupSet(10)
    expect(dedup.has('a')).toBe(false)
    expect(dedup.has('a')).toBe(false) // 查兩次都不登記
    expect(dedup.size()).toBe(0)
    dedup.add('a')
    expect(dedup.has('a')).toBe(true)
    expect(dedup.size()).toBe(1)
  })
})
