import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogShipper, LOG_SHIP_INTERVAL_MS, MAX_BATCHES_PER_CYCLE, MAX_BATCH_BYTES } from './shipper.ts'
import { FakeFileOffsetsDb } from './test-support/fake-file-offsets-db.ts'
import type { LogSink, ShipLine } from './types.ts'
import { MON_HOST } from '../monitor-db/env.ts'

// upsertFileOffset（lib/monitor-db/writes.ts）內部一律用 MON_HOST 常數當
// file_offsets.host（不接受呼叫端傳入的 host，唯讀確認過），與本模組
// LogShipperDeps.host（只影響 ShipLine 的 stream field / lookupRunId 參數）
// 是兩件事——這裡不覆寫 host，讓兩者維持一致，DB 列斷言直接用 MON_HOST。

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-shipper-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeSink(resultFn: (batch: ShipLine[]) => boolean = () => true): { sink: LogSink; calls: ShipLine[][] } {
  const calls: ShipLine[][] = []
  const sink: LogSink = {
    async send(batch) {
      calls.push(batch)
      return resultFn(batch)
    },
  }
  return { sink, calls }
}

describe('對齊算術（MN-G9 + intake 每 worker 60 req/min burst 120 額度）', () => {
  test('cyclesPerMinute * MAX_BATCHES_PER_CYCLE 不得超過 60（常數被改壞就紅）', () => {
    const cyclesPerMinute = 60 / (LOG_SHIP_INTERVAL_MS / 1000)
    expect(cyclesPerMinute * MAX_BATCHES_PER_CYCLE).toBeLessThanOrEqual(60)
  })
})

describe('createLogShipper — offset 語意（v3.2 裁定 4(d)）', () => {
  test('2xx 才推進 file_offsets 與記憶體游標', async () => {
    const p = join(dir, 'a.log')
    writeFileSync(p, 'line1\nline2\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({
      listSourceFiles: () => [p],
      sink,
      executor,
      lookupRunId: async () => null,
      now: () => 1_700_000_000_000,
    })

    const result = await shipper.runOneCycle()
    expect(result.aborted).toBe(false)
    expect(result.linesShipped).toBe(2)
    expect(result.batchesSent).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.map(l => l.content)).toEqual(['line1', 'line2'])

    const cursors = shipper.getCursors()
    expect(cursors[p]).toEqual({ inode: expect.any(Number), offset: 12 })
    const row = [...executor.rows.values()].find(r => r.host === MON_HOST && r.path === p)
    expect(row?.offset).toBe(12)
  })

  test('非 2xx → offset 不推進、本輪結束（aborted=true），下一輪自然重送', async () => {
    const p = join(dir, 'b.log')
    writeFileSync(p, 'line1\nline2\n')
    const { sink, calls } = fakeSink(() => false)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    const result = await shipper.runOneCycle()
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe('sink_rejected')
    expect(result.linesShipped).toBe(0)
    expect(shipper.getCursors()[p]).toBeUndefined()
    expect(executor.rows.size).toBe(0)

    // 下一輪（sink 依然失敗，模擬持續故障）重送同樣的內容——結構上只重複。
    const result2 = await shipper.runOneCycle()
    expect(result2.aborted).toBe(true)
    expect(calls[0]!.map(l => l.content)).toEqual(calls[1]!.map(l => l.content))
  })

  test('upsertFileOffset 自身失敗 → 記憶體 offset 也不推進，直到重放成功（只重複、不缺口）', async () => {
    const p = join(dir, 'c.log')
    writeFileSync(p, 'line1\nline2\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    executor.throwOnNextExecute = true
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    const result = await shipper.runOneCycle()
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe('offset_write_failed')
    expect(shipper.getCursors()[p]).toBeUndefined() // 記憶體 offset 沒有推進
    expect(executor.rows.size).toBe(0) // DB 也沒有列（UPDATE 0 matched 之後 INSERT 都沒跑完）

    // 重放：這次 DB 呼叫成功 → 同樣的兩行會被重送一次（重複，不是缺口）。
    const result2 = await shipper.runOneCycle()
    expect(result2.aborted).toBe(false)
    expect(result2.linesShipped).toBe(2)
    expect(calls[0]!.map(l => l.content)).toEqual(calls[1]!.map(l => l.content))
    expect(shipper.getCursors()[p]?.offset).toBe(12)
  })
})

describe('createLogShipper — rotate 與半行', () => {
  test('rotate（inode 變更）：從 0 讀新檔', async () => {
    const p = join(dir, 'd.log')
    writeFileSync(p, 'old1\nold2\n')
    const { sink } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    const r1 = await shipper.runOneCycle()
    expect(r1.linesShipped).toBe(2)

    unlinkSync(p)
    writeFileSync(p, 'new1\n')
    const r2 = await shipper.runOneCycle()
    expect(r2.aborted).toBe(false)
    expect(r2.linesShipped).toBe(1)
    expect(shipper.getCursors()[p]?.offset).toBe(5)
  })

  test('半行（無換行結尾）留到下一輪，補完後才出現在下一輪 shipping', async () => {
    const p = join(dir, 'e.log')
    writeFileSync(p, 'complete\npartial')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    const r1 = await shipper.runOneCycle()
    expect(r1.linesShipped).toBe(1)
    expect(calls[0]!.map(l => l.content)).toEqual(['complete'])

    // 內容還沒補完：下一輪應該完全沒有東西可送（不打 sink）。
    const r2 = await shipper.runOneCycle()
    expect(r2.linesShipped).toBe(0)
    expect(calls).toHaveLength(1)

    appendFileSync(p, '-line2\n')
    const r3 = await shipper.runOneCycle()
    expect(r3.linesShipped).toBe(1)
    expect(calls[1]!.map(l => l.content)).toEqual(['partial-line2'])
  })
})

