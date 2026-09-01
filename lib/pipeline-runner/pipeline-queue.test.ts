import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConcurrencyLimiter } from './concurrency-limiter.ts'
import { createPipelineQueue, type QueueEntry } from './pipeline-queue.ts'

// 測試用 harness：spawnNow 不起真實行程，只把 onExit 收進陣列，測試碼手動
// 呼叫模擬「某條背景流程結束」——事件驅動，不含任何等待時間（硬規則：測試
// 不得靠等待時間成立）。
//
// persist 預設關閉、recoverFromDisk 才啟用（見 pipeline-queue.ts 檔頭的
// 「結構保證補強」段）：需要驗 stateFile 的測試在建 harness 時帶
// enablePersist（= 先呼叫一次 recoverFromDisk，模擬 server.ts 啟動流程）。
function makeHarness(
  limit: number,
  opts: { failTickets?: Set<string>; skipTickets?: Map<string, string>; enablePersist?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-queue-test-'))
  const stateFile = join(dir, 'queue.json')
  const spawned: string[] = []
  const exits: { ticket: string; onExit: () => void }[] = []
  const dequeueStarted: string[] = []
  const dequeueFailed: string[] = []
  const skipped: { ticket: string; reason: string }[] = []
  const queue = createPipelineQueue<{ tag: string }>({
    limiter: createConcurrencyLimiter(limit),
    stateFile,
    ticketRe: /^FAQ-\d+$/,
    spawnNow: (entry: QueueEntry<{ tag: string }>, onExit) => {
      if (opts.failTickets?.has(entry.ticket)) return { ok: false }
      spawned.push(entry.ticket)
      exits.push({ ticket: entry.ticket, onExit })
      return { ok: true, pid: 12345 }
    },
    skipReason: entry => {
      const text = opts.skipTickets?.get(entry.ticket)
      return text ? { code: 'test', text } : null
    },
    onSkipped: (e, reason) => skipped.push({ ticket: e.ticket, reason: reason.text }),
    onDequeueStarted: e => dequeueStarted.push(e.ticket),
    onDequeueFailed: e => dequeueFailed.push(e.ticket),
  })
  if (opts.enablePersist) queue.recoverFromDisk()
  const finish = (ticket: string) => {
    const idx = exits.findIndex(e => e.ticket === ticket)
    expect(idx).toBeGreaterThan(-1)
    const [e] = exits.splice(idx, 1)
    e!.onExit()
  }
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8')) as { updatedAt: string; entries: QueueEntry<{ tag: string }>[] }
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { queue, stateFile, spawned, dequeueStarted, dequeueFailed, skipped, finish, readState, cleanup }
}

describe('createPipelineQueue — 額度內直接啟動、額滿 FIFO 排隊', () => {
  test('額度內 submit 直接 started；額滿後依序 queued，position/ahead 正確', () => {
    const h = makeHarness(2)
    expect(h.queue.submit('FAQ-1', null, { tag: 'a' })).toEqual({ ok: true, status: 'started', pid: 12345 })
    expect(h.queue.submit('FAQ-2', null, { tag: 'b' })).toEqual({ ok: true, status: 'started', pid: 12345 })
    expect(h.queue.submit('FAQ-3', null, { tag: 'c' })).toEqual({ ok: true, status: 'queued', position: 1, ahead: 0 })
    expect(h.queue.submit('FAQ-4', null, { tag: 'd' })).toEqual({ ok: true, status: 'queued', position: 2, ahead: 1 })
    expect(h.spawned).toEqual(['FAQ-1', 'FAQ-2'])
    expect(h.queue.size()).toBe(2)
    h.cleanup()
  })

  test('執行中的單重複 submit：回 already_running、不 spawn 第二條、不入列（連點視窗防護，2026-08-28 FAQ-4768 實測）', () => {
    const h = makeHarness(5)
    expect(h.queue.submit('FAQ-1', null, { tag: 'a' })).toEqual({ ok: true, status: 'started', pid: 12345 })
    // 額度明明還有（limit=5），但同一張單必須被 running 集合擋下
    expect(h.queue.submit('FAQ-1', null, { tag: 'dup' })).toEqual({ ok: true, status: 'already_running' })
    expect(h.spawned).toEqual(['FAQ-1'])
    expect(h.queue.size()).toBe(0)
    // 流程結束後（onExit）同一張單可以再次正常 submit
    h.finish('FAQ-1')
    expect(h.queue.submit('FAQ-1', null, { tag: 'again' })).toEqual({ ok: true, status: 'started', pid: 12345 })
    h.cleanup()
  })

  test('排隊中的單在出列時已在本 process 執行中：skip（code=locked）、不重複 spawn', () => {
    // 防禦性檢查：submit 已擋 already_running，正常流程不會讓同票同時「執行中
    // ＋排隊中」，這裡直接構造這個狀態驗證 drain 端的第二道防線。
    const h = makeHarness(2)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    h.queue.submit('FAQ-3', null, { tag: 'c' }) // 入列
    // 讓佇列裡出現與執行中同票的單：先讓 FAQ-3 也開始跑…做不到（會被擋），
    // 改驗證等價情境——佇列快照恢復時（recover）撿到與執行中同票的單。
    h.finish('FAQ-1') // FAQ-3 遞補開始跑
    writeFileSync(
      h.stateFile,
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: [{ ticket: 'FAQ-3', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: { tag: 'dup' } }] }),
    )
    const r = h.queue.recoverFromDisk()
    expect(r.skipped).toBe(1)
    expect(h.skipped[h.skipped.length - 1]!.reason).toContain('不重複觸發')
    expect(h.spawned).toEqual(['FAQ-1', 'FAQ-2', 'FAQ-3']) // FAQ-3 只 spawn 過一次
    h.cleanup()
  })

  test('同一張單重複 submit：回 already_queued 並帶目前順位，不重複排', () => {
    const h = makeHarness(1)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    h.queue.submit('FAQ-3', null, { tag: 'c' })
    expect(h.queue.submit('FAQ-3', null, { tag: 'c2' })).toEqual({ ok: true, status: 'already_queued', position: 2, ahead: 1 })
    expect(h.queue.size()).toBe(2)
    h.cleanup()
  })

  test('背景流程結束（onExit 事件）：自動遞補、先進先出，並觸發 onDequeueStarted', () => {
    const h = makeHarness(1)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    h.queue.submit('FAQ-3', null, { tag: 'c' })
    h.finish('FAQ-1')
    expect(h.spawned).toEqual(['FAQ-1', 'FAQ-2'])
    expect(h.dequeueStarted).toEqual(['FAQ-2'])
    h.finish('FAQ-2')
    expect(h.spawned).toEqual(['FAQ-1', 'FAQ-2', 'FAQ-3'])
    expect(h.dequeueStarted).toEqual(['FAQ-2', 'FAQ-3'])
    h.finish('FAQ-3')
    expect(h.queue.size()).toBe(0)
    h.cleanup()
  })

  test('submit 當下 spawn 失敗：回 spawn_error 且名額歸還（下一張 submit 仍拿得到名額）', () => {
    const h = makeHarness(1, { failTickets: new Set(['FAQ-9']) })
    expect(h.queue.submit('FAQ-9', null, { tag: 'x' })).toEqual({ ok: false, reason: 'spawn_error' })
    // 名額若沒歸還，這裡會變成 queued 而不是 started
    expect(h.queue.submit('FAQ-1', null, { tag: 'a' })).toEqual({ ok: true, status: 'started', pid: 12345 })
    h.cleanup()
  })

  test('遞補時 spawn 失敗：跳過該張（onDequeueFailed）、名額歸還、繼續遞補下一張，不卡死佇列', () => {
    const h = makeHarness(1, { failTickets: new Set(['FAQ-9']) })
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-9', null, { tag: 'x' })
    h.queue.submit('FAQ-3', null, { tag: 'c' })
    h.finish('FAQ-1')
    expect(h.dequeueFailed).toEqual(['FAQ-9'])
    expect(h.spawned).toEqual(['FAQ-1', 'FAQ-3'])
    expect(h.queue.size()).toBe(0)
    h.cleanup()
  })
})

