import { describe, expect, test } from 'bun:test'
import { isoToMysqlDatetime3, isoToMysqlDatetime3OrNull, mysqlDatetimeToIso } from './mysql-datetime.ts'

describe('mysql-datetime：ISO ↔ MySQL DATETIME(3) 轉換', () => {
  test('isoToMysqlDatetime3：標準毫秒精度', () => {
    expect(isoToMysqlDatetime3('2026-08-26T03:23:44.751Z')).toBe('2026-08-26 03:23:44.751')
  })

  test('isoToMysqlDatetime3：無毫秒補 000', () => {
    expect(isoToMysqlDatetime3('2026-08-26T03:23:44Z')).toBe('2026-08-26 03:23:44.000')
  })

  test('isoToMysqlDatetime3：非 UTC（無 Z 結尾）一律拒絕', () => {
    expect(() => isoToMysqlDatetime3('2026-08-26T03:23:44.751+08:00')).toThrow()
    expect(() => isoToMysqlDatetime3('2026-08-26 03:23:44.751')).toThrow()
  })

  test('mysqlDatetimeToIso：往返', () => {
    expect(mysqlDatetimeToIso('2026-08-26 03:23:44.751')).toBe('2026-08-26T03:23:44.751Z')
  })

  test('往返一致性：iso → mysql → iso', () => {
    const iso = '2026-08-26T03:23:44.751Z'
    expect(mysqlDatetimeToIso(isoToMysqlDatetime3(iso))).toBe(iso)
  })

  test('OrNull：null/undefined 直接回 null', () => {
    expect(isoToMysqlDatetime3OrNull(null)).toBeNull()
    expect(isoToMysqlDatetime3OrNull(undefined)).toBeNull()
    expect(isoToMysqlDatetime3OrNull('2026-08-26T03:23:44.751Z')).toBe('2026-08-26 03:23:44.751')
  })
})
