import { describe, expect, test } from 'bun:test'
import { createClusterSink, toWireLine, type FetchFn } from './cluster-sink.ts'
import type { ShipLine } from './types.ts'

// intake-server.ts 在模組載入時就會呼叫 getClusterSecret()，未設定會直接 throw
// （比照該檔自己的 intake-server.test.ts 開頭紀律）：先給假值再動態 import，
// 只用它匯出的 computeLineId 純函式做 line_id 穩定性交叉驗證——不碰、不改
// intake-server.ts 本身（唯讀）。
process.env.CLUSTER_SHARED_SECRET = process.env.CLUSTER_SHARED_SECRET ?? 'x'.repeat(32)
const { computeLineId } = await import('./intake-server.ts')

function line(overrides: Partial<ShipLine> = {}): ShipLine {
  return {
    path: '/logs/a.log',
    inode: 42,
    offset: 100,
    ts: '2026-09-02T00:00:00.000Z',
    host: 'worker-1',
    source: '/logs/a.log',
    ticket: 'FAQ-1',
    kind: 'bug',
    runId: 'run-1',
    content: 'hello world',
    ...overrides,
  }
}

function fakeFetch(status: number, capture: { calls: Array<{ url: string; init: RequestInit }> }): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.calls.push({ url: String(input), init: init! })
    return new Response('ok', { status })
  }) as FetchFn
}

describe('toWireLine', () => {
  test('保留 path/inode/offset 逐字不變（intake 用這三者算 line_id 去重）', () => {
    const l = line()
    const wire = toWireLine(l)
    expect(wire.path).toBe(l.path)
    expect(wire.inode).toBe(l.inode)
    expect(wire.offset).toBe(l.offset)
  })

  test('truncated 行不帶 content，帶 origBytes/head4k/tail4k', () => {
    const wire = toWireLine(line({ content: undefined, truncated: true, origBytes: 3_000_000, head4k: 'H', tail4k: 'T' }))
    expect(wire.content).toBeUndefined()
    expect(wire.truncated).toBe(true)
    expect(wire.origBytes).toBe(3_000_000)
    expect(wire.head4k).toBe('H')
    expect(wire.tail4k).toBe('T')
  })
})

describe('createClusterSink', () => {
  test('2xx 回 true；body 為 {worker, lines}，header 帶 x-cluster-token', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createClusterSink({ worker: 'worker-1', clusterSecret: 'sekret', fetchImpl: fakeFetch(200, capture) })
    const ok = await sink.send([line()])
    expect(ok).toBe(true)
    const { url, init } = capture.calls[0]!
    expect(url).toBe('http://127.0.0.1:9429/cluster/logs')
    const headers = init.headers as Record<string, string>
    expect(headers['x-cluster-token']).toBe('sekret')
    const body = JSON.parse(init.body as string)
    expect(body.worker).toBe('worker-1')
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0].path).toBe('/logs/a.log')
    expect(body.lines[0].inode).toBe(42)
    expect(body.lines[0].offset).toBe(100)
  })

  test('非 2xx（含 429）回 false，不重試', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createClusterSink({ worker: 'worker-1', clusterSecret: 'sekret', fetchImpl: fakeFetch(429, capture) })
    expect(await sink.send([line()])).toBe(false)
    expect(capture.calls).toHaveLength(1) // 只打一次，沒有自旋重試
  })

  test('fetch 例外回 false', async () => {
    const throwing: FetchFn = (async () => {
      throw new Error('boom')
    }) as FetchFn
    const sink = createClusterSink({ worker: 'worker-1', clusterSecret: 'sekret', fetchImpl: throwing })
    expect(await sink.send([line()])).toBe(false)
  })

  test('line_id 穩定性：相同 (worker, path, inode, offset) 重送兩次，intake 端算出的 line_id 完全一致', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createClusterSink({ worker: 'worker-1', clusterSecret: 'sekret', fetchImpl: fakeFetch(200, capture) })
    const l = line()

    await sink.send([l])
    await sink.send([l]) // 模擬同一行重送（例如上一批 429 之後下一輪重送）

    const bodies = capture.calls.map(c => JSON.parse(c.init.body as string))
    const ids = bodies.map(b => computeLineId(b.worker, b.lines[0].path, b.lines[0].inode, b.lines[0].offset))
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toBe(computeLineId('worker-1', '/logs/a.log', 42, 100))
  })

  test('不同 offset 產生不同 line_id（去重不會誤判不同行為重複）', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createClusterSink({ worker: 'worker-1', clusterSecret: 'sekret', fetchImpl: fakeFetch(200, capture) })
    await sink.send([line({ offset: 100 })])
    await sink.send([line({ offset: 200 })])
    const bodies = capture.calls.map(c => JSON.parse(c.init.body as string))
    const ids = bodies.map(b => computeLineId(b.worker, b.lines[0].path, b.lines[0].inode, b.lines[0].offset))
    expect(ids[0]).not.toBe(ids[1])
  })

  test('空 batch 直接回 true，不打 HTTP', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createClusterSink({ worker: 'worker-1', clusterSecret: 'sekret', fetchImpl: fakeFetch(200, capture) })
    expect(await sink.send([])).toBe(true)
    expect(capture.calls).toHaveLength(0)
  })
})
