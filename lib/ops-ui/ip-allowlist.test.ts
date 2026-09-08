import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createIpAllowlistGuard, isIpAllowed, parseCidrList, parseIp } from './ip-allowlist.ts'

describe('parseCidrList', () => {
  test('逗號分隔、可帶或不帶前綴、容忍空白與空項', () => {
    const list = parseCidrList(' 61.222.239.250/32, 10.0.0.0/8 ,,192.168.1.7 ')
    expect(list).toHaveLength(3)
    expect(list[2]!.bits).toBe(32)
  })
  test('IPv6 CIDR', () => {
    const list = parseCidrList('2001:db8::/32')
    expect(list[0]!.family).toBe(6)
    expect(list[0]!.bits).toBe(32)
  })
  test('空字串／undefined → 空清單（fail-closed 由呼叫端決定）', () => {
    expect(parseCidrList('')).toEqual([])
    expect(parseCidrList(undefined)).toEqual([])
  })
  test('任何一項格式錯誤就整個丟例外，不靜默略過', () => {
    expect(() => parseCidrList('10.0.0.0/8, not-an-ip')).toThrow(/不是合法 IP/)
    expect(() => parseCidrList('10.0.0.0/33')).toThrow(/前綴長度/)
    expect(() => parseCidrList('10.0.0.0/8/1')).toThrow(/格式錯誤/)
    expect(() => parseCidrList('10.0.0.256')).toThrow()
  })
})

describe('parseIp / isIpAllowed', () => {
  const cidrs = parseCidrList('61.222.239.250/32,10.0.0.0/8,2001:db8::/32')
  test('IPv4 精確與網段命中', () => {
    expect(isIpAllowed('61.222.239.250', cidrs)).toBe(true)
    expect(isIpAllowed('61.222.239.251', cidrs)).toBe(false)
    expect(isIpAllowed('10.200.3.4', cidrs)).toBe(true)
    expect(isIpAllowed('11.0.0.1', cidrs)).toBe(false)
  })
  test('IPv4-mapped IPv6（Bun requestIP 可能回這種）視為 IPv4', () => {
    expect(parseIp('::ffff:61.222.239.250')).toEqual({ family: 4, value: parseIp('61.222.239.250')!.value })
    expect(isIpAllowed('::ffff:10.1.1.1', cidrs)).toBe(true)
  })
  test('IPv6 網段', () => {
    expect(isIpAllowed('2001:db8:1::5', cidrs)).toBe(true)
    expect(isIpAllowed('2001:db9::1', cidrs)).toBe(false)
    expect(isIpAllowed('fe80::1%en0', cidrs)).toBe(false)
  })
  test('壞輸入一律不放行', () => {
    expect(isIpAllowed('', cidrs)).toBe(false)
    expect(isIpAllowed('garbage', cidrs)).toBe(false)
    expect(isIpAllowed('1.2.3', cidrs)).toBe(false)
    expect(isIpAllowed('10.0.0.1', [])).toBe(false)
  })
  test('/0 全放行', () => {
    expect(isIpAllowed('8.8.8.8', parseCidrList('0.0.0.0/0'))).toBe(true)
  })
})

describe('createIpAllowlistGuard', () => {
  function build(cidrs: string, opts: { resolveIp?: (c: any) => string | null } = {}) {
    const denied: (string | null)[] = []
    const app = new Hono()
    app.use('/ops/*', createIpAllowlistGuard({ cidrs: parseCidrList(cidrs), onDeny: ip => denied.push(ip), ...opts }))
    app.get('/ops/x', c => c.text('ok'))
    return { app, denied }
  }
  test('CF-Connecting-IP 在名單內 → 放行', async () => {
    const { app } = build('61.222.239.250/32')
    const res = await app.request('/ops/x', { headers: { 'cf-connecting-ip': '61.222.239.250' } })
    expect(res.status).toBe(200)
  })
  test('CF-Connecting-IP 不在名單內 → 401 空 body（與 catch-all 無法區分）並記錄 IP', async () => {
    const { app, denied } = build('61.222.239.250/32')
    const res = await app.request('/ops/x', { headers: { 'cf-connecting-ip': '8.8.8.8' } })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(denied).toEqual(['8.8.8.8'])
  })
  test('沒有 header、也拿不到 socket 位址（測試環境）→ 拒絕，不 throw', async () => {
    const { app, denied } = build('0.0.0.0/0')
    const res = await app.request('/ops/x')
    expect(res.status).toBe(401)
    expect(denied).toEqual([null])
  })
  test('名單為空 → 一律拒絕（fail-closed）', async () => {
    const { app } = build('', { resolveIp: () => '10.0.0.1' })
    expect((await app.request('/ops/x')).status).toBe(401)
  })
  test('自訂 resolveIp（LAN 直連的 socket 位址）', async () => {
    const { app } = build('10.0.0.0/8', { resolveIp: () => '10.9.9.9' })
    expect((await app.request('/ops/x')).status).toBe(200)
  })
})
