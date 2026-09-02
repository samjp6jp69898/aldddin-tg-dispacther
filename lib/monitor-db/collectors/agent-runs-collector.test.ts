import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import type { MonitorDbExecutor, UpsertAgentRunInput } from '../writes.ts'
import {
  RESOLVE_BY_STDOUT_PATH_SQL,
  RESOLVE_BY_TICKET_SQL,
  createAgentRunsCollector,
  fileTsToIso,
  parseClaudeEvents,
  startAgentRunsCollector,
  summarizeEvents,
} from './agent-runs-collector.ts'

// 假 executor：只認本模組匯出的兩條 SELECT 常數（參照相等比較，比照
// test-support/fake-runs-db.ts 的作法），並記錄呼叫序列供斷言。
class FakeLookupDb implements MonitorDbExecutor {
  calls: Array<{ sql: string; params: unknown[] }> = []
  constructor(
    private byTicket: Record<string, Array<{ run_id: string }>> = {},
    private byStdout: Record<string, Array<{ run_id: string; lifecycle_rank: number }>> = {},
    private throwOn?: string,
  ) {}

  async execute<T = RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    this.calls.push({ sql, params })
    if (this.throwOn && sql === this.throwOn) throw new Error('DB 不可達（測試注入）')
    if (sql === RESOLVE_BY_TICKET_SQL) return [(this.byTicket[String(params[1])] ?? []) as unknown as T, []]
    if (sql === RESOLVE_BY_STDOUT_PATH_SQL) return [(this.byStdout[String(params[1])] ?? []) as unknown as T, []]
    throw new Error(`FakeLookupDb: 未預期的 SQL：${sql}`)
  }
}

function tmpRoot(): { traceDir: string; logDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-runs-collector-'))
  const traceDir = join(root, 'agent-traces')
  const logDir = join(root, 'logs')
  mkdirSync(traceDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  return { traceDir, logDir }
}

function writeTrace(traceDir: string, ticket: string, name: string, body: Record<string, unknown>): string {
  const dir = join(traceDir, ticket)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body), 'utf8')
  return path
}

function collectorWithSink(deps: { executor: MonitorDbExecutor | null; traceDir: string; logDir: string }) {
  const writes: UpsertAgentRunInput[] = []
  const collector = createAgentRunsCollector({
    getExecutor: async () => deps.executor,
    writeAgentRun: async input => {
      writes.push(input)
    },
    traceDir: deps.traceDir,
    dispatcherLogDir: deps.logDir,
    host: 'head',
  })
  return { collector, writes }
}

const RESULT_EVENTS = [
  { type: 'system', subtype: 'init', model: 'claude-sonnet' },
  { type: 'assistant', message: { model: 'claude-sonnet', content: [{ type: 'tool_use' }, { type: 'text' }] } },
  {
    type: 'result',
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 },
    total_cost_usd: 1.25,
    num_turns: 3,
    is_error: false,
    result: 'done ok',
  },
]

describe('summarizeEvents / parseClaudeEvents（移植自 sqlite collector 的解析語意）', () => {
  test('result 事件的 usage / cost / turns / tool_use 計數逐項對齊', () => {
    const s = summarizeEvents(RESULT_EVENTS)
    expect(s).toMatchObject({
      model: 'claude-sonnet',
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreateTokens: 44,
      costUsd: 1.25,
      numTurns: 3,
      toolCalls: 1,
      isError: false,
      resultPreview: 'done ok',
    })
  })

  test('雙格式：整檔 JSON 陣列與 JSONL 都解析得出，壞行跳過', () => {
    expect(parseClaudeEvents(JSON.stringify(RESULT_EVENTS))).toHaveLength(3)
    const jsonl = `${RESULT_EVENTS.map(e => JSON.stringify(e)).join('\n')}\n{"broken":`
    expect(parseClaudeEvents(jsonl)).toHaveLength(3)
    expect(parseClaudeEvents('   ')).toBeNull()
  })

  test('fileTsToIso 還原檔名時戳', () => {
    expect(fileTsToIso('2026-08-21T01-23-16-901Z')).toBe('2026-08-21T01:23:16.901Z')
  })
})

