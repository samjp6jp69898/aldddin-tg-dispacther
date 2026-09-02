import { describe, expect, test } from 'bun:test'
import { batchByBytes } from './batching.ts'

describe('batchByBytes', () => {
  test('小項目依序塞進同一批，直到超過軟目標才切下一批', () => {
    const items = ['a', 'b', 'c', 'd']
    const sizeOf = (s: string) => 40 // 每項固定 40 bytes
    const batches = batchByBytes(items, sizeOf, 100) // 100 軟目標：3 項=120>100，第 3 項應切到下一批
    expect(batches).toEqual([['a', 'b'], ['c', 'd']])
  })

  test('單一項目超過軟目標 → 該項自成一批，不等下一個 item', () => {
    const items = ['small', 'huge', 'small2']
    const sizeOf = (s: string) => (s === 'huge' ? 1000 : 10)
    const batches = batchByBytes(items, sizeOf, 100)
    expect(batches).toEqual([['small'], ['huge'], ['small2']])
  })

  test('全部項目加總都不超過軟目標時只有一批', () => {
    const items = [1, 2, 3]
    const batches = batchByBytes(items, () => 10, 1000)
    expect(batches).toEqual([[1, 2, 3]])
  })

  test('空陣列回傳空批次清單', () => {
    expect(batchByBytes([], () => 10, 100)).toEqual([])
  })

  test('連續兩個超大項目各自獨立成批', () => {
    const items = ['huge1', 'huge2']
    const batches = batchByBytes(items, () => 500, 100)
    expect(batches).toEqual([['huge1'], ['huge2']])
  })
})
