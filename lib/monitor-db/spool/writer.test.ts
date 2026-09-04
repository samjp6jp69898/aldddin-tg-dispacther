import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSpoolFileName } from './types.ts'
import { createSpoolWriter } from './writer.ts'

function tmpSpoolDir(): string {
  return mkdtempSync(join(tmpdir(), 'spool-writer-test-'))
}

describe('createSpoolWriter', () => {
  test('檔名符合 <writer>.<pid>.<startEpochMs>.jsonl，mode 0600', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir, pid: 12345, startEpochMs: 1000 })
    w.append({ ts: new Date().toISOString(), host: 'h', run_id: 'r1', fn: 'f', args: [] })
    const path = w.filePath()
    expect(parseSpoolFileName(path.split('/').pop()!)).toEqual({ writer: 'cli', pid: 12345, startEpochMs: 1000 })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    w.close()
  })

  test('append 是純 append-only：逐條寫入，檔案內容依序累積，每行皆為合法 JSON 且 seq 遞增', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'f1', args: [1] })
    w.append({ ts: 't2', host: 'h', run_id: 'r2', fn: 'f2', args: [2] })
    w.close()
    const lines = readFileSync(w.filePath(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const parsed = lines.map(l => JSON.parse(l))
    expect(parsed[0]).toMatchObject({ seq: 1, run_id: 'r1', fn: 'f1' })
    expect(parsed[1]).toMatchObject({ seq: 2, run_id: 'r2', fn: 'f2' })
  })

  test('appendBatch 一次寫入多條，seq 遞增，且只需一次 fsync（行為上以「單一 write 呼叫的結果全部落地」驗證）', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.appendBatch([
      { ts: 't1', host: 'h', run_id: 'r1', fn: 'f', args: [] },
      { ts: 't2', host: 'h', run_id: 'r2', fn: 'f', args: [] },
      { ts: 't3', host: 'h', run_id: 'r3', fn: 'f', args: [] },
    ])
    w.close()
    const lines = readFileSync(w.filePath(), 'utf8').trim().split('\n')
    expect(lines.map(l => JSON.parse(l).seq)).toEqual([1, 2, 3])
  })

  // 【G:MJ-G2】硬規則的 per-fn 適用範圍（2026-09-02 指揮官裁定）：
  // runs/agent_runs 類的 fn 仍必須帶非空 run_id；其餘表（結構上沒有 run_id）
  // 允許 null。兩個方向各有結構性測試，缺一不可。
  test('runs 類 fn（writeRunProgress）run_id 為空 → 拒絕寫入並丟例外（run_id 不得留給重放時再解析）', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    expect(() => w.append({ ts: 't1', host: 'h', run_id: '', fn: 'writeRunProgress', args: [] })).toThrow()
    expect(() => w.append({ ts: 't1', host: 'h', run_id: null, fn: 'upsertAgentRun', args: [] })).toThrow()
    w.close()
    expect(readFileSync(w.filePath(), 'utf8')).toBe('')
  })

  test('非 run 類 fn（file_offsets / mcp_usage / 心跳 / *_log / unknown_senders）run_id=null → 照常收下', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    for (const fn of ['upsertFileOffset', 'insertMcpUsage', 'upsertMonitorHeartbeat', 'insertStatusLogRow', 'insertTgUnknownSender']) {
      w.append({ ts: 't1', host: 'h', run_id: null, fn, args: [{}] })
    }
    w.close()
    const lines = readFileSync(w.filePath(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(5)
    expect(lines.map(l => JSON.parse(l).run_id)).toEqual([null, null, null, null, null])
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1, fn: 'upsertFileOffset' })
  })

  test('appendBatch 中任一條 runs 類 fn 的 run_id 為空 → 整批拒絕，不留下部分寫入（檔案應維持空）', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir })
    expect(() =>
      w.appendBatch([
        { ts: 't1', host: 'h', run_id: 'r1', fn: 'writeRunProgress', args: [] },
        { ts: 't2', host: 'h', run_id: '', fn: 'writeRunProgress', args: [] },
      ]),
    ).toThrow()
    w.close()
    expect(readFileSync(w.filePath(), 'utf8')).toBe('')
  })

  test('單檔超過門檻即輪替：寫入者自己開新檔，檔名帶新的 startEpochMs（§6.5(f)）', () => {
    const dir = tmpSpoolDir()
    const w = createSpoolWriter({ writer: 'cli', dir, pid: 1, startEpochMs: 1000, maxFileBytes: 10 })
    const firstPath = w.filePath()
    w.append({ ts: 't1', host: 'h', run_id: 'r1', fn: 'f', args: [] }) // 寫完後檔案必超過 10 bytes
    w.append({ ts: 't2', host: 'h', run_id: 'r2', fn: 'f', args: [] }) // 觸發輪替
    const secondPath = w.filePath()
    expect(secondPath).not.toBe(firstPath)
    expect(parseSpoolFileName(secondPath.split('/').pop()!)?.writer).toBe('cli')
    w.close()
  })

  test('目錄以 0700 建立', () => {
    const parent = mkdtempSync(join(tmpdir(), 'spool-writer-dirtest-'))
    const dir = join(parent, 'spool')
    const w = createSpoolWriter({ writer: 'cli', dir })
    w.close()
    const mode = statSync(dir).mode & 0o777
    expect(mode).toBe(0o700)
  })
})
