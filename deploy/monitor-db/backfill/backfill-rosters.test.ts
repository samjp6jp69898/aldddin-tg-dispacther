// backfill/backfill-rosters.test.ts — Phase 6 名冊回填單元測試。
//
// 2026-09-16：`tech-users.csv → tech_users` 的來源已從腳本整段移除（見
// backfill-rosters.ts 檔頭），對應的格式防呆／mapping／49 列規模三組測試
// 隨之刪除。
//
// 不需要 MySQL：mapping/加密路徑用假金鑰實跑 encryptField/blindIndex；DB 寫入
// 抽象成 RosterExecutor 注入假物件（見 backfill-rosters.ts 的 makePoolExecutor
// 對照組）。tokens 白名單一律用 fixture 覆寫（RunBackfillOptions.tokensFiles），
// 絕不在測試中讀取 aladdin_mcps 底下的真實 tokens*.json。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  deriveServerEnv,
  mapTokenRow,
  mapUnknownSenderRow,
  parseJsonlLine,
  readTokensFile,
  runBackfill,
  MCP_TOKEN_BIDX_SCOPE,
  type McpTokenDbRow,
  type RosterExecutor,
  type UnknownSenderDbRow,
} from './backfill-rosters.ts'
import { blindIndex } from '../../../lib/crypto/field-crypto.ts'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rosters')

const ORIG_FIELD_KEY = process.env.MON_FIELD_KEY_V1
const ORIG_BIDX_KEY = process.env.MON_BIDX_KEY

function freshKey(): string {
  return randomBytes(32).toString('base64')
}

beforeEach(() => {
  process.env.MON_FIELD_KEY_V1 = freshKey()
  process.env.MON_BIDX_KEY = freshKey()
})

afterEach(() => {
  if (ORIG_FIELD_KEY === undefined) delete process.env.MON_FIELD_KEY_V1
  else process.env.MON_FIELD_KEY_V1 = ORIG_FIELD_KEY
  if (ORIG_BIDX_KEY === undefined) delete process.env.MON_BIDX_KEY
  else process.env.MON_BIDX_KEY = ORIG_BIDX_KEY
})

// ---------- fake executor ----------

interface RecordedCall {
  table: 'mcp_tokens' | 'tg_unknown_senders'
  key: string
  row: McpTokenDbRow | UnknownSenderDbRow
}