describe('createPipelineQueue — 出列/恢復時的前提重驗（skipReason）', () => {
  test('遞補時 skipReason 非 null：移除該張（onSkipped）、不佔名額、繼續遞補下一張', () => {
    const h = makeHarness(1, { skipTickets: new Map([['FAQ-2', '鎖存在']]) })
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    h.queue.submit('FAQ-3', null, { tag: 'c' })
    h.finish('FAQ-1')
    // FAQ-2 被跳過且沒消耗名額：FAQ-3 直接接上
    expect(h.skipped).toEqual([{ ticket: 'FAQ-2', reason: '鎖存在' }])
    expect(h.spawned).toEqual(['FAQ-1', 'FAQ-3'])
    expect(h.dequeueFailed).toEqual([])
    expect(h.queue.size()).toBe(0)
    h.cleanup()
  })

  test('submit 當下不套用 skipReason（呼叫端在 submit 前一刻已自行檢查過同樣前提）', () => {
    const h = makeHarness(1, { skipTickets: new Map([['FAQ-1', '鎖存在']]) })
    expect(h.queue.submit('FAQ-1', null, { tag: 'a' })).toEqual({ ok: true, status: 'started', pid: 12345 })
    h.cleanup()
  })

  test('hook 丟例外（safeHook）：onSkipped/onDequeueStarted 炸掉不破壞遞補與名額——佇列繼續運作', () => {
    // onSkipped/onDequeueStarted 在真實環境會做 TG/Notion I/O（可能同步丟
    // 例外）；drain 跑在 child 'exit' handler 裡，例外外洩會炸掉常駐 server。
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-queue-test-'))
    const spawned: string[] = []
    const exits: (() => void)[] = []
    const queue = createPipelineQueue<Record<string, never>>({
      limiter: createConcurrencyLimiter(1),
      stateFile: join(dir, 'queue.json'),
      ticketRe: /^FAQ-\d+$/,
      spawnNow: (entry, onExit) => {
        spawned.push(entry.ticket)
        exits.push(onExit)
        return { ok: true, pid: 1 }
      },
      skipReason: e => (e.ticket === 'FAQ-2' ? { code: 'test', text: 'skip' } : null),
      onSkipped: () => {
        throw new Error('onSkipped 爆炸')
      },
      onDequeueStarted: () => {
        throw new Error('onDequeueStarted 爆炸')
      },
    })
    queue.submit('FAQ-1', null, {})
    queue.submit('FAQ-2', null, {})
    queue.submit('FAQ-3', null, {})
    // FAQ-1 結束：skip FAQ-2（onSkipped 丟例外被吞）→ 遞補 FAQ-3
    // （onDequeueStarted 丟例外也被吞）；整條鏈不得把例外丟出來
    expect(() => exits[0]!()).not.toThrow()
    expect(spawned).toEqual(['FAQ-1', 'FAQ-3'])
    expect(queue.size()).toBe(0)
    // 名額沒有被例外弄壞：FAQ-3 結束後新 submit 仍拿得到名額
    expect(() => exits[1]!()).not.toThrow()
    expect(queue.submit('FAQ-4', null, {})).toEqual({ ok: true, status: 'started', pid: 1 })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('createPipelineQueue — 持久化與重啟恢復', () => {
  test('persist 只在 recoverFromDisk 之後啟用：CLI 短命行程（沒 recover）絕不寫檔', () => {
    const h = makeHarness(0) // limit=0 → 任何 submit 都入列
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    expect(existsSync(h.stateFile)).toBe(false)
    h.cleanup()
  })

  test('排入/遞補都把佇列快照寫進 stateFile（含 ticket / enqueuedAt / triggeredBy / payload）', () => {
    const h = makeHarness(1, { enablePersist: true })
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', { name: '測試員', email: 'tester@example.com' }, { tag: 'b' })
    let state = h.readState()
    expect(state.entries.map(e => e.ticket)).toEqual(['FAQ-2'])
    expect(state.entries[0]!.triggeredBy).toEqual({ name: '測試員', email: 'tester@example.com' })
    expect(state.entries[0]!.payload).toEqual({ tag: 'b' })
    expect(state.entries[0]!.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    h.finish('FAQ-1')
    state = h.readState()
    expect(state.entries).toEqual([])
    h.cleanup()
  })

  test('recoverFromDisk：撿回檔案裡的單——有名額的直接啟動、其餘依原順序續排，並重寫 stateFile', () => {
    const h = makeHarness(1)
    writeFileSync(
      h.stateFile,
      JSON.stringify({
        updatedAt: '2026-08-28T00:00:00.000Z',
        entries: [
          { ticket: 'FAQ-10', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: { tag: 'a' } },
          { ticket: 'FAQ-11', enqueuedAt: new Date().toISOString(), triggeredBy: { name: 'x', email: 'x@example.com' }, payload: { tag: 'b' } },
        ],
      }),
    )
    const r = h.queue.recoverFromDisk()
    expect(r).toEqual({ started: 1, requeued: 1, skipped: 0 })
    expect(h.spawned).toEqual(['FAQ-10'])
    const state = h.readState()
    expect(state.entries.map(e => e.ticket)).toEqual(['FAQ-11'])
    h.cleanup()
  })

  test('recoverFromDisk：ticket 格式不合法的條目（檔案被竄改/半寫壞）直接丟棄，不 spawn 也不續排', () => {
    const h = makeHarness(5)
    writeFileSync(
      h.stateFile,
      JSON.stringify({
        updatedAt: '2026-08-28T00:00:00.000Z',
        entries: [
          { ticket: 'FAQ-10; rm -rf /', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: { tag: 'x' } },
          { ticket: 'NOT-A-TICKET', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: { tag: 'y' } },
          { ticket: 'FAQ-11', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: { tag: 'b' } },
        ],
      }),
    )
    const r = h.queue.recoverFromDisk()
    expect(r).toEqual({ started: 1, requeued: 0, skipped: 0 })
    expect(h.spawned).toEqual(['FAQ-11'])
    h.cleanup()
  })

  test('recoverFromDisk：skipReason 非 null 的單不 spawn、不續排，計入 skipped 並觸發 onSkipped', () => {
    const h = makeHarness(5, { skipTickets: new Map([['FAQ-10', '排隊已超過 24 小時']]) })
    writeFileSync(
      h.stateFile,
      JSON.stringify({
        updatedAt: '2026-08-28T00:00:00.000Z',
        entries: [
          { ticket: 'FAQ-10', enqueuedAt: '2026-08-01T00:00:00.000Z', triggeredBy: null, payload: { tag: 'a' } },
          { ticket: 'FAQ-11', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: { tag: 'b' } },
        ],
      }),
    )
    const r = h.queue.recoverFromDisk()
    expect(r).toEqual({ started: 1, requeued: 0, skipped: 1 })
    expect(h.skipped).toEqual([{ ticket: 'FAQ-10', reason: '排隊已超過 24 小時' }])
    expect(h.spawned).toEqual(['FAQ-11'])
    h.cleanup()
  })

  test('recoverFromDisk：檔案不存在或內容壞掉都當空佇列，不丟例外', () => {
    const h = makeHarness(1)
    expect(h.queue.recoverFromDisk()).toEqual({ started: 0, requeued: 0, skipped: 0 })
    writeFileSync(h.stateFile, 'not-json{{{')
    expect(h.queue.recoverFromDisk()).toEqual({ started: 0, requeued: 0, skipped: 0 })
    // 恢復後 stateFile 被重寫成合法的空佇列快照
    expect(existsSync(h.stateFile)).toBe(true)
    expect(h.readState().entries).toEqual([])
    h.cleanup()
  })
})

describe('makeQueueSkipReason（spawn-create-mr.ts）— 鎖重驗與 24 小時時效', () => {
  test('鎖目錄存在 → 鎖存在理由；未鎖且未逾時 → null；排隊超過 24 小時 → 逾時理由；enqueuedAt 壞值不誤判', async () => {
    const { makeQueueSkipReason, MAX_QUEUE_WAIT_MS } = await import('./spawn-create-mr.ts')
    const { mkdirSync } = await import('node:fs')
    const lockDir = mkdtempSync(join(tmpdir(), 'queue-skip-lock-'))
    const skip = makeQueueSkipReason<Record<string, never>>({ lockDir })
    const fresh = { ticket: 'FAQ-1', enqueuedAt: new Date().toISOString(), triggeredBy: null, payload: {} }
    expect(skip(fresh)).toBeNull()
    // 鎖目錄存在（＝別的流程正在跑這張單）→ 跳過，code=locked（onSkipped 據此
    // 決定「不動工單狀態」的收尾分支）
    mkdirSync(join(lockDir, 'FAQ-1'))
    expect(skip(fresh)?.code).toBe('locked')
    expect(skip(fresh)?.text).toContain('鎖存在')
    // 未鎖但排隊逾時 → 跳過，code=expired（需求側據此把 AI分析 改回可認領值）
    const stale = { ticket: 'FAQ-2', enqueuedAt: new Date(Date.now() - MAX_QUEUE_WAIT_MS - 1000).toISOString(), triggeredBy: null, payload: {} }
    expect(skip(stale)?.code).toBe('expired')
    expect(skip(stale)?.text).toContain('24 小時')
    // enqueuedAt 壞值：不誤判逾時
    expect(skip({ ticket: 'FAQ-3', enqueuedAt: 'not-a-date', triggeredBy: null, payload: {} })).toBeNull()
    rmSync(lockDir, { recursive: true, force: true })
  })
})

describe('createPipelineQueue — 多機派工新增介面（has / runningCount / onExited）', () => {
  // 這組介面給 lib/cluster/ 用（派工前的重複防護、/capacity 回報、worker
  // 完成回報），見 pipeline-queue.ts 對應註解。harness 未接 onExited，這裡
  // 直接建自己的 queue。
  function makeClusterHarness(limit: number) {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-queue-cluster-test-'))
    const exits: { ticket: string; onExit: () => void }[] = []
    const exited: string[] = []
    const queue = createPipelineQueue<{ tag: string }>({
      limiter: createConcurrencyLimiter(limit),
      stateFile: join(dir, 'queue.json'),
      ticketRe: /^FAQ-\d+$/,
      spawnNow: (entry, onExit) => {
        exits.push({ ticket: entry.ticket, onExit })
        return { ok: true, pid: 1 }
      },
      onExited: ticket => exited.push(ticket),
    })
    const finish = (ticket: string) => {
      const idx = exits.findIndex(e => e.ticket === ticket)
      expect(idx).toBeGreaterThan(-1)
      exits.splice(idx, 1)[0]!.onExit()
    }
    return { queue, exited, finish, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('has：執行中回 running、排隊中回 queued、無此單回 null；runningCount 跟著增減', () => {
    const h = makeClusterHarness(1)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    expect(h.queue.has('FAQ-1')).toBe('running')
    expect(h.queue.has('FAQ-2')).toBe('queued')
    expect(h.queue.has('FAQ-999')).toBe(null)
    expect(h.queue.runningCount()).toBe(1)
    h.finish('FAQ-1') // FAQ-2 遞補
    expect(h.queue.has('FAQ-1')).toBe(null)
    expect(h.queue.has('FAQ-2')).toBe('running')
    expect(h.queue.runningCount()).toBe(1)
    h.finish('FAQ-2')
    expect(h.queue.runningCount()).toBe(0)
    h.cleanup()
  })

  test('onExited：每條流程結束都恰好通知一次，且在遞補（drain）之後才觸發', () => {
    const h = makeClusterHarness(1)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    expect(h.exited).toEqual([])
    h.finish('FAQ-1')
    // onExited 觸發當下 FAQ-2 已遞補為 running（drain 先於 onExited）
    expect(h.exited).toEqual(['FAQ-1'])
    expect(h.queue.has('FAQ-2')).toBe('running')
    h.finish('FAQ-2')
    expect(h.exited).toEqual(['FAQ-1', 'FAQ-2'])
    h.cleanup()
  })

  test('onExited hook 丟例外不破壞佇列運作（safeHook 防線）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-queue-cluster-test-'))
    const exits: (() => void)[] = []
    const queue = createPipelineQueue<null>({
      limiter: createConcurrencyLimiter(1),
      stateFile: join(dir, 'queue.json'),
      ticketRe: /^FAQ-\d+$/,
      spawnNow: (_entry, onExit) => {
        exits.push(onExit)
        return { ok: true, pid: 1 }
      },
      onExited: () => {
        throw new Error('boom')
      },
    })
    queue.submit('FAQ-1', null, null)
    queue.submit('FAQ-2', null, null)
    expect(() => exits.shift()!()).not.toThrow()
    expect(queue.has('FAQ-2')).toBe('running') // 遞補不受 hook 例外影響
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('createPipelineQueue — tryDispatchFront（cluster-wide 遞補，給 lib/cluster/backlog-dispatcher.ts 用）', () => {
  test('佇列空：回 empty，attempt 不被呼叫', async () => {
    const h = makeHarness(0) // limit=0，submit 一律入列
    const called: string[] = []
    const outcome = await h.queue.tryDispatchFront(async entry => {
      called.push(entry.ticket)
      return true
    })
    expect(outcome).toBe('empty')
    expect(called).toEqual([])
    h.cleanup()
  })

  test('隊頭在 attempt 呼叫前已同步從佇列移除（防止與本機 drain 搶同一張單）；attempt 回 true 視為已消化', async () => {
    const h = makeHarness(0)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    expect(h.queue.size()).toBe(2)
    let sawDuringAttempt: 'running' | 'queued' | null = 'queued'
    const outcome = await h.queue.tryDispatchFront(async entry => {
      expect(entry.ticket).toBe('FAQ-1')
      // 進到 attempt 當下，這張單必須已經不在佇列裡（has 回 null）——
      // 這就是「同步取出」防重複派工的可觀察前提。
      sawDuringAttempt = h.queue.has(entry.ticket)
      return true
    })
    expect(outcome).toBe('dispatched')
    expect(sawDuringAttempt).toBe(null)
    expect(h.queue.size()).toBe(1) // 只剩 FAQ-2
    h.cleanup()
  })

  test('attempt 回 false：單塞回隊頭，保留 FIFO 位置，不繼續嘗試下一張', async () => {
    const h = makeHarness(0)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    const attempted: string[] = []
    const outcome = await h.queue.tryDispatchFront(async entry => {
      attempted.push(entry.ticket)
      return false
    })
    expect(outcome).toBe('declined')
    expect(attempted).toEqual(['FAQ-1']) // FAQ-2 完全沒被嘗試
    expect(h.queue.size()).toBe(2)
    // 再呼叫一次：隊頭仍是 FAQ-1（順序沒被打亂）
    const outcome2 = await h.queue.tryDispatchFront(async entry => {
      attempted.push(entry.ticket)
      return true
    })
    expect(outcome2).toBe('dispatched')
    expect(attempted).toEqual(['FAQ-1', 'FAQ-1'])
    expect(h.queue.size()).toBe(1)
    h.cleanup()
  })

  test('隊頭 skipReason 非 null：移除、觸發 onSkipped，繼續往後找到第一張可嘗試的單', async () => {
    const h = makeHarness(0, { skipTickets: new Map([['FAQ-1', '排隊已超過 24 小時']]) })
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    const attempted: string[] = []
    const outcome = await h.queue.tryDispatchFront(async entry => {
      attempted.push(entry.ticket)
      return true
    })
    expect(outcome).toBe('dispatched')
    expect(attempted).toEqual(['FAQ-2'])
    expect(h.skipped).toEqual([{ ticket: 'FAQ-1', reason: '排隊已超過 24 小時' }])
    expect(h.queue.size()).toBe(0)
    h.cleanup()
  })

  test('attempt 丟例外：視為拒絕，單塞回隊頭，不吞掉、不讓單消失', async () => {
    const h = makeHarness(0)
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    h.queue.submit('FAQ-2', null, { tag: 'b' })
    const outcome = await h.queue.tryDispatchFront(async () => {
      throw new Error('postJob 炸了')
    })
    expect(outcome).toBe('declined')
    expect(h.queue.size()).toBe(2) // FAQ-1 沒有消失
    expect(h.queue.has('FAQ-1')).toBe('queued')
    h.cleanup()
  })

  test('塞回隊頭的單會落盤（persist 開啟時）：重啟恢復不會遺漏', () => {
    const h = makeHarness(0, { enablePersist: true })
    h.queue.submit('FAQ-1', null, { tag: 'a' })
    return h.queue.tryDispatchFront(async () => false).then(outcome => {
      expect(outcome).toBe('declined')
      const state = h.readState()
      expect(state.entries.map(e => e.ticket)).toEqual(['FAQ-1'])
      h.cleanup()
    })
  })
})
