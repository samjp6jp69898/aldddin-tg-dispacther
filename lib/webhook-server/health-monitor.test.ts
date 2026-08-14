import { afterAll, describe, expect, mock, test } from 'bun:test'
import { checkNgrokTunnelReachable, createHealthMonitor } from './health-monitor.ts'

// 用一個真的最小 Bun.serve 假裝 ngrok 的 admin API（不接觸真實 ngrok，也不
// mock fetch——這裡就是要驗證真的打了一次 HTTP request 並正確解析回應）。
let tunnelCount = 1
const fakeNgrokServer = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/tunnels') {
      return Response.json({ tunnels: Array.from({ length: tunnelCount }, (_, i) => ({ name: `t${i}` })) })
    }
    if (url.pathname === '/api/tunnels-empty') {
      return Response.json({ tunnels: [] })
    }
    if (url.pathname === '/api/tunnels-500') {
      return new Response('error', { status: 500 })
    }
    return new Response('not found', { status: 404 })
  },
})
const BASE = `http://127.0.0.1:${fakeNgrokServer.port}`

afterAll(() => {
  fakeNgrokServer.stop(true)
})

describe('checkNgrokTunnelReachable', () => {
  test('有 active tunnel → true', async () => {
    expect(await checkNgrokTunnelReachable(`${BASE}/api/tunnels`)).toBe(true)
  })

  test('tunnels 陣列是空的 → false', async () => {
    expect(await checkNgrokTunnelReachable(`${BASE}/api/tunnels-empty`)).toBe(false)
  })

  test('API 回 500 → false（不拋例外）', async () => {
    expect(await checkNgrokTunnelReachable(`${BASE}/api/tunnels-500`)).toBe(false)
  })

  test('連不上（port 沒人聽）→ false（不拋例外）', async () => {
    expect(await checkNgrokTunnelReachable('http://127.0.0.1:1')).toBe(false)
  })
})

describe('createHealthMonitor — 狀態翻轉才通知，避免洗版', () => {
  test('第一次檢查只記基準值，不通知（避免剛啟動 tunnel 還沒起來就誤報）', async () => {
    const notify = mock((_text: string) => {})
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/api/tunnels-empty`, notify })

    const result = await monitor.runOnce()

    expect(result).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  test('健康 → 不健康：翻轉時通知一次；持續不健康：不重複通知', async () => {
    const notify = mock((_text: string) => {})
    // 先給一個會動態切換的假 server 端點，模擬「原本健康，後來變不健康」。
    tunnelCount = 1
    const monitor = createHealthMonitor({ apiUrl: `${BASE}/api/tunnels`, notify })

    await monitor.runOnce() // 基準：健康，不通知
    expect(notify).not.toHaveBeenCalled()

    tunnelCount = 0 // 模擬 tunnel 掉了
    await monitor.runOnce() // 翻轉：健康→不健康，該通知
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain('偵測不到')

    await monitor.runOnce() // 持續不健康，不該重複通知
    expect(notify).toHaveBeenCalledTimes(1)

    tunnelCount = 1 // 恢復
    await monitor.runOnce() // 翻轉：不健康→健康，該通知恢復
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0]).toContain('已恢復')
  })
})