function makeFakeExecutor(): { executor: RosterExecutor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const seen = new Set<string>()
  const executor: RosterExecutor = {
    insertMcpToken: async (row) => {
      const key = `mcp_tokens:${row.server}:${row.env}:${row.token_id}`
      calls.push({ table: 'mcp_tokens', key, row })
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
    insertUnknownSender: async (row) => {
      const key = `tg_unknown_senders:${row.chat_id_bidx.toString('hex')}:${row.ts}`
      calls.push({ table: 'tg_unknown_senders', key, row })
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  }
  return { executor, calls }
}

// ---------- mcp_tokens ----------

describe('tokens*.json → mcp_tokens', () => {
  test('deriveServerEnv：tokens.json → env=default', () => {
    const r = deriveServerEnv('/x/aladdin-admin/tokens.json')
    expect(r).toEqual({ server: 'aladdin-admin', env: 'default' })
  })

  test('deriveServerEnv：tokens.<env>.json → env=<env>', () => {
    const r = deriveServerEnv('/x/aladdin-platform/tokens.dev-6t.json')
    expect(r).toEqual({ server: 'aladdin-platform', env: 'dev-6t' })
  })

  test('readTokensFile：檔案不存在回傳 null', () => {
    expect(readTokensFile('/nonexistent/path/tokens.json')).toBeNull()
  })

  test('readTokensFile + mapTokenRow：token_enc 帶前綴、bidx 32 bytes、issued_at 原字串不經 Date 轉換', () => {
    const entries = readTokensFile(join(FIXTURES, 'tokens-fake.json'))!
    expect(entries.length).toBe(2)
    const rows = entries.map((e) => mapTokenRow('aladdin-admin', 'default', e))
    expect(rows[0]!.token_enc).toMatch(/^enc:v1:/)
    expect(rows[0]!.token_bidx.length).toBe(32)
    expect(rows[0]!.issued_at).toBe('2026-01-01T00:00:00.000Z') // 24 chars，byte-exact
    expect(rows[1]!.issued_at).toBe('2026-01-02') // 短字串，未被 pad/轉換
  })

  test('token_bidx scope 定案字串正確（與 MCP_TOKEN_BIDX_SCOPE 一致）', () => {
    const entries = readTokensFile(join(FIXTURES, 'tokens-fake.json'))!
    const row = mapTokenRow('aladdin-admin', 'default', entries[0]!)
    const expected = blindIndex(MCP_TOKEN_BIDX_SCOPE, entries[0]!.token)
    expect(row.token_bidx.equals(expected!)).toBe(true)
  })
})

// ---------- tg_unknown_senders ----------

describe('unknown-senders.jsonl → tg_unknown_senders', () => {
  test('parseJsonlLine：壞行回 null', () => {
    expect(parseJsonlLine('not-json-garbage-line')).toBeNull()
  })

  test('parseJsonlLine：合法 JSON 正常解析', () => {
    const r = parseJsonlLine('{"chat_id":"1","ts":"2026-01-01T00:00:00.000Z"}')
    expect(r).toEqual({ chat_id: '1', ts: '2026-01-01T00:00:00.000Z' })
  })

  test('mapUnknownSenderRow：缺 chat_id → null', () => {
    expect(mapUnknownSenderRow({ ts: '2026-01-01T00:00:00.000Z' })).toBeNull()
  })

  test('mapUnknownSenderRow：ts 格式不合法 → null', () => {
    expect(mapUnknownSenderRow({ chat_id: '1', ts: 'not-a-date' })).toBeNull()
  })

  test('mapUnknownSenderRow：first_name/last_name/username 三者皆缺 → sender_profile_enc NULL', () => {
    const row = mapUnknownSenderRow({ chat_id: '700000002', ts: '2026-08-02T00:00:00.000Z' })
    expect(row).not.toBeNull()
    expect(row!.sender_profile_enc).toBeNull()
    expect(row!.chat_id_enc).toMatch(/^enc:v1:/)
    expect(row!.chat_id_bidx.length).toBe(32)
  })

  test('mapUnknownSenderRow：有 profile 欄位 → sender_profile_enc 帶前綴', () => {
    const row = mapUnknownSenderRow({
      chat_id: '700000001',
      first_name: 'Fake',
      last_name: 'One',
      username: 'fakeone',
      ts: '2026-08-01T00:00:00.000Z',
    })
    expect(row!.sender_profile_enc).toMatch(/^enc:v1:/)
  })

  test('全 fixture 檔跑 runBackfill：5 行中 2 成功、3 skip', async () => {
    const { executor } = makeFakeExecutor()
    const reports = await runBackfill({
      jsonlPath: join(FIXTURES, 'unknown-senders-fake.jsonl'),
      tokensFiles: [join(FIXTURES, 'tokens-fake.json')],
      dryRun: false,
      executor,
    })
    const jsonlReport = reports.find((r) => r.source.includes('tg_unknown_senders'))!
    expect(jsonlReport.sourceRows).toBe(5)
    expect(jsonlReport.attempted).toBe(2)
    expect(jsonlReport.inserted).toBe(2)
    expect(jsonlReport.skipped).toBe(3)
  })
})

// ---------- dry-run 模式 ----------

describe('runBackfill dry-run', () => {
  test('dry-run：inserted/ignored 恆 0，attempted＝將寫入數，不呼叫 executor', async () => {
    let executorCalled = false
    const executor: RosterExecutor = {
      insertMcpToken: async () => {
        executorCalled = true
        return true
      },
      insertUnknownSender: async () => {
        executorCalled = true
        return true
      },
    }
    const reports = await runBackfill({
      jsonlPath: join(FIXTURES, 'unknown-senders-fake.jsonl'),
      tokensFiles: [join(FIXTURES, 'tokens-fake.json')],
      dryRun: true,
      executor: null,
    })
    expect(executorCalled).toBe(false)
    for (const r of reports) {
      expect(r.inserted).toBe(0)
      expect(r.ignored).toBe(0)
      expect(r.dryRun).toBe(true)
    }
    const tokensReport = reports.find((r) => r.source.includes('mcp_tokens'))!
    expect(tokensReport.attempted).toBe(2)
    const jsonlReport = reports.find((r) => r.source.includes('tg_unknown_senders'))!
    expect(jsonlReport.attempted).toBe(2)
  })
})

// ---------- 冪等性：重跑 bidx 穩定 ----------

describe('冪等性：重跑對 executor 的唯一鍵參數穩定', () => {
  test('同一輸入跑 runBackfill 兩次，bidx 值逐列相同（第二次全數 ignored）', async () => {
    const opts = {
      jsonlPath: join(FIXTURES, 'unknown-senders-fake.jsonl'),
      tokensFiles: [join(FIXTURES, 'tokens-fake.json')],
      dryRun: false,
    }
    const run1 = makeFakeExecutor()
    await runBackfill({ ...opts, executor: run1.executor })
    const run2 = makeFakeExecutor()
    // 用同一組 seen（跨兩次呼叫）模擬「DB 裡已經有第一次寫入的列」。
    const seen = new Set(run1.calls.map((c) => c.key))
    const executor2: RosterExecutor = {
      insertMcpToken: async (row) => {
        const key = `mcp_tokens:${row.server}:${row.env}:${row.token_id}`
        run2.calls.push({ table: 'mcp_tokens', key, row })
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
      insertUnknownSender: async (row) => {
        const key = `tg_unknown_senders:${row.chat_id_bidx.toString('hex')}:${row.ts}`
        run2.calls.push({ table: 'tg_unknown_senders', key, row })
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
    }
    const reports2 = await runBackfill({ ...opts, executor: executor2 })
    for (const r of reports2) {
      expect(r.inserted).toBe(0) // 全部 ignored，因為 key 與 run1 相同
    }
    // 逐列比對 bidx（BINARY 唯一鍵）在兩次跑之間完全相同 —— 確定性 HMAC。
    const keys1 = run1.calls.map((c) => c.key).sort()
    const keys2 = run2.calls.map((c) => c.key).sort()
    expect(keys2).toEqual(keys1)
  })
})

// ---------- token 值不得出現在任何 console 輸出 ----------

describe('安全邊界：token/chat_id 明文不得出現在 console 輸出', () => {
  test('runBackfill + printReports 的輸出不含 fixture 內的真實 token 值', async () => {
    const entries = readTokensFile(join(FIXTURES, 'tokens-fake.json'))!
    const secretTokenValues = entries.map((e) => e.token)

    const logs: string[] = []
    const origLog = console.log
    const origError = console.error
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      const { executor } = makeFakeExecutor()
      const reports = await runBackfill({
          jsonlPath: join(FIXTURES, 'unknown-senders-fake.jsonl'),
        tokensFiles: [join(FIXTURES, 'tokens-fake.json')],
        dryRun: false,
        executor,
      })
      const { printReports } = await import('./lib/report.ts')
      printReports(reports)
    } finally {
      console.log = origLog
      console.error = origError
    }
    const combined = logs.join('\n')
    for (const secret of secretTokenValues) {
      expect(combined.includes(secret)).toBe(false)
    }
    // chat_id 明文（fixture 內的假值）也不得出現。
    expect(combined.includes('700000001')).toBe(false)
    expect(combined.includes('700000002')).toBe(false)
  })
})
