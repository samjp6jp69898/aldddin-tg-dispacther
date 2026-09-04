import { afterEach, describe, expect, test } from 'bun:test'
import { startMonitorCollectors } from './index.ts'

// §9.0(B) 的可證偽驗收：flag 關閉時「連 timer 都不建」。用暫時替換
// globalThis.setInterval 記錄註冊次數來斷言——結構性、不靠等待時間。

const prevFlag = process.env.MON_DB_ENABLED

afterEach(() => {
  if (prevFlag === undefined) delete process.env.MON_DB_ENABLED
  else process.env.MON_DB_ENABLED = prevFlag
})

function countIntervals(fn: () => { stop(): void }): number {
  const realSetInterval = globalThis.setInterval
  let n = 0
  // @ts-expect-error 測試用替身：只需要記次數並回傳一個可被 clearInterval 接受的值。
  globalThis.setInterval = (...args: Parameters<typeof setInterval>) => {
    n++
    const t = realSetInterval(...args)
    // 立刻停掉，測試期間絕不讓任何 tick 真的跑（不碰 DB、不碰檔案）。
    clearInterval(t)
    return t
  }
  try {
    fn().stop()
  } finally {
    globalThis.setInterval = realSetInterval
  }
  return n
}

describe('startMonitorCollectors', () => {
  test('MON_DB_ENABLED 未設 / 空 / 0 → 完全不建任何 timer（head 與 worker 都是）', () => {
    for (const value of [undefined, '', '0']) {
      if (value === undefined) delete process.env.MON_DB_ENABLED
      else process.env.MON_DB_ENABLED = value
      expect(countIntervals(() => startMonitorCollectors({ role: 'mon_head' }))).toBe(0)
      expect(countIntervals(() => startMonitorCollectors({ role: 'mon_exec' }))).toBe(0)
    }
  })

  test('MON_DB_ENABLED=1：head 掛 2 個（agent_runs + audit），worker 只掛 1 個（mcp_usage 是 head only 的表）', () => {
    process.env.MON_DB_ENABLED = '1'
    expect(countIntervals(() => startMonitorCollectors({ role: 'mon_head' }))).toBe(2)
    expect(countIntervals(() => startMonitorCollectors({ role: 'mon_exec' }))).toBe(1)
  })
})
