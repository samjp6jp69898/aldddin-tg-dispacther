import { describe, expect, test } from 'bun:test'
import { MONITOR_QUERY_DEADLINE_MS, MonitorQueryTimeoutError, withMonitorDeadline } from './deadline.ts'

describe('withMonitorDeadline（§6.7 每次查詢的 1000ms deadline）', () => {
  test('預設預算是計畫逐字的 1000ms', () => {
    expect(MONITOR_QUERY_DEADLINE_MS).toBe(1000)
  })

  test('永不 resolve 的操作 → 在預算內 reject MonitorQueryTimeoutError（呼叫端必定拿回控制權）', async () => {
    // 這裡的小預算是「被測物本身就是逾時」，不是用等待迴避競態：
    // 沒有這條路徑時，呼叫端的 catch 永遠不會執行。
    const never = () => new Promise<never>(() => {})
    await expect(withMonitorDeadline('t', never, 1)).rejects.toBeInstanceOf(MonitorQueryTimeoutError)
  })

  test('正常完成的操作原樣回傳，不受 deadline 影響', async () => {
    expect(await withMonitorDeadline('t', async () => 42, 1000)).toBe(42)
  })

  test('操作自己拋的例外原樣往外傳（不會被偽裝成逾時）', async () => {
    const boom = async () => {
      throw new Error('原始錯誤')
    }
    await expect(withMonitorDeadline('t', boom, 1000)).rejects.toThrow('原始錯誤')
  })

  test('操作先完成時不留下 pending timer（測試行程能正常退出即為證據）', async () => {
    for (let i = 0; i < 50; i++) await withMonitorDeadline('t', async () => i, 60_000)
    // 若 timer 未被 clear，這 50 個 60 秒 timer 會讓 bun test 掛住到逾時。
    expect(true).toBe(true)
  })
})