describe('agent trace collector（migration-003 §4：未終態只寫骨架、終態才帶 payload）', () => {
  test('未終態（endedAt 缺、無 error）只寫骨架：payload 十欄與 finishedAt 全部不帶', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-1', '2026-09-01T00-00-00-000Z-spec-gate.json', {
      ticket: 'FAQ-1',
      stage: 'spec-gate',
      runId: 'run-1',
      startedAt: '2026-09-01T00:00:00.000Z',
      events: RESULT_EVENTS, // 就算檔內已有 events，未終態也不得寫進 payload
    })
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.tracesWritten).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      runId: 'run-1',
      path: join(traceDir, 'FAQ-1', '2026-09-01T00-00-00-000Z-spec-gate.json'),
      agentName: 'spec-gate',
      startedAt: '2026-09-01T00:00:00.000Z',
    })
    // 形狀 A 是 first-write-wins：未終態帶了 payload 就再也補不上真值，
    // 所以這裡逐一斷言「這些 key 完全不存在」，不是「值為 null」。
    for (const k of ['finishedAt', 'model', 'inputTokens', 'outputTokens', 'costUsd', 'numTurns', 'toolCalls', 'isError', 'resultPreview']) {
      expect(Object.hasOwn(writes[0] as object, k)).toBe(false)
    }
  })

  test('終態（endedAt 已知）帶全 payload', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-2', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-2',
      stage: 'classify',
      runId: 'run-2',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:05:00.000Z',
      events: RESULT_EVENTS,
    })
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    await collector.runOnce()

    expect(writes[0]).toMatchObject({
      runId: 'run-2',
      agentName: 'classify',
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:05:00.000Z',
      model: 'claude-sonnet',
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreateTokens: 44,
      costUsd: 1.25,
      numTurns: 3,
      toolCalls: 1,
      isError: false,
      resultPreview: 'done ok',
    })
  })

  test('error 欄存在也算終態：is_error=1、result_preview 取 error.message', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-3', '2026-09-01T00-00-00-000Z-repo-scope.json', {
      ticket: 'FAQ-3',
      stage: 'repo-scope',
      runId: 'run-3',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: null,
      error: { message: 'Command failed: timeout' },
    })
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    await collector.runOnce()

    expect(writes[0]).toMatchObject({ runId: 'run-3', isError: true, resultPreview: 'Command failed: timeout' })
  })

  test('舊檔無 runId：(host, ticket) 恰好一列才採用', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-4', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-4',
      stage: 'classify',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: RESULT_EVENTS,
    })
    const db = new FakeLookupDb({ 'FAQ-4': [{ run_id: 'run-4' }] })
    const { collector, writes } = collectorWithSink({ executor: db, traceDir, logDir })

    await collector.runOnce()

    expect(db.calls[0]).toMatchObject({ sql: RESOLVE_BY_TICKET_SQL, params: ['head', 'FAQ-4'] })
    expect(writes[0]).toMatchObject({ runId: 'run-4' })
  })

  test('舊檔無 runId 且對不到（0 列）→ skip + 計數，完全不寫', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-5', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-5',
      stage: 'classify',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: RESULT_EVENTS,
    })
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.tracesSkippedUnresolved).toBe(1)
    expect(stats.tracesWritten).toBe(0)
    expect(writes).toHaveLength(0)
  })

  test('舊檔無 runId 且對到 ≥2 列（歧義）→ 一樣 skip，不猜', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-6', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-6',
      stage: 'classify',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: RESULT_EVENTS,
    })
    const db = new FakeLookupDb({ 'FAQ-6': [{ run_id: 'a' }, { run_id: 'b' }] })
    const { collector, writes } = collectorWithSink({ executor: db, traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.tracesSkippedUnresolved).toBe(1)
    expect(writes).toHaveLength(0)
  })

  test('對位 SELECT 拋例外（DB 不可達）→ 本輪 skip、計 lookupErrors、不落 spool（不呼叫 writeAgentRun）', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-7', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-7',
      stage: 'classify',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: RESULT_EVENTS,
    })
    const db = new FakeLookupDb({}, {}, RESOLVE_BY_TICKET_SQL)
    const { collector, writes } = collectorWithSink({ executor: db, traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.lookupErrors).toBe(1)
    expect(writes).toHaveLength(0)
  })

  test('mtime 未變 → 第二輪不重寫；終態寫過之後永遠跳過', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-8', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-8',
      stage: 'classify',
      runId: 'run-8',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: RESULT_EVENTS,
    })
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    await collector.runOnce()
    await collector.runOnce()

    expect(writes).toHaveLength(1)
  })

  test('未終態的檔案後來補上 endedAt（mtime 變）→ 第二輪補寫終態', async () => {
    const { traceDir, logDir } = tmpRoot()
    const name = '2026-09-01T00-00-00-000Z-classify.json'
    const path = writeTrace(traceDir, 'FAQ-9', name, {
      ticket: 'FAQ-9',
      stage: 'classify',
      runId: 'run-9',
      startedAt: '2026-09-01T00:00:00.000Z',
    })
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })
    await collector.runOnce()

    writeTrace(traceDir, 'FAQ-9', name, {
      ticket: 'FAQ-9',
      stage: 'classify',
      runId: 'run-9',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:02:00.000Z',
      events: RESULT_EVENTS,
    })
    // 顯式把 mtime 往前推一秒，不靠等待時間（CLAUDE.md 硬規則）。
    const future = new Date(Date.now() + 1000)
    utimesSync(path, future, future)

    await collector.runOnce()

    expect(writes).toHaveLength(2)
    expect(Object.hasOwn(writes[0] as object, 'finishedAt')).toBe(false)
    expect(writes[1]).toMatchObject({ finishedAt: '2026-09-01T00:02:00.000Z', costUsd: 1.25 })
  })

  test('壞 JSON（讀到寫一半）→ 不推進游標，下一輪修好後仍會寫入', async () => {
    const { traceDir, logDir } = tmpRoot()
    const dir = join(traceDir, 'FAQ-10')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '2026-09-01T00-00-00-000Z-classify.json')
    writeFileSync(path, '{"ticket":"FAQ-10","stage":"cla', 'utf8')
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    const first = await collector.runOnce()
    expect(first.tracesSkippedUnreadable).toBe(1)
    expect(writes).toHaveLength(0)

    writeTrace(traceDir, 'FAQ-10', '2026-09-01T00-00-00-000Z-classify.json', {
      ticket: 'FAQ-10',
      stage: 'classify',
      runId: 'run-10',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:01:00.000Z',
      events: RESULT_EVENTS,
    })
    await collector.runOnce()
    expect(writes).toHaveLength(1)
  })
})

