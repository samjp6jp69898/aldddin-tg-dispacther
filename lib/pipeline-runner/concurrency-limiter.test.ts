import { describe, expect, test } from 'bun:test'
import { createConcurrencyLimiter } from './concurrency-limiter.ts'

describe('createConcurrencyLimiter', () => {
  test('額度內的 acquire 全部成功', () => {
    const limiter = createConcurrencyLimiter(3)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.current()).toBe(3)
  })

  test('超過上限的第 N+1 個 acquire 被拒絕，不佔用名額', () => {
    const limiter = createConcurrencyLimiter(2)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false) // 第 3 個：額度用盡
    expect(limiter.current()).toBe(2) // 沒被拒絕的那次意外扣掉名額
    expect(limiter.tryAcquire()).toBe(false) // 持續拒絕
  })

  test('release 後名額被正確歸還，之前被拒的下一次 acquire 可以成功', () => {
    const limiter = createConcurrencyLimiter(1)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false)

    limiter.release()
    expect(limiter.current()).toBe(0)
    expect(limiter.tryAcquire()).toBe(true)
  })

  // acceptance criteria 原文：「不會因為某次流程異常結束就永久佔用名額」——
  // 對應到這裡就是 release 不能因為呼叫時機/次數而讓計數器壞掉。
  test('release 不會讓計數器變成負數（多次呼叫、或從未 acquire 就呼叫都安全）', () => {
    const limiter = createConcurrencyLimiter(2)
    limiter.release()
    limiter.release()
    expect(limiter.current()).toBe(0)

    expect(limiter.tryAcquire()).toBe(true)
    limiter.release()
    limiter.release() // 多釋放一次
    expect(limiter.current()).toBe(0)

    // 驗證沒有因為上面的多釋放而讓計數器變負數、進而多放行超過 limit 的請求
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false)
  })

  test('多個 limiter 互相獨立，不共用狀態', () => {
    const a = createConcurrencyLimiter(1)
    const b = createConcurrencyLimiter(1)
    expect(a.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(true) // b 沒被 a 佔滿
    expect(a.tryAcquire()).toBe(false)
  })
})
