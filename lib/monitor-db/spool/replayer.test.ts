import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpoolEntry } from './types.ts'
import { createSpoolWriter } from './writer.ts'
import { drainAll, readCursor, replayOnce } from './replayer.ts'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spool-replayer-test-'))
}

function fakeDeps(overrides: {
  reachable?: boolean
  apply?: (e: SpoolEntry) => Promise<{ ok: boolean; reason?: string }>
} = {}) {
  const applied: SpoolEntry[] = []
  const apply =
    overrides.apply ??
    (async (e: SpoolEntry) => {
      applied.push(e)
      return { ok: true }
    })
  return {
    applied,
    deps: {
      isDbReachable: async () => overrides.reachable ?? true,
      applyEntry: apply,
    },
  }
}

describe('replayOnce', () => {
  test('DB 不可達 → 整輪跳過，不動游標、不記 attempts（§6.5(g)）', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.append({ ts: 't', host: 'h', run_id: 'r1', fn: 'f', args: [] })
    w.close()
    const { deps } = fakeDeps({ reachable: false })
    const summary = await replayOnce(dir, deps)
    expect(summary.skipped).toBe(true)
    expect(summary.reason).toBe('db_unreachable')
    expect(existsSync(`${w.filePath()}.cursor`)).toBe(false)
  })

  test('失敗未達 5 次 → 卡住不推進，後面的條目本輪不重放（保序但非正確性依據）', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'willFail', args: [] })
    w.append({ ts: 't2', host: 'h', run_id: 'r2', fn: 'ok', args: [] })
    w.close()
    const seen: string[] = []
    const deps = {
      isDbReachable: async () => true,
      applyEntry: async (e: SpoolEntry) => {
        seen.push(e.fn)
        return e.fn === 'willFail' ? { ok: false, reason: 'boom' } : { ok: true }
      },
    }
    const summary = await replayOnce(dir, deps)
    expect(seen).toEqual(['willFail']) // 沒往下試 r2
    expect(summary.files[0]!.blocked).toBe(true)
    const cursor = readCursor(`${w.filePath()}.cursor`)
    expect(cursor.failing['1']).toBe(1)
    expect(cursor.acked_bytes).toBe(0)
  })

  test('連續失敗滿 5 次 → 移入 dead-letter 並跳過，不再擋住後面條目（§6.5(g)）', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'willFail', args: [] })
    w.append({ ts: 't2', host: 'h', run_id: 'r2', fn: 'ok', args: [] })
    w.close()
    const deps = {
      isDbReachable: async () => true,
      applyEntry: async (e: SpoolEntry) => (e.fn === 'willFail' ? { ok: false, reason: 'boom' } : { ok: true }),
    }
    for (let i = 0; i < 5; i++) await replayOnce(dir, deps)

    const dataFilePath = w.filePath()
    const deadPath = dataFilePath.replace(/\.jsonl$/, '.dead.jsonl')
    expect(existsSync(deadPath)).toBe(true)
    const deadLines = readFileSync(deadPath, 'utf8').trim().split('\n')
    expect(deadLines).toHaveLength(1)
    expect(JSON.parse(deadLines[0]!).run_id).toBe('r1')

    // 死信之後,原本被擋住的 r2 應該已被放行重放;再跑一輪不該有任何進展了
    const summary = await replayOnce(dir, deps)
    expect(summary.files[0]!.replayed).toBe(0)
    expect(summary.files[0]!.deadLettered).toBe(0)
  })

  test('failing 計數只在「DB 可達但這條目失敗」時累加,不會因為連續幾輪 DB 不可達而誤增', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'willFail', args: [] })
    w.close()
    let reachable = true
    const deps = {
      isDbReachable: async () => reachable,
      applyEntry: async () => ({ ok: false, reason: 'boom' }),
    }
    await replayOnce(dir, deps) // attempts = 1
    reachable = false
    await replayOnce(dir, deps) // 跳過整輪
    await replayOnce(dir, deps) // 跳過整輪
    reachable = true
    const cursor = readCursor(`${w.filePath()}.cursor`)
    expect(cursor.failing['1']).toBe(1) // 不可達的兩輪沒有把 attempts 推到 3
  })
})