describe('bug pipeline stdout collector（單一 stage create-mr）', () => {
  const STDOUT_NAME = 'FAQ-100.2026-08-21T01-23-16-901Z.stdout.log'

  test('runs 仍在跑（lifecycle_rank=30）→ 只寫骨架、finishedAt 不帶', async () => {
    const { traceDir, logDir } = tmpRoot()
    const path = join(logDir, STDOUT_NAME)
    writeFileSync(path, JSON.stringify(RESULT_EVENTS), 'utf8')
    const db = new FakeLookupDb({}, { [path]: [{ run_id: 'run-100', lifecycle_rank: 30 }] })
    const { collector, writes } = collectorWithSink({ executor: db, traceDir, logDir })

    await collector.runOnce()

    expect(db.calls[0]).toMatchObject({ sql: RESOLVE_BY_STDOUT_PATH_SQL, params: ['head', path] })
    expect(writes[0]).toEqual({
      runId: 'run-100',
      path,
      agentName: 'create-mr',
      startedAt: '2026-08-21T01:23:16.901Z',
    })
  })

  test('runs 已終態（lifecycle_rank=100）→ 解析 stdout、帶全 payload', async () => {
    const { traceDir, logDir } = tmpRoot()
    const path = join(logDir, STDOUT_NAME)
    writeFileSync(path, RESULT_EVENTS.map(e => JSON.stringify(e)).join('\n'), 'utf8')
    const db = new FakeLookupDb({}, { [path]: [{ run_id: 'run-100', lifecycle_rank: 100 }] })
    const { collector, writes } = collectorWithSink({ executor: db, traceDir, logDir })

    await collector.runOnce()

    expect(writes[0]).toMatchObject({
      runId: 'run-100',
      agentName: 'create-mr',
      startedAt: '2026-08-21T01:23:16.901Z',
      inputTokens: 11,
      costUsd: 1.25,
      toolCalls: 1,
    })
    expect(typeof (writes[0] as { finishedAt?: string }).finishedAt).toBe('string')
  })

  test('檔案 mtime 沒變、但 runs 由 running 轉終態 → 第二輪仍補寫終態（FAQ-4743 型空窗）', async () => {
    const { traceDir, logDir } = tmpRoot()
    const path = join(logDir, STDOUT_NAME)
    writeFileSync(path, JSON.stringify(RESULT_EVENTS), 'utf8')
    const rows: Record<string, Array<{ run_id: string; lifecycle_rank: number }>> = {
      [path]: [{ run_id: 'run-100', lifecycle_rank: 30 }],
    }
    const db = new FakeLookupDb({}, rows)
    const { collector, writes } = collectorWithSink({ executor: db, traceDir, logDir })

    await collector.runOnce()
    rows[path] = [{ run_id: 'run-100', lifecycle_rank: 100 }]
    await collector.runOnce()

    expect(writes).toHaveLength(2)
    expect(Object.hasOwn(writes[0] as object, 'finishedAt')).toBe(false)
    expect(writes[1]).toMatchObject({ costUsd: 1.25 })
  })

  test('(host, stdout_path) 對不到 → skip + 計數，不猜', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeFileSync(join(logDir, STDOUT_NAME), JSON.stringify(RESULT_EVENTS), 'utf8')
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.stdoutSkippedUnresolved).toBe(1)
    expect(writes).toHaveLength(0)
  })

  test('demand pipeline 的 stdout 與其他 .log 一律不收', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeFileSync(join(logDir, 'FAQ-101.2026-08-21T01-23-16-901Z.demand-pipeline.stdout.log'), '[]', 'utf8')
    writeFileSync(join(logDir, 'demand-pipeline.log'), 'x', 'utf8')
    writeFileSync(join(logDir, 'FAQ-101.2026-08-21T01-23-16-901Z.stderr.log'), 'x', 'utf8')
    const { collector, writes } = collectorWithSink({ executor: new FakeLookupDb(), traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.stdoutSeen).toBe(0)
    expect(writes).toHaveLength(0)
  })
})

describe('整輪跳過與 flag 閘門', () => {
  test('executor 為 null（pool 不可用）→ 整輪跳過，不讀檔、不寫入', async () => {
    const { traceDir, logDir } = tmpRoot()
    writeTrace(traceDir, 'FAQ-11', '2026-09-01T00-00-00-000Z-classify.json', { ticket: 'FAQ-11', runId: 'r' })
    const { collector, writes } = collectorWithSink({ executor: null, traceDir, logDir })

    const stats = await collector.runOnce()

    expect(stats.skippedNoExecutor).toBe(true)
    expect(stats.tracesSeen).toBe(0)
    expect(writes).toHaveLength(0)
  })

  test('MON_DB_ENABLED 未設 → startAgentRunsCollector 完全不啟動（不建 timer、不取 pool）', () => {
    const prev = process.env.MON_DB_ENABLED
    delete process.env.MON_DB_ENABLED
    let poolAsked = 0
    try {
      const handle = startAgentRunsCollector(
        {
          getExecutor: async () => {
            poolAsked++
            return null
          },
          writeAgentRun: async () => {},
        },
        1,
      )
      handle.stop()
      expect(poolAsked).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.MON_DB_ENABLED
      else process.env.MON_DB_ENABLED = prev
    }
  })
})
