import { describe, expect, test } from 'bun:test'
import { mysqlDatetimeToIso } from './check-worker-heartbeat.ts'

describe('mysqlDatetimeToIso（dateStrings 回傳的空格分隔字串 → 嚴格 ISO 8601）', () => {
  test('空格分隔、無時區標記的 mysql2 字串轉成 T 分隔＋Z', () => {
    expect(mysqlDatetimeToIso('2026-09-09 02:39:52.973')).toBe('2026-09-09T02:39:52.973Z')
  })

  test('轉出來的字串可以被 Date 正確解析', () => {
    const iso = mysqlDatetimeToIso('2026-09-09 13:35:00.720')
    expect(new Date(iso).toISOString()).toBe('2026-09-09T13:35:00.720Z')
  })
})
