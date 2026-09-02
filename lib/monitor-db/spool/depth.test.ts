import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpoolDepth, readSpoolStatsForHeartbeat } from './depth.ts'

// §6.8(b)：spool_depth ＝ 全部資料檔「未 ack 位元組」換算的條目數總和；
// oldest ＝ 未 ack 條目中最舊的 ts。壞檔／缺游標一律按「整檔未 ack」保守計。

const dirs: string[] = []

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'spool-depth-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function entry(seq: number, ts: string): string {
  return `${JSON.stringify({ seq, ts, host: 'head', run_id: null, fn: 'upsertMonitorHeartbeat', args: [{}] })}\n`
}

/** 寫一個資料檔，回傳每一行結束後的位元組偏移量（拿來當游標的 acked_bytes）。 */
function writeDataFile(dir: string, name: string, lines: string[]): number[] {
  writeFileSync(join(dir, name), lines.join(''))
  const offsets: number[] = []
  let acc = 0
  for (const l of lines) {
    acc += Buffer.byteLength(l)
    offsets.push(acc)
  }
  return offsets
}

function writeCursor(dir: string, dataName: string, raw: string): void {
  writeFileSync(join(dir, `${dataName}.cursor`), raw)
}

describe('readSpoolDepth', () => {
  test('目錄不存在 → 全 0，不拋例外', () => {
    expect(readSpoolDepth(join(tmpdir(), 'spool-depth-does-not-exist-xyz'))).toMatchObject({ depth: 0, oldestTs: null, files: 0 })
  })

  test('沒有游標檔 → 整檔未 ack；oldestTs 取第一條', () => {
    const dir = tmpDir()
    writeDataFile(dir, 'server.100.1000.jsonl', [entry(1, '2026-09-01T00:00:00.000Z'), entry(2, '2026-09-01T00:01:00.000Z')])

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(2)
    expect(stats.oldestTs).toBe('2026-09-01T00:00:00.000Z')
    expect(stats.files).toBe(1)
    expect(stats.perFile[0]!.cursorFallback).toBe(false) // 缺檔走 emptyCursor(acked=0)，是合法值不是壞值
  })

  test('游標已 ack 前兩條 → 只算剩下的，oldestTs 跟著往後移', () => {
    const dir = tmpDir()
    const name = 'server.100.1000.jsonl'
    const offsets = writeDataFile(dir, name, [
      entry(1, '2026-09-01T00:00:00.000Z'),
      entry(2, '2026-09-01T00:01:00.000Z'),
      entry(3, '2026-09-01T00:02:00.000Z'),
    ])
    writeCursor(dir, name, JSON.stringify({ acked_bytes: offsets[1], acked_seq: 2, failing: {}, updated_at: '' }))

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(1)
    expect(stats.oldestTs).toBe('2026-09-01T00:02:00.000Z')
  })

  test('全部 ack 完 → 深度 0、oldestTs null', () => {
    const dir = tmpDir()
    const name = 'server.100.1000.jsonl'
    const offsets = writeDataFile(dir, name, [entry(1, '2026-09-01T00:00:00.000Z'), entry(2, '2026-09-01T00:01:00.000Z')])
    writeCursor(dir, name, JSON.stringify({ acked_bytes: offsets[1], acked_seq: 2, failing: {}, updated_at: '' }))

    expect(readSpoolDepth(dir)).toMatchObject({ depth: 0, oldestTs: null })
  })

  test('半行（最後一行還沒收尾）不計——與 replayer 的「讀到最後一個完整換行」同判準', () => {
    const dir = tmpDir()
    const name = 'server.100.1000.jsonl'
    writeFileSync(join(dir, name), `${entry(1, '2026-09-01T00:00:00.000Z')}{"seq":2,"ts":"2026-09-01T00:0`)

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(1)
    expect(stats.unackedBytes).toBe(Buffer.byteLength(entry(1, '2026-09-01T00:00:00.000Z')))
  })

  test('空行不計（同 replayer 的 length===0 跳過）', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'server.100.1000.jsonl'), `${entry(1, '2026-09-01T00:00:00.000Z')}\n${entry(2, '2026-09-01T00:01:00.000Z')}`)
    expect(readSpoolDepth(dir).depth).toBe(2)
  })

  test('游標 JSON 壞掉 → 整檔未 ack（保守）', () => {
    const dir = tmpDir()
    const name = 'server.100.1000.jsonl'
    writeDataFile(dir, name, [entry(1, '2026-09-01T00:00:00.000Z'), entry(2, '2026-09-01T00:01:00.000Z')])
    writeCursor(dir, name, '{ this is not json')

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(2)
    expect(stats.oldestTs).toBe('2026-09-01T00:00:00.000Z')
  })

  test('游標 acked_bytes 超出檔案大小（壞值／檔案被截短）→ 整檔未 ack 並標記 cursorFallback', () => {
    const dir = tmpDir()
    const name = 'server.100.1000.jsonl'
    writeDataFile(dir, name, [entry(1, '2026-09-01T00:00:00.000Z')])
    writeCursor(dir, name, JSON.stringify({ acked_bytes: 999_999, acked_seq: 9, failing: {}, updated_at: '' }))

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(1)
    expect(stats.perFile[0]!.cursorFallback).toBe(true)
  })

  test('游標 acked_bytes 是負數／非數字 → 一樣退回整檔未 ack', () => {
    const dir = tmpDir()
    for (const [name, raw] of [
      ['server.101.1000.jsonl', JSON.stringify({ acked_bytes: -5 })],
      ['server.102.1000.jsonl', JSON.stringify({ acked_bytes: 'abc' })],
    ] as const) {
      writeDataFile(dir, name, [entry(1, '2026-09-01T00:00:00.000Z')])
      writeCursor(dir, name, raw)
    }
    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(2)
    expect(stats.perFile.every(f => f.cursorFallback)).toBe(true)
  })

  test('壞行仍計入深度（replayer 會消費它、推進游標，它確實是待處理的量）；ts 往後幾行找', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'server.100.1000.jsonl'), `{not json}\n${entry(2, '2026-09-01T00:05:00.000Z')}`)

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(2)
    expect(stats.oldestTs).toBe('2026-09-01T00:05:00.000Z')
  })

  test('多檔加總；oldestTs 取全目錄最舊', () => {
    const dir = tmpDir()
    writeDataFile(dir, 'server.100.1000.jsonl', [entry(1, '2026-09-01T03:00:00.000Z')])
    writeDataFile(dir, 'tg-monitor.200.2000.jsonl', [entry(1, '2026-09-01T01:00:00.000Z'), entry(2, '2026-09-01T02:00:00.000Z')])

    const stats = readSpoolDepth(dir)
    expect(stats.depth).toBe(3)
    expect(stats.files).toBe(2)
    expect(stats.oldestTs).toBe('2026-09-01T01:00:00.000Z')
  })

  test('非資料檔（.dead.jsonl / .cursor / 其他）一律不掃', () => {
    const dir = tmpDir()
    writeDataFile(dir, 'server.100.1000.jsonl', [entry(1, '2026-09-01T00:00:00.000Z')])
    writeFileSync(join(dir, 'server.100.1000.dead.jsonl'), entry(9, '2026-09-01T00:00:00.000Z'))
    writeFileSync(join(dir, '.replayer.lock'), '123')
    writeFileSync(join(dir, 'random.txt'), 'x\ny\n')

    expect(readSpoolDepth(dir)).toMatchObject({ depth: 1, files: 1 })
  })

  test('跨越 1MB 讀取分塊邊界仍正確計數（大量條目）', () => {
    const dir = tmpDir()
    const lines: string[] = []
    for (let i = 1; i <= 6000; i++) lines.push(entry(i, `2026-09-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`))
    writeDataFile(dir, 'server.100.1000.jsonl', lines)
    // 一條約 130 bytes × 6000 ≈ 780KB，加上下面重複寫一份確保跨過 1MB。
    writeDataFile(dir, 'server.101.1000.jsonl', lines)

    expect(readSpoolDepth(dir).depth).toBe(12_000)
  })
})

describe('readSpoolStatsForHeartbeat', () => {
  test('回 monitor_heartbeat 兩個觀察欄要的形狀', () => {
    const dir = tmpDir()
    writeDataFile(dir, 'server.100.1000.jsonl', [entry(1, '2026-09-01T00:00:00.000Z')])
    expect(readSpoolStatsForHeartbeat(dir)).toEqual({ depth: 1, oldestTs: '2026-09-01T00:00:00.000Z' })
  })

  test('空目錄 → depth 0、oldestTs null（不是 NULL：0 是真的量到 0）', () => {
    expect(readSpoolStatsForHeartbeat(tmpDir())).toEqual({ depth: 0, oldestTs: null })
  })
})
