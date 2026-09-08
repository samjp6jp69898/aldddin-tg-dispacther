import { describe, expect, test } from 'bun:test'
import { buildDataCheckString, computeTelegramHash, verifyTelegramLogin } from './telegram-login.ts'

const TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
const NOW = 1_800_000_000_000 // ms

function signed(overrides: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    id: '987654321',
    first_name: '小明',
    last_name: '王',
    username: 'ming',
    auth_date: String(Math.floor(NOW / 1000) - 30),
    ...overrides,
  }
  params.hash = computeTelegramHash(params, TOKEN)
  return params
}

describe('buildDataCheckString', () => {
  test('依 key 排序、排除 hash、以換行接起', () => {
    expect(buildDataCheckString({ hash: 'x', id: '1', auth_date: '2', first_name: 'A' })).toBe('auth_date=2\nfirst_name=A\nid=1')
  })
})

describe('verifyTelegramLogin', () => {
  test('正確簽章 + 未過期 → ok，displayName 合併 first/last', () => {
    const r = verifyTelegramLogin(signed(), TOKEN, { now: NOW })
    expect(r).toEqual({ ok: true, id: '987654321', displayName: '小明 王', username: 'ming' })
  })
  test('改動任一欄位 → bad_hash', () => {
    const p = signed()
    p.id = '111'
    expect(verifyTelegramLogin(p, TOKEN, { now: NOW })).toEqual({ ok: false, reason: 'bad_hash' })
  })
  test('用錯的 bot token 驗 → bad_hash', () => {
    expect(verifyTelegramLogin(signed(), 'other-token', { now: NOW })).toEqual({ ok: false, reason: 'bad_hash' })
  })
  test('auth_date 超過 maxAge → expired；未來時間也拒', () => {
    const old = signed({ auth_date: String(Math.floor(NOW / 1000) - 601) })
    expect(verifyTelegramLogin(old, TOKEN, { now: NOW })).toEqual({ ok: false, reason: 'expired' })
    const future = signed({ auth_date: String(Math.floor(NOW / 1000) + 120) })
    expect(verifyTelegramLogin(future, TOKEN, { now: NOW })).toEqual({ ok: false, reason: 'expired' })
  })
  test('缺 hash / id / auth_date、或格式不對 → missing_fields', () => {
    const p = signed()
    delete p.hash
    expect(verifyTelegramLogin(p, TOKEN, { now: NOW })).toEqual({ ok: false, reason: 'missing_fields' })
    expect(verifyTelegramLogin({ ...signed(), id: 'abc' }, TOKEN, { now: NOW })).toEqual({ ok: false, reason: 'missing_fields' })
    expect(verifyTelegramLogin({ ...signed(), hash: 'zz' }, TOKEN, { now: NOW })).toEqual({ ok: false, reason: 'missing_fields' })
  })
  test('沒有 last_name 時 displayName 只用 first_name；都沒有就用 id', () => {
    const p1 = signed({ last_name: '' })
    expect((verifyTelegramLogin(p1, TOKEN, { now: NOW }) as any).displayName).toBe('小明')
    const params: Record<string, string> = { id: '5', auth_date: String(Math.floor(NOW / 1000)) }
    params.hash = computeTelegramHash(params, TOKEN)
    expect((verifyTelegramLogin(params, TOKEN, { now: NOW }) as any).displayName).toBe('5')
  })
})
