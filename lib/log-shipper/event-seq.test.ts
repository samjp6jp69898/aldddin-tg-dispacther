import { describe, expect, test } from 'bun:test'
import { createEventSeqCounter, eventSeqToNumber } from './event-seq.ts'

describe('createEventSeqCounter — 記憶體單調計數器（【G:MN-G11】）', () => {
  test('正常遞增時鐘：event_seq 隨 wall clock 前進', () => {
    let now = 1_000_000
    const counter = createEventSeqCounter(() => now)
    const a = counter.next()
    now += 5
    const b = counter.next()
    expect(a).toBe(1_000_000_000n)
    expect(b).toBe(1_000_005_000n)
    expect(b > a).toBe(true)
  })

  test('缺陷案例 1：時鐘回撥——回撥後仍嚴格遞增，不倒退', () => {
    let now = 2_000_000
    const counter = createEventSeqCounter(() => now)
    const a = counter.next() // 2_000_000_000
    now = 1_000_000 // 時鐘往回跳一秒
    const b = counter.next()
    const c = counter.next()
    expect(b > a).toBe(true)
    expect(c > b).toBe(true)
    // 回撥後的值不是用新的（更小的）wall clock 算出來的，而是 last+1。
    expect(b).toBe(a + 1n)
    expect(c).toBe(a + 2n)
  })

  test('缺陷案例 2：同一毫秒內連續呼叫多次——每次仍嚴格遞增', () => {
    const now = 3_000_000
    const counter = createEventSeqCounter(() => now)
    const seqs = Array.from({ length: 5 }, () => counter.next())
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! > seqs[i - 1]!).toBe(true)
    }
    expect(seqs[0]).toBe(3_000_000_000n)
    expect(seqs[4]).toBe(3_000_000_004n)
  })

  test('預設 now=Date.now：兩次連續呼叫仍嚴格遞增（不靠等待時間）', () => {
    const counter = createEventSeqCounter()
    const a = counter.next()
    const b = counter.next()
    expect(b > a).toBe(true)
  })
})

describe('eventSeqToNumber', () => {
  test('BigInt → Number 轉換不失精度（量級約 1.7e15，遠低於 MAX_SAFE_INTEGER）', () => {
    const seq = 1_700_000_000_000n
    expect(eventSeqToNumber(seq)).toBe(1_700_000_000_000)
    expect(Number.isSafeInteger(eventSeqToNumber(seq))).toBe(true)
  })
})
