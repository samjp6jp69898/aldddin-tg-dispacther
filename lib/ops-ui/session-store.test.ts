import { describe, expect, test } from 'bun:test'
import { createSessionStore } from './session-store.ts'

const USER = { notion_user_id: 'u1', notion_user_name: '小明', email: 'ming@example.com' }

describe('createSessionStore', () => {
  test('create → get 拿得到同一份；id 為 64 hex', () => {
    const store = createSessionStore({ ttlMs: 1000, now: () => 100 })
    const s = store.create('123', USER, '小明')
    expect(s.id).toMatch(/^[0-9a-f]{64}$/)
    expect(store.get(s.id)).toBe(s)
    expect(s.expiresAt).toBe(1100)
  })
  test('過期後 get 回 null 並移除', () => {
    let t = 100
    const store = createSessionStore({ ttlMs: 1000, now: () => t })
    const s = store.create('123', USER, '小明')
    t = 1100
    expect(store.get(s.id)).toBeNull()
    expect(store.size()).toBe(0)
  })
  test('delete 後 get 回 null；不存在的 id 回 null', () => {
    const store = createSessionStore({ ttlMs: 1000 })
    const s = store.create('123', USER, '小明')
    store.delete(s.id)
    expect(store.get(s.id)).toBeNull()
    expect(store.get('nope')).toBeNull()
  })
  test('create 時順手清掉其他過期 session', () => {
    let t = 0
    const store = createSessionStore({ ttlMs: 10, now: () => t })
    store.create('1', USER, 'a')
    store.create('2', USER, 'b')
    t = 50
    store.create('3', USER, 'c')
    expect(store.size()).toBe(1)
  })
})
