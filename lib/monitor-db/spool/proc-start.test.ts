import { describe, expect, test } from 'bun:test'
import { floorToSecond, isPidAlive, readProcStartMs } from './proc-start.ts'

describe('isPidAlive', () => {
  test('自己的 pid → true', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  test('已結束並回收的子行程 pid → false（ESRCH）', async () => {
    const proc = Bun.spawn(['bash', '-c', 'exit 0'])
    await proc.exited
    expect(isPidAlive(proc.pid)).toBe(false)
  })
})

describe('readProcStartMs', () => {
  test('自己的 pid → 回一個可解析、不晚於現在的過去時刻（LC_ALL=C 生效，可被 Date.parse 解析）', () => {
    const ms = readProcStartMs(process.pid)
    expect(ms).not.toBeNull()
    expect(ms!).toBeLessThanOrEqual(Date.now())
    expect(ms!).toBeGreaterThan(0)
  })

  test('已結束並回收的 pid → null（【G:MJ-G4】解析失敗的其中一種成因：pid 不存在）', async () => {
    const proc = Bun.spawn(['bash', '-c', 'exit 0'])
    await proc.exited
    expect(readProcStartMs(proc.pid)).toBeNull()
  })
})

describe('floorToSecond', () => {
  test('毫秒向下取整到秒', () => {
    expect(floorToSecond(1735689599999)).toBe(1735689599000)
    expect(floorToSecond(1735689600000)).toBe(1735689600000)
    expect(floorToSecond(0)).toBe(0)
  })
})
