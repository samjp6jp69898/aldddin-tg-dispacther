import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpoolDepth, readSpoolStatsForHeartbeat } from './depth.ts'

// §6.8(b)：spool_depth ＝ 全部資料檔「未 ack 位元組」換算的條目數總和；
// oldest ＝ 未 ack 條目中最舊的 ts。壞檔／缺游標一律按「整檔未 ack」保守計。

/** 與 depth.ts 的 READ_CHUNK_BYTES 同值。刻意在測試裡寫死：這組測試要驗的就是
 * 「換行剛好落在讀取分塊邊界」，值若跟著實作變動就驗不到那個位移了。 */
const CHUNK = 1 << 20

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

  // 對抗性覆核（2026-09-02）實證的邊界缺陷：舊實作用 chunk 內相對 index 當行起點
  // 判空行，換行恰好落在 start + k×1MB 時該條目被漏計。舊測試寫的是**兩個各
  // 672KB 的獨立檔案**（measureFile 逐檔掃描 ⇒ 兩檔都在單一 chunk 內跑完），
  // 從未跨過任何 chunk 邊界，正是那個缺陷得以存活的原因。下面三條都是**單一檔案**
  // 且真的跨界，其中兩條把換行精確釘在邊界位移上。
  describe('1MB 讀取分塊邊界', () => {
    /** 產生一條位元組長度**精確**為 totalBytes 的條目（不含換行）。 */
    function paddedEntry(seq: number, ts: string, totalBytes: number): string {
      const shell = { seq, ts, host: 'head', run_id: null, fn: 'upsertMonitorHeartbeat', pad: '' }
      const need = totalBytes - Buffer.byteLength(JSON.stringify(shell))
      if (need < 0) throw new Error(`paddedEntry: totalBytes 太小（至少 ${Buffer.byteLength(JSON.stringify(shell))}）`)
      // pad 全是 ASCII 'x'，JSON.stringify 不會轉義 ⇒ 每加 1 個字元剛好加 1 byte。
      return JSON.stringify({ ...shell, pad: 'x'.repeat(need) })
    }

    test('paddedEntry 自身的長度保證（下面兩條測試的前提）', () => {
      expect(Buffer.byteLength(paddedEntry(1, '2026-09-01T00:00:00.000Z', CHUNK))).toBe(CHUNK)
    })

    test('換行位元組**恰好**落在第一個 chunk 邊界（絕對位移 = 1MB）→ 兩條都要算到', () => {
      const dir = tmpDir()
      // 第一行內容佔 byte 0..CHUNK-1，換行落在 byte CHUNK ⇒ 它是第 2 個 chunk 的
      // 第一個位元組（chunk 內 index 0）。舊實作在這裡回 depth=1。
      const first = paddedEntry(1, '2026-09-01T00:00:00.000Z', CHUNK)
      writeFileSync(join(dir, 'server.100.1000.jsonl'), `${first}\n${entry(2, '2026-09-01T00:01:00.000Z')}`)

      const stats = readSpoolDepth(dir)
      expect(stats.depth).toBe(2)
      // depth 與 unackedBytes 必須互相自洽（舊實作這兩個值會互相矛盾）
      expect(stats.unackedBytes).toBe(CHUNK + 1 + Buffer.byteLength(entry(2, '2026-09-01T00:01:00.000Z')))
      // oldestTs 在這個人造 fixture 下是 null——第一條就有 1MB，超出 64KB 的 ts
      // 探測窗（見下面「ts 探測窗」那條測試）。這裡驗的是 depth，不是 ts。
    })

    test('游標非 0 時，邊界是 start + 1MB（不是檔案的 1MB）→ 一樣要算到', () => {
      const dir = tmpDir()
      const name = 'server.100.1000.jsonl'
      const acked = entry(1, '2026-09-01T00:00:00.000Z')
      const start = Buffer.byteLength(acked)
      // 未 ack 區的第一行內容佔 start..start+CHUNK-1，換行落在 start+CHUNK。
      const second = paddedEntry(2, '2026-09-01T00:01:00.000Z', CHUNK)
      writeFileSync(join(dir, name), `${acked}${second}\n${entry(3, '2026-09-01T00:02:00.000Z')}`)
      writeCursor(dir, name, JSON.stringify({ acked_bytes: start, acked_seq: 1, failing: {}, updated_at: '' }))

      expect(readSpoolDepth(dir).depth).toBe(2)
    })

    test('單檔遠大於 1MB 的大量條目（跨多個邊界）逐條計數正確，oldestTs 取未 ack 區第一條', () => {
      const dir = tmpDir()
      const lines: string[] = []
      for (let i = 1; i <= 20_000; i++) lines.push(entry(i, `2026-09-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`))
      const total = lines.reduce((a, l) => a + Buffer.byteLength(l), 0)
      writeDataFile(dir, 'server.100.1000.jsonl', lines)

      expect(total).toBeGreaterThan(2 * CHUNK) // 真的跨過至少兩個邊界
      const stats = readSpoolDepth(dir)
      expect(stats.depth).toBe(20_000)
      // 正常尺寸的條目下，跨多個 chunk 邊界不影響 oldestTs
      expect(stats.oldestTs).toBe('2026-09-01T00:00:00.001Z')
    })

    test('ts 探測窗：未 ack 區第一條就超過 64KB ⇒ oldestTs = null（未知），不是猜一個錯的值', () => {
      const dir = tmpDir()
      const huge = paddedEntry(1, '2026-09-01T00:00:00.000Z', 100 * 1024)
      writeFileSync(join(dir, 'server.100.1000.jsonl'), `${huge}\n${entry(2, '2026-09-01T00:01:00.000Z')}`)

      const stats = readSpoolDepth(dir)
      expect(stats.depth).toBe(2) // 計數不受影響
      expect(stats.oldestTs).toBeNull() // 「不知道」而非回第二條的 ts（那會低報積壓年齡）
    })

    test('空行恰好落在 chunk 邊界時仍然不計（修正不得把空行判準弄丟）', () => {
      const dir = tmpDir()
      // 第一行 CHUNK-1 bytes + '\n'（換行在 byte CHUNK-1）⇒ 下一行起點正好是 byte
      // CHUNK ＝ 第 2 個 chunk 的 index 0；讓那一行是空行。
      const first = paddedEntry(1, '2026-09-01T00:00:00.000Z', CHUNK - 1)
      writeFileSync(join(dir, 'server.100.1000.jsonl'), `${first}\n\n${entry(3, '2026-09-01T00:02:00.000Z')}`)

      expect(readSpoolDepth(dir).depth).toBe(2) // 第一行 + 最後一行，中間空行不算
    })
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
