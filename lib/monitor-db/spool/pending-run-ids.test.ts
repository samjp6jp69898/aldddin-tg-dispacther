import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPendingSpoolRunIds } from './pending-run-ids.ts'

// 2026-09-09（ALDREQ-812 事故回歸）：sweeper 的 hasPendingSpoolEntry 保護一直
// 是死碼（server.ts／worker-agent.ts 都沒接線），本檔驗證的是「接線後真正用
// 的那個掃描函式」本身行為正確——run_id 出現在未 ack 區就該被找到，已經 ack
// 過的、或半行（寫入者可能還沒寫完）都不該算。

const dirs: string[] = []

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pending-run-ids-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function entry(runId: string | null, seq = 1): string {
  return `${JSON.stringify({ seq, ts: '2026-09-09T02:39:54.102Z', host: 'landon2', run_id: runId, fn: 'writeRunOutcomeAuthoritative', args: [{}] })}\n`
}

describe('readPendingSpoolRunIds', () => {
  test('目錄不存在 → 空集合，不拋例外', () => {
    expect(readPendingSpoolRunIds(join(tmpdir(), 'pending-run-ids-does-not-exist-xyz')).size).toBe(0)
  })

  test('沒有游標檔（等同 ALDREQ-812 案例：cli 短命行程從沒被重放過）→ 整檔視為未 ack，run_id 找得到', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'cli.65018.1788921593079.jsonl'), entry('3e554dfb-7b5d-40d1-82a7-202723719f93'))

    const pending = readPendingSpoolRunIds(dir)
    expect(pending.has('3e554dfb-7b5d-40d1-82a7-202723719f93')).toBe(true)
  })

  test('已經被游標 ack 過的條目 → 不算未 ack，不出現在結果裡', () => {
    const dir = tmpDir()
    const line = entry('acked-run-id')
    writeFileSync(join(dir, 'worker-agent.1.1000.jsonl'), line)
    writeFileSync(join(dir, 'worker-agent.1.1000.jsonl.cursor'), JSON.stringify({ acked_bytes: Buffer.byteLength(line), acked_seq: 1, failing: {}, updated_at: '2026-09-09T00:00:00.000Z' }))

    expect(readPendingSpoolRunIds(dir).has('acked-run-id')).toBe(false)
  })

  test('半行（最後一個換行之後、寫入者可能還在寫）→ 不算，不拋例外', () => {
    const dir = tmpDir()
    const full = entry('finished-run-id')
    writeFileSync(join(dir, 'server.1.1000.jsonl'), full + '{"seq":2,"ts":"2026-09-09T02:0')

    const pending = readPendingSpoolRunIds(dir)
    expect(pending.has('finished-run-id')).toBe(true)
    expect(pending.size).toBe(1) // 半行沒有貢獻任何 run_id
  })

  test('run_id 為 null 的條目（file_offsets/heartbeat 等無主表）→ 略過，不塞進集合', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'server.1.1000.jsonl'), entry(null))

    expect(readPendingSpoolRunIds(dir).size).toBe(0)
  })

  test('壞行（JSON 解析失敗）→ 跳過該行，不影響其餘行的判讀', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'server.1.1000.jsonl'), 'not json\n' + entry('good-run-id'))

    expect(readPendingSpoolRunIds(dir).has('good-run-id')).toBe(true)
  })

  test('游標值不可信（超出檔案大小）→ 保守地整檔視為未 ack', () => {
    const dir = tmpDir()
    const line = entry('run-id-x')
    writeFileSync(join(dir, 'server.1.1000.jsonl'), line)
    writeFileSync(join(dir, 'server.1.1000.jsonl.cursor'), JSON.stringify({ acked_bytes: 999_999, acked_seq: 1, failing: {}, updated_at: '2026-09-09T00:00:00.000Z' }))

    expect(readPendingSpoolRunIds(dir).has('run-id-x')).toBe(true)
  })

  test('多個資料檔各自有不同 run_id → 集合是全目錄的聯集', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'cli.1.1000.jsonl'), entry('run-a'))
    writeFileSync(join(dir, 'worker-agent.2.2000.jsonl'), entry('run-b'))

    const pending = readPendingSpoolRunIds(dir)
    expect(pending.has('run-a')).toBe(true)
    expect(pending.has('run-b')).toBe(true)
    expect(pending.size).toBe(2)
  })
})
