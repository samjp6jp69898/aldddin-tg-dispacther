import { describe, expect, test } from 'bun:test'
import { parseLogFilename } from './filename-parse.ts'

describe('parseLogFilename', () => {
  test('demand pipeline stdout/stderr → kind=demand，ticket 解出', () => {
    expect(parseLogFilename('ALDREQ-765.2026-08-21T01-20-14-935Z.demand-pipeline.stdout.log')).toEqual({
      ticket: 'ALDREQ-765',
      kind: 'demand',
    })
    expect(parseLogFilename('ALDREQ-765.2026-08-21T01-20-14-935Z.demand-pipeline.stderr.log')).toEqual({
      ticket: 'ALDREQ-765',
      kind: 'demand',
    })
  })

  test('bug pipeline stdout/stderr → kind=bug，ticket 解出', () => {
    expect(parseLogFilename('FAQ-4809.2026-09-01T09-16-23-526Z.stdout.log')).toEqual({ ticket: 'FAQ-4809', kind: 'bug' })
    expect(parseLogFilename('FAQ-4809.2026-09-01T09-16-23-526Z.stderr.log')).toEqual({ ticket: 'FAQ-4809', kind: 'bug' })
  })

  test('雜項 .log（bootstrap.log 等）與非本格式一律回傳 null/null', () => {
    expect(parseLogFilename('FAQ-4809.bootstrap.log')).toEqual({ ticket: null, kind: null })
    expect(parseLogFilename('demand-pipeline.log')).toEqual({ ticket: null, kind: null })
    expect(parseLogFilename('cleanup-worktree.log')).toEqual({ ticket: null, kind: null })
    expect(parseLogFilename('health-monitor.log')).toEqual({ ticket: null, kind: null })
  })

  test('audit jsonl 不符合本格式，回傳 null/null', () => {
    expect(parseLogFilename('audit-2026-09-01.jsonl')).toEqual({ ticket: null, kind: null })
  })
})
