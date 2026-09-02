import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CursorState } from './types.ts'
import { createSpoolWriter } from './writer.ts'
import { reclaimSpoolFiles } from './reaper.ts'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spool-reaper-test-'))
}

const FIVE_MIN = 5 * 60 * 1000

/** 建一個資料檔 + 對應游標檔，回傳檔名。cursor 預設「全部已 ack」。 */
function makeAckedFile(
  dir: string,
  opts: { writer: string; pid: number; startEpochMs: number; ackedBytes?: number },
): string {
  const w = createSpoolWriter({ writer: opts.writer, dir, pid: opts.pid, startEpochMs: opts.startEpochMs })
  w.append({ ts: 't', host: 'h', run_id: 'r1', fn: 'f', args: [] })
  w.close()
  const name = w.filePath().split('/').pop()!
  const size = statSync(join(dir, name)).size
  const cursor: CursorState = {
    acked_bytes: opts.ackedBytes ?? size,
    acked_seq: 1,
    failing: {},
    updated_at: new Date().toISOString(),
  }
  writeFileSync(`${join(dir, name)}.cursor`, JSON.stringify(cursor))
  return name
}

describe('reclaimSpoolFiles', () => {
  test('【Phase 1.4 測試 3】回收器不誤刪（pid 存活）：即使 acked_bytes == size 且已閒置很久，pid 仍存活的檔案永不 unlink', () => {
    const dir = tmpDir()
    const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: 1000 })
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 }, // self 不是 100，所以這不是「自己的當前檔」
      {
        isPidAlive: pid => pid === 100, // 100 活著
        readProcStartMs: () => 1000, // 與檔名 startEpochMs 相同(=1000)，floorToSecond 後不構成「嚴格大於」，判定仍是同一個行程
        now: () => Date.now() + 10 * FIVE_MIN, // 就算過了很久
      },
    )
    expect(result.reclaimed).not.toContain(name)
    expect(existsSync(join(dir, name))).toBe(true)
  })

  test('pid 存活但被重用（啟動時刻晚於檔名記的 startEpochMs）→ 視為已終止，可回收', () => {
    const dir = tmpDir()
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: start })
    const filePath = join(dir, name)
    const size = statSync(filePath).size
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      {
        isPidAlive: () => true,
        readProcStartMs: () => start + 60_000, // 現在這個 100 是「晚於檔名 startEpochMs」啟動的，pid 重用
        // stat 與 now 用同一組虛構時間基準（跟真實檔案 mtime 無關，避免與
        // 測試機真實牆鐘時間打架）：mtimeMs 固定在 start，「現在」是 start 之後
        // 超過 5 分鐘。
        stat: () => ({ size, mtimeMs: start }),
        now: () => start + FIVE_MIN + 1,
      },
    )
    expect(result.reclaimed).toContain(name)
    expect(existsSync(filePath)).toBe(false)
  })

  test('秒級截斷邊界：pid 重用行程恰好落在檔名同一秒內啟動 → 偏向保留（不回收）', () => {
    const dir = tmpDir()
    const startMs = 1735689599500 // 落在同一秒內（floor 後與下面的 readProcStartMs 相同）
    const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: startMs })
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      {
        isPidAlive: () => true,
        readProcStartMs: () => 1735689599000, // floorToSecond(startMs) 也是這個值，不是嚴格 >，判定仍存活
        now: () => startMs + 10 * FIVE_MIN,
      },
    )
    expect(result.reclaimed).not.toContain(name)
    expect(existsSync(join(dir, name))).toBe(true)
  })

  for (const [label, cause] of [
    ['非 0 退出', 'nonzero-exit'],
    ['空輸出', 'empty-stdout'],
    ['ps 輸出格式非預期（Date.parse 失敗）', 'unparseable-format'],
  ] as const) {
    test(`【Phase 1.4 測試 4】回收器不誤刪（lstart 解析失敗：${label}）→ 不 unlink，且記一次 spool_reap_unknown_pidstart WARN`, () => {
      const dir = tmpDir()
      // 三種成因對呼叫端而言全部回傳同一個訊號：null——這正是本測試要驗證的
      // 事(reaper 不在乎底層原因，只在乎「解析不出來 = 視為存活」這個方向)。
      void cause
      const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: 1000 })
      const warnings: Array<{ metric: string; detail?: Record<string, unknown> }> = []
      const result = reclaimSpoolFiles(
        dir,
        { writer: 'server', pid: 999 },
        {
          isPidAlive: () => true, // pid 存活
          readProcStartMs: () => null, // 解析失敗
          now: () => Date.now() + 10 * FIVE_MIN,
          onWarn: (metric, detail) => warnings.push({ metric, detail }),
        },
      )
      expect(result.reclaimed).not.toContain(name)
      expect(existsSync(join(dir, name))).toBe(true)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.metric).toBe('spool_reap_unknown_pidstart')
    })
  }

  test('【Phase 1.4 測試 4b】求值順序（MN-G5 的關門）：死活判定的呼叫一定發生在 stat 呼叫之前', () => {
    const dir = tmpDir()
    makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: 1000 })
    const callLog: string[] = []
    reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      {
        isPidAlive: pid => {
          callLog.push(`isPidAlive(${pid})`)
          return false // 已終止,讓流程往下走到 stat
        },
        readProcStartMs: () => {
          callLog.push('readProcStartMs') // 這個案例 isPidAlive=false 時不該被呼叫（短路）
          return null
        },
        stat: (path: string) => {
          callLog.push(`stat(${path})`)
          return { size: 0, mtimeMs: 0 }
        },
        now: () => 10 * FIVE_MIN,
      },
    )
    expect(callLog[0]).toMatch(/^isPidAlive/)
    const statIndex = callLog.findIndex(c => c.startsWith('stat('))
    const deathCheckIndex = callLog.findIndex(c => c.startsWith('isPidAlive'))
    expect(deathCheckIndex).toBeGreaterThanOrEqual(0)
    expect(statIndex).toBeGreaterThan(deathCheckIndex) // stat 一定發生在死活判定之後
    expect(callLog).not.toContain('readProcStartMs') // isPidAlive=false 時短路，不該呼叫 readProcStartMs
  })

  test('求值順序（pid 存活分支）：readProcStartMs 的呼叫也一定發生在 stat 之前', () => {
    const dir = tmpDir()
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: start })
    const callLog: string[] = []
    reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      {
        isPidAlive: () => {
          callLog.push('isPidAlive')
          return true
        },
        readProcStartMs: () => {
          callLog.push('readProcStartMs')
          return start + 60_000 // pid 重用,判定終止,繼續往下 stat
        },
        stat: (path: string) => {
          callLog.push('stat')
          return { size: 0, mtimeMs: 0 }
        },
        now: () => start + 10 * FIVE_MIN,
      },
    )
    expect(callLog.indexOf('stat')).toBeGreaterThan(callLog.indexOf('readProcStartMs'))
    expect(callLog.indexOf('readProcStartMs')).toBeGreaterThan(callLog.indexOf('isPidAlive'))
  })

  test('長駐行程自己目前正在寫的檔（writer/pid 與 self 相同）永不回收，即使已閒置很久', () => {
    const dir = tmpDir()
    const name = makeAckedFile(dir, { writer: 'server', pid: 999, startEpochMs: 1000 })
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 }, // self 就是這個 pid
      { isPidAlive: () => true, now: () => Date.now() + 10 * FIVE_MIN },
    )
    expect(result.reclaimed).not.toContain(name)
    expect(existsSync(join(dir, name))).toBe(true)
  })

  test('未全部 ack（acked_bytes < size）→ 即使已終止也不回收', () => {
    const dir = tmpDir()
    const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: 1000, ackedBytes: 0 })
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      { isPidAlive: () => false, now: () => Date.now() + 10 * FIVE_MIN },
    )
    expect(result.reclaimed).not.toContain(name)
    expect(existsSync(join(dir, name))).toBe(true)
  })

  test('已全部 ack 但尚未閒置滿 5 分鐘 → 不回收（門檻是保守下界，不是正確性依據）', () => {
    const dir = tmpDir()
    const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: 1000 })
    const filePath = join(dir, name)
    const mtimeMs = statSync(filePath).mtimeMs
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      { isPidAlive: () => false, now: () => mtimeMs + 60_000 }, // 只過了 1 分鐘
    )
    expect(result.reclaimed).not.toContain(name)
  })

  test('已終止、已全部 ack、且閒置超過 5 分鐘 → 回收，先刪資料檔再刪游標檔', () => {
    const dir = tmpDir()
    const name = makeAckedFile(dir, { writer: 'server', pid: 100, startEpochMs: 1000 })
    const filePath = join(dir, name)
    const mtimeMs = statSync(filePath).mtimeMs
    const result = reclaimSpoolFiles(
      dir,
      { writer: 'server', pid: 999 },
      { isPidAlive: () => false, now: () => mtimeMs + FIVE_MIN + 1 },
    )
    expect(result.reclaimed).toContain(name)
    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(`${filePath}.cursor`)).toBe(false)
  })

  test('孤兒游標檔（沒有對應資料檔）直接刪除', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'server.100.1000.jsonl.cursor'), JSON.stringify({ acked_bytes: 0, acked_seq: 0, failing: {}, updated_at: '' }))
    const result = reclaimSpoolFiles(dir, { writer: 'server', pid: 999 }, {})
    expect(result.reclaimed).toContain('server.100.1000.jsonl.cursor')
    expect(existsSync(join(dir, 'server.100.1000.jsonl.cursor'))).toBe(false)
  })

  test('目錄不存在 → 回傳空結果，不拋例外', () => {
    const result = reclaimSpoolFiles('/tmp/does-not-exist-spool-dir-xyz', { writer: 'server', pid: 1 }, {})
    expect(result).toEqual({ reclaimed: [], skipped: [] })
  })
})