describe('createLogShipper — 遮罩、run_id/ticket/kind', () => {
  test('每行送出前套用 redactLine（預設 import）', async () => {
    const p = join(dir, 'f.log')
    writeFileSync(p, 'MYSQL_PWD=supersecret123\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    await shipper.runOneCycle()
    expect(calls[0]![0]!.content).not.toContain('supersecret123')
    expect(calls[0]![0]!.content).toContain('[REDACTED]')
  })

  test('redactLine 可注入覆寫', async () => {
    const p = join(dir, 'g.log')
    writeFileSync(p, 'hello\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({
      listSourceFiles: () => [p],
      sink,
      executor,
      lookupRunId: async () => null,
      host: 'test-host',
      redactLine: () => 'REPLACED',
    })
    await shipper.runOneCycle()
    expect(calls[0]![0]!.content).toBe('REPLACED')
  })

  test('ticket/kind 由檔名解析；run_id 由注入的 lookup 提供', async () => {
    const p = join(dir, 'FAQ-4809.2026-09-01T09-16-23-526Z.stdout.log')
    writeFileSync(p, 'hello\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({
      listSourceFiles: () => [p],
      sink,
      executor,
      lookupRunId: async (host, stdoutPath) => (stdoutPath === p ? 'run-xyz' : null),
      host: 'test-host',
    })
    await shipper.runOneCycle()
    const shipped = calls[0]![0]!
    expect(shipped.ticket).toBe('FAQ-4809')
    expect(shipped.kind).toBe('bug')
    expect(shipped.runId).toBe('run-xyz')
  })

  test('run_id lookup 對不到留空（null），不用檔名時戳猜', async () => {
    const p = join(dir, 'FAQ-9999.2026-09-01T09-16-23-526Z.stdout.log')
    writeFileSync(p, 'hello\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })
    await shipper.runOneCycle()
    expect(calls[0]![0]!.runId).toBeNull()
  })

  test('雜項檔名（非 ticket 格式）ticket/kind 留 null', async () => {
    const p = join(dir, 'health-monitor.log')
    writeFileSync(p, 'hello\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })
    await shipper.runOneCycle()
    expect(calls[0]![0]!.ticket).toBeNull()
    expect(calls[0]![0]!.kind).toBeNull()
  })
})

describe('createLogShipper — 批次切分', () => {
  test('單行 >2MB 改送截斷摘要，head_4k/tail_4k 已遮罩', async () => {
    const p = join(dir, 'h.log')
    const secret = 'MYSQL_PWD=topsecret999'
    const bigLine = secret + 'x'.repeat(2 * 1024 * 1024) + secret
    writeFileSync(p, bigLine + '\n')
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    await shipper.runOneCycle()
    const shipped = calls[0]![0]!
    expect(shipped.truncated).toBe(true)
    expect(shipped.content).toBeUndefined()
    expect(shipped.origBytes).toBe(Buffer.byteLength(bigLine, 'utf8'))
    expect(shipped.head4k).toContain('[REDACTED]')
    expect(shipped.head4k).not.toContain('topsecret999')
    expect(shipped.tail4k).toContain('[REDACTED]')
    expect(shipped.tail4k).not.toContain('topsecret999')
  })

  test('單行超過軟目標（1MB）自成一批', async () => {
    const p = join(dir, 'i.log')
    // 略小於 2MB（避免觸發 >2MB 截斷路徑），但遠超過 1MB 批次軟目標。
    const big = 'y'.repeat(1_500_000)
    writeFileSync(p, `small1\n${big}\nsmall2\n`)
    const { sink, calls } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => [p], sink, executor, lookupRunId: async () => null })

    const result = await shipper.runOneCycle()
    expect(result.aborted).toBe(false)
    // small1 自己一批、big 自己一批、small2 自己一批（big 前後都會因為超標而各自切開）。
    expect(calls.length).toBeGreaterThanOrEqual(3)
    const bigBatch = calls.find(b => b.some(l => l.content?.length === big.length))!
    expect(bigBatch).toHaveLength(1)
  })

  test('MAX_BATCHES_PER_CYCLE 軟上限：超過的檔案留到下一輪，非 abort', async () => {
    const n = MAX_BATCHES_PER_CYCLE + 2
    const paths: string[] = []
    for (let i = 0; i < n; i++) {
      const p = join(dir, `f${i}.log`)
      writeFileSync(p, 'hello\n')
      paths.push(p)
    }
    const { sink } = fakeSink(() => true)
    const executor = new FakeFileOffsetsDb()
    const shipper = createLogShipper({ listSourceFiles: () => paths, sink, executor, lookupRunId: async () => null })

    const r1 = await shipper.runOneCycle()
    expect(r1.aborted).toBe(false)
    expect(r1.batchesSent).toBe(MAX_BATCHES_PER_CYCLE)
    expect(r1.filesTouched).toHaveLength(MAX_BATCHES_PER_CYCLE)

    const r2 = await shipper.runOneCycle()
    expect(r2.aborted).toBe(false)
    expect(r2.batchesSent).toBe(n - MAX_BATCHES_PER_CYCLE)
    // 兩輪合計把全部檔案都送過一次。
    const allTouched = new Set([...r1.filesTouched, ...r2.filesTouched])
    expect(allTouched.size).toBe(n)
  })
})

describe('MAX_BATCH_BYTES 常數', () => {
  test('軟目標為 1MB', () => {
    expect(MAX_BATCH_BYTES).toBe(1024 * 1024)
  })
})