describe('drainAll', () => {
  test('全部成功 → 依序重放且不重複，drainAll 後游標推進到檔尾（Phase 1.4 測試 1 的核心機制）', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    for (let i = 0; i < 5; i++) w.append({ ts: `t${i}`, host: 'h', run_id: `r${i}`, fn: 'f', args: [i] })
    w.close()
    const { applied, deps } = fakeDeps()
    await drainAll(dir, deps)
    expect(applied).toHaveLength(5)
    expect(applied.map(e => e.run_id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])

    // 再跑一輪不應該重放任何條目(游標已到檔尾)
    const again = await replayOnce(dir, deps)
    expect(again.files[0]!.replayed).toBe(0)
  })

  test('DB 不可達時 drainAll 不會無窮迴圈，立刻回傳', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'f', args: [] })
    w.close()
    const { deps } = fakeDeps({ reachable: false })
    const rounds = await drainAll(dir, deps)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.skipped).toBe(true)
  })

  test('【Phase 1.4 測試 2】重放者重啟後從游標續讀:不重讀已 ack、不漏未 ack。' +
    '重放者本身無狀態(每次都從磁碟重讀游標),所以「被 SIGKILL 後重啟」等價於' +
    '「換一份全新的記憶體(全新 deps/全新呼叫)但磁碟上的游標檔還在」——這正是' +
    '這裡驗證的情境,不需要真的送 SIGKILL 給一個 OS 行程。', async () => {
    const dir = tmpDir()
    const w1 = createSpoolWriter({ writer: 'cli', dir, pid: 111, startEpochMs: 1000 })
    w1.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'f', args: [] })
    w1.close()

    const { applied: firstApplied, deps: deps1 } = fakeDeps()
    await drainAll(dir, deps1)
    expect(firstApplied.map(e => e.run_id)).toEqual(['r1'])

    // 「重啟」:全新的 deps(全新記憶體),游標只能來自磁碟。
    const w2 = createSpoolWriter({ writer: 'cli', dir, pid: 222, startEpochMs: 2000 })
    w2.append({ ts: 't2', host: 'h', run_id: 'r2', fn: 'f', args: [] })
    w2.close()

    const { applied: secondApplied, deps: deps2 } = fakeDeps()
    await drainAll(dir, deps2)
    // r1 不重複重放(游標已在磁碟上記住);r2 要被放行
    expect(secondApplied.map(e => e.run_id)).toEqual(['r2'])
  })

  test('【Phase 1.4 測試 1】並行不丟失:兩個一次性 writer 行程各 append 200 條，同時重放者在跑 → 全部 400 條恰好被重放一次，零遺失。' +
    '判定完成用「writer 行程 exit code + 重放者顯式 drainAll()」，不用 sleep。', async () => {
    const dir = tmpDir()
    const fixture = join(import.meta.dir, '__fixtures__', 'append-writer-cli.ts')

    const proc1 = Bun.spawn(['bun', fixture, dir, 'cli', '200', 'w1'])
    const proc2 = Bun.spawn(['bun', fixture, dir, 'post-run-notify', '200', 'w2'])
    const [code1, code2] = await Promise.all([proc1.exited, proc2.exited])
    expect(code1).toBe(0)
    expect(code2).toBe(0)

    const { applied, deps } = fakeDeps()
    await drainAll(dir, deps)

    expect(applied).toHaveLength(400)
    const runIds = applied.map(e => e.run_id)
    expect(new Set(runIds).size).toBe(400) // 零重複
    const expected = new Set<string>()
    for (let i = 0; i < 200; i++) {
      expected.add(`w1-${i}`)
      expected.add(`w2-${i}`)
    }
    expect(new Set(runIds)).toEqual(expected) // 零遺失

    // 再跑一輪應該完全沒有進展(全部已 ack)
    const again = await replayOnce(dir, deps)
    expect(again.files.every(f => f.replayed === 0 && f.deadLettered === 0)).toBe(true)
  }, 20_000)
})

// 2026-09-02 指揮官裁定（per-fn run_id）的重放端配套確認：`run_id: null` 的
// 條目（file_offsets / mcp_usage / *_log 等結構上沒有 run_id 的表）必須被
// 重放端正常消化——replayer.ts 與 apply-entry.ts 都不看 run_id，這條測試把
// 「不看」這件事釘成可證偽的事實（tg-monitor 側會 append 這種條目）。
describe('run_id: null 的條目（per-fn 硬規則放行的非 run 類寫入）', () => {
  test('重放端照常消化，不拒收、不進 dead-letter', async () => {
    const dir = tmpDir()
    const w = createSpoolWriter({ writer: 'tg-monitor', dir })
    w.append({ ts: 't1', host: 'h', run_id: null, fn: 'insertStatusLogRow', args: [['service_status_log', ['service'], ['x']]] })
    w.append({ ts: 't2', host: 'h', run_id: null, fn: 'upsertFileOffset', args: [{ path: '/p', inode: 1, offset: 2, eventSeq: 3 }] })
    w.close()

    const { applied, deps } = fakeDeps()
    const summary = await replayOnce(dir, deps)

    expect(applied.map(e => e.fn)).toEqual(['insertStatusLogRow', 'upsertFileOffset'])
    expect(applied.every(e => e.run_id === null)).toBe(true)
    expect(summary.files.every(f => f.deadLettered === 0)).toBe(true)
  })
})
