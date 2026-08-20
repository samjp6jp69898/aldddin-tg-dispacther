import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { MAX_DISCARD_BODY_SIZE, consumePendingRequestBody, respondUniform401 } from './uniform-401.ts'

// 造一個 body 是串流的 Request，並回報「實際被拉走了幾個 chunk」——用來分辨
// 「真的把 body 讀掉了」與「只是沒有報錯」。
function makeStreamingRequest(chunkCount: number, chunkSize: number, headers: Record<string, string> = {}) {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close()
        return
      }
      pulled++
      controller.enqueue(new Uint8Array(chunkSize))
    },
  })
  const req = new Request('http://localhost/whatever', {
    method: 'POST',
    body,
    headers,
  })
  return { req, pulled: () => pulled }
}

describe('consumePendingRequestBody — 拒絕請求前把 body 讀掉丟棄', () => {
  test('把還在傳輸中的 body 完整讀完（F-1 的核心：入站串流不能停在讀到一半）', async () => {
    const { req, pulled } = makeStreamingRequest(5, 1024)

    await consumePendingRequestBody(req)

    expect(pulled()).toBe(5)
    expect(req.body!.locked).toBe(true)
  })

  test('沒有 body 的請求是 no-op（GET 不受影響）', async () => {
    const req = new Request('http://localhost/whatever')
    await consumePendingRequestBody(req)
    expect(req.bodyUsed).toBe(false)
  })

  test('body 已經被別人讀走（proxy 已 arrayBuffer 過）→ no-op，不拋例外', async () => {
    const req = new Request('http://localhost/whatever', { method: 'POST', body: 'already-read' })
    await req.arrayBuffer()

    await consumePendingRequestBody(req)

    expect(req.bodyUsed).toBe(true)
  })

  test('已宣告 Content-Length 超過上限 → 完全不去讀它（對齊 bodyLimit 的短路時機）', async () => {
    const { req } = makeStreamingRequest(5, 1024, { 'content-length': String(MAX_DISCARD_BODY_SIZE + 1) })

    await consumePendingRequestBody(req)

    // 判準是「有沒有動手去讀」：讀了才會拿 reader、拿了 reader 才會 lock。
    // 不數 chunk 數——ReadableStream 會自己非同步預取，那一個不是我們拉的。
    expect(req.body!.locked).toBe(false)
  })

  test('沒有 Content-Length 時邊讀邊計數，讀到上限就停（攻擊者無法讓這裡永遠讀下去）', async () => {
    // 每個 chunk 256KB、總共 100 個（25MB）；讀到 1MB 上限就該停手。
    const chunks = 100
    const { req, pulled } = makeStreamingRequest(chunks, 256 * 1024)

    await consumePendingRequestBody(req)

    // 只斷言「停在上限附近」而不是精確值：串流自己的預取會多算一個，那是
    // ReadableStream 的實作細節，不是這裡要鎖死的行為。關鍵是遠遠沒讀完 25MB。
    expect(pulled()).toBeLessThanOrEqual(MAX_DISCARD_BODY_SIZE / (256 * 1024) + 1)
    expect(pulled()).toBeLessThan(chunks)
  })

  test('串流中途炸掉不會往外拋（連線已斷沒有補救動作，也不能 log）', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    const req = new Request('http://localhost/whatever', {
      method: 'POST',
      body,
    })

    await expect(consumePendingRequestBody(req)).resolves.toBeUndefined()
  })
})

describe('respondUniform401 — 對外唯一的拒絕回應', () => {
  test('401 + 空 body，且不帶任何額外 header', async () => {
    const app = new Hono()
    app.all('*', c => respondUniform401(c))

    const res = await app.request('/anything', { method: 'POST', body: 'x' })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect([...res.headers.keys()].filter(name => name !== 'date' && name !== 'content-length')).toEqual([])
  })

  test('回應之前先把 request body 讀掉', async () => {
    const { req, pulled } = makeStreamingRequest(3, 512)
    const app = new Hono()
    app.all('*', c => respondUniform401(c))

    const res = await app.fetch(req)

    expect(res.status).toBe(401)
    expect(pulled()).toBe(3)
  })
})
