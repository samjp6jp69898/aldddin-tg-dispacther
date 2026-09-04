import { describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isAllowedTracePath, readLocalTraceFile } from './local-trace-read.ts'

const AGENT_TRACE_DIR = '/Users/user/aladdin/telegram-dispatcher/logs/agent-traces'
const DISPATCHER_LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'

describe('isAllowedTracePath — 白名單逐字比照 tg-monitor/lib/services.ts isAllowedTracePath', () => {
  test('agent-traces 目錄下的 .json 放行', () => {
    expect(isAllowedTracePath(`${AGENT_TRACE_DIR}/FAQ-1/2026-09-04T00-00-00-000Z-tracer.json`)).toBe(true)
  })

  test('logs 目錄下的 .stdout.log 放行', () => {
    expect(isAllowedTracePath(`${DISPATCHER_LOG_DIR}/FAQ-1.2026-09-04T00-00-00-000Z.stdout.log`)).toBe(true)
  })

  test('logs 目錄下的 .stderr.log 放行（task 1，2026-09-04：/api/log/tail、/api/log/since host-aware 化新增）', () => {
    expect(isAllowedTracePath(`${DISPATCHER_LOG_DIR}/FAQ-1.2026-09-04T00-00-00-000Z.stderr.log`)).toBe(true)
  })

  test('.. 一律拒絕（path traversal）', () => {
    expect(isAllowedTracePath(`${AGENT_TRACE_DIR}/../../etc/passwd`)).toBe(false)
  })

  test('agent-traces 目錄下非 .json 拒絕', () => {
    expect(isAllowedTracePath(`${AGENT_TRACE_DIR}/FAQ-1/x.txt`)).toBe(false)
  })

  test('logs 目錄下非 .stdout.log 拒絕（例如 spawn-errors.log）', () => {
    expect(isAllowedTracePath(`${DISPATCHER_LOG_DIR}/spawn-errors.log`)).toBe(false)
  })

  test('白名單目錄以外一律拒絕', () => {
    expect(isAllowedTracePath('/etc/passwd')).toBe(false)
    expect(isAllowedTracePath('/Users/user/aladdin/obsidian/Debug/FAQ-1/FAQ-1-analytics.md')).toBe(false)
  })
})

describe('readLocalTraceFile', () => {
  test('白名單外路徑 → not_allowed', () => {
    expect(readLocalTraceFile('/etc/passwd')).toEqual({ ok: false, reason: 'not_allowed' })
  })

  test('白名單內但檔案不存在 → missing', () => {
    expect(readLocalTraceFile(`${AGENT_TRACE_DIR}/FAQ-999999/no-such-file.json`)).toEqual({ ok: false, reason: 'missing' })
  })

  test('白名單內且檔案存在 → 回傳內容', () => {
    // 白名單是絕對路徑字面前綴比對，借用系統 tmp 目錄偽裝不可行——改成真的
    // 在 AGENT_TRACE_DIR 底下建一個測試專用子目錄，測完立刻清掉。
    const ticketDir = join(AGENT_TRACE_DIR, '__unit-test-local-trace-read__')
    mkdirSync(ticketDir, { recursive: true })
    const file = join(ticketDir, 'x.json')
    writeFileSync(file, '{"a":1}')
    try {
      expect(readLocalTraceFile(file)).toEqual({ ok: true, content: '{"a":1}' })
    } finally {
      rmSync(ticketDir, { recursive: true, force: true })
    }
  })
})
