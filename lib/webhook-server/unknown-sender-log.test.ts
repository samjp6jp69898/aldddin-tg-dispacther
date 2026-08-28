import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logUnknownSender } from './unknown-sender-log.ts'

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('logUnknownSender', () => {
  test('私聊：附加一行 JSON，含 chat_id/first_name/last_name/username', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-unknown-sender-'))
    const logFile = join(dir, 'nested', 'unknown-senders.jsonl')
    logUnknownSender({ id: 111, type: 'private', first_name: '洋蔥', username: 'farus422' }, logFile)
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const row = JSON.parse(lines[0]!)
    expect(row.chat_id).toBe('111')
    expect(row.first_name).toBe('洋蔥')
    expect(row.username).toBe('farus422')
    expect(row.last_name).toBe('')
    expect(typeof row.ts).toBe('string')
  })

  test('非私聊（group）：不寫檔', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-unknown-sender-'))
    const logFile = join(dir, 'unknown-senders.jsonl')
    logUnknownSender({ id: -1009, type: 'group' }, logFile)
    expect(existsSync(logFile)).toBe(false)
  })

  test('連續呼叫：附加而非覆蓋', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-unknown-sender-'))
    const logFile = join(dir, 'unknown-senders.jsonl')
    logUnknownSender({ id: 1, type: 'private', first_name: 'A' }, logFile)
    logUnknownSender({ id: 2, type: 'private', first_name: 'B' }, logFile)
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
  })

  test('回傳值：同一 chat_id 第一次 true，之後都 false', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-unknown-sender-'))
    const logFile = join(dir, 'unknown-senders.jsonl')
    const first = logUnknownSender({ id: 42, type: 'private', first_name: 'A' }, logFile)
    const second = logUnknownSender({ id: 42, type: 'private', first_name: 'A（改了暱稱）' }, logFile)
    const third = logUnknownSender({ id: 42, type: 'private' }, logFile)
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(third).toBe(false)
  })

  test('回傳值：不同 chat_id 各自都算第一次', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-unknown-sender-'))
    const logFile = join(dir, 'unknown-senders.jsonl')
    expect(logUnknownSender({ id: 1, type: 'private' }, logFile)).toBe(true)
    expect(logUnknownSender({ id: 2, type: 'private' }, logFile)).toBe(true)
  })

  test('非私聊：回傳 false，不寫檔也不影響後續判斷', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-unknown-sender-'))
    const logFile = join(dir, 'unknown-senders.jsonl')
    expect(logUnknownSender({ id: 9, type: 'group' }, logFile)).toBe(false)
    expect(existsSync(logFile)).toBe(false)
  })
})
