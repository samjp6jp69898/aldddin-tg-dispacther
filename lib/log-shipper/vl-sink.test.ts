import { describe, expect, test } from 'bun:test'
import { createVLDirectSink, type FetchFn } from './vl-sink.ts'
import type { ShipLine } from './types.ts'

function line(overrides: Partial<ShipLine> = {}): ShipLine {
  return {
    path: '/logs/a.log',
    inode: 1,
    offset: 0,
    ts: '2026-09-02T00:00:00.000Z',
    host: 'head',
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

describe('createVLDirectSink', () => {
  test('2xx 回 true，Basic Auth header 與 URL 正確組成', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createVLDirectSink({ vlUrl: 'http://127.0.0.1:9428', vlUser: 'u', vlPassword: 'p', fetchImpl: fakeFetch(200, capture) })
    const ok = await sink.send([line()])
    expect(ok).toBe(true)
    expect(capture.calls).toHaveLength(1)
    const { url, init } = capture.calls[0]!
    expect(url).toBe('http://127.0.0.1:9428/insert/jsonline?_stream_fields=host,source,ticket,run_id,kind')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  test('body 是 ndjson，每行含 _time/_msg 與 stream fields', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createVLDirectSink({ vlUrl: 'http://127.0.0.1:9428', vlUser: 'u', vlPassword: 'p', fetchImpl: fakeFetch(200, capture) })
    await sink.send([line({ content: 'first' }), line({ content: 'second', offset: 10 })])
    const body = capture.calls[0]!.init.body as string
    const rows = body.split('\n').map(l => JSON.parse(l))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ _msg: 'first', _time: '2026-09-02T00:00:00.000Z', host: 'head', source: '/logs/a.log', ticket: 'FAQ-1', run_id: 'run-1', kind: 'bug' })
    expect(rows[1]).toMatchObject({ _msg: 'second' })
  })

  test('truncated 行送出 {truncated,orig_bytes,head_4k,tail_4k,...} 摘要物件，不含原文', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createVLDirectSink({ vlUrl: 'http://127.0.0.1:9428', vlUser: 'u', vlPassword: 'p', fetchImpl: fakeFetch(200, capture) })
    await sink.send([line({ content: undefined, truncated: true, origBytes: 3_000_000, head4k: 'HEAD', tail4k: 'TAIL' })])
    const body = capture.calls[0]!.init.body as string
    const row = JSON.parse(body)
    const msg = JSON.parse(row._msg)
    expect(msg).toEqual({ truncated: true, orig_bytes: 3_000_000, head_4k: 'HEAD', tail_4k: 'TAIL', file: '/logs/a.log', offset: 0, host: 'head' })
  })

  test('非 2xx 回 false', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createVLDirectSink({ vlUrl: 'http://127.0.0.1:9428', vlUser: 'u', vlPassword: 'p', fetchImpl: fakeFetch(503, capture) })
    expect(await sink.send([line()])).toBe(false)
  })

  test('fetch 拋例外回 false（不重試、不 throw）', async () => {
    const throwing: FetchFn = (async () => {
      throw new Error('network down')
    }) as FetchFn
    const sink = createVLDirectSink({ vlUrl: 'http://127.0.0.1:9428', vlUser: 'u', vlPassword: 'p', fetchImpl: throwing })
    expect(await sink.send([line()])).toBe(false)
  })

  test('空 batch 直接回 true，不打 HTTP', async () => {
    const capture = { calls: [] as Array<{ url: string; init: RequestInit }> }
    const sink = createVLDirectSink({ vlUrl: 'http://127.0.0.1:9428', vlUser: 'u', vlPassword: 'p', fetchImpl: fakeFetch(200, capture) })
    expect(await sink.send([])).toBe(true)
    expect(capture.calls).toHaveLength(0)
  })
})
