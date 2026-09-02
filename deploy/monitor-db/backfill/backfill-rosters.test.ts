// backfill/backfill-rosters.test.ts — Phase 6 名冊回填單元測試。
//
// 不需要 MySQL：mapping/加密路徑用假金鑰實跑 encryptField/blindIndex；DB 寫入
// 抽象成 RosterExecutor 注入假物件（見 backfill-rosters.ts 的 makePoolExecutor
// 對照組）。tokens 白名單一律用 fixture 覆寫（RunBackfillOptions.tokensFiles），
// 絕不在測試中讀取 aladdin_mcps 底下的真實 tokens*.json。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveServerEnv,
  mapTechUserRow,
  mapTokenRow,
  mapUnknownSenderRow,
  parseJsonlLine,
  parseTechUsersCsv,
  readTokensFile,
  runBackfill,
  TECH_USER_BIDX_SCOPE,
  MCP_TOKEN_BIDX_SCOPE,
  type McpTokenDbRow,
  type RosterExecutor,
  type TechUserDbRow,
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
  table: 'tech_users' | 'mcp_tokens' | 'tg_unknown_senders'
  key: string
  row: TechUserDbRow | McpTokenDbRow | UnknownSenderDbRow
}

function makeFakeExecutor(): { executor: RosterExecutor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const seen = new Set<string>()
  const executor: RosterExecutor = {
    insertTechUser: async (row) => {
      const key = `tech_users:${row.email}`
      calls.push({ table: 'tech_users', key, row })
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
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

// ---------- tech-users.csv 格式防呆 ----------

describe('parseTechUsersCsv 格式防呆（m6）', () => {
  test('值含逗號 → 中止（欄位數非 5）', () => {
    const content = readFileSync(join(FIXTURES, 'tech-users-bad-comma.csv'), 'utf8')
    expect(() => parseTechUsersCsv(content)).toThrow()
  })

  test('值含雙引號 → 中止', () => {
    const content = readFileSync(join(FIXTURES, 'tech-users-bad-quote.csv'), 'utf8')
    expect(() => parseTechUsersCsv(content)).toThrow()
  })

  test('tg_chat_id 非空且非數字 → 中止', () => {
    const content = readFileSync(join(FIXTURES, 'tech-users-bad-chatid.csv'), 'utf8')
    expect(() => parseTechUsersCsv(content)).toThrow()
  })

  test('正常樣本檔可解析，列數與欄位正確', () => {
    const content = readFileSync(join(FIXTURES, 'tech-users-sample.csv'), 'utf8')
    const rows = parseTechUsersCsv(content)
    expect(rows.length).toBe(3)
    expect(rows[0]!.email).toBe('fake_one@example.test')
    expect(rows[1]!.tg_chat_id).toBe('')
    expect(rows[2]!.pushed_repos).toBe('')
  })

  test('tg_chat_id 可為負數（^-?\\d+$ 允許負號）', () => {
    const content =
      'notion_user_name,notion_user_id,email,pushed_repos,tg_chat_id\n' +
      'Neg User,fake-id,neg@example.test,abu,-12345\n'
    const rows = parseTechUsersCsv(content)
    expect(rows[0]!.tg_chat_id).toBe('-12345')
  })
})

describe('mapTechUserRow', () => {
  test('tg_chat_id 空 → enc/bidx/key_ver 皆 NULL', () => {
    const row = mapTechUserRow({
      notion_user_name: 'X',
      notion_user_id: 'id',
      email: 'x@example.test',
      pushed_repos: 'abu',
      tg_chat_id: '',
    })
    expect(row.tg_chat_id_enc).toBeNull()
    expect(row.tg_chat_id_bidx).toBeNull()
    expect(row.bidx_key_ver).toBeNull()
  })

  test('tg_chat_id 非空 → enc 帶 enc:v1: 前綴，bidx 32 bytes，key_ver=1', () => {
    const row = mapTechUserRow({
      notion_user_name: 'X',
      notion_user_id: 'id',
      email: 'x@example.test',
      pushed_repos: 'abu',
      tg_chat_id: '123456789',
    })
    expect(row.tg_chat_id_enc).toMatch(/^enc:v1:/)
    expect(row.tg_chat_id_bidx).not.toBeNull()
    expect(row.tg_chat_id_bidx!.length).toBe(32)
    expect(row.bidx_key_ver).toBe(1)
  })

  test('bidx 與直接呼叫 blindIndex(scope,...) 一致（scope 定案字串正確）', () => {
    const row = mapTechUserRow({
      notion_user_name: 'X',
      notion_user_id: 'id',
      email: 'x@example.test',
      pushed_repos: 'abu',
      tg_chat_id: '999',
    })
    const expected = blindIndex(TECH_USER_BIDX_SCOPE, '999')
    expect(row.tg_chat_id_bidx!.equals(expected!)).toBe(true)
  })
})

// ---------- 49 列規模（MAJOR-D7：全部成功，32 列空值） ----------

describe('49 列規模 CSV（程式生成，32 列空 tg_chat_id）', () => {
  function generateCsv(): string {
    const header = 'notion_user_name,notion_user_id,email,pushed_repos,tg_chat_id'
    const lines = [header]
    for (let i = 1; i <= 49; i++) {
      const chatId = i <= 32 ? '' : String(600000000 + i)
      lines.push(`Fake User ${i},fake-id-${i},fake_user_${i}@example.test,abu;rajah,${chatId}`)
    }
    return lines.join('\n') + '\n'
  }

  test('全部 49 列成功解析與 mapping，32 列 enc/bidx 為 NULL、17 列非 NULL', () => {
    const rows = parseTechUsersCsv(generateCsv())
    expect(rows.length).toBe(49)
    const mapped = rows.map(mapTechUserRow)
    const nullCount = mapped.filter((r) => r.tg_chat_id_enc === null).length
    const nonNullCount = mapped.filter((r) => r.tg_chat_id_enc !== null).length
    expect(nullCount).toBe(32)
    expect(nonNullCount).toBe(17)
    for (const r of mapped) {
      if (r.tg_chat_id_enc !== null) {
        expect(r.tg_chat_id_enc).toMatch(/^enc:v1:/)
        expect(r.tg_chat_id_bidx!.length).toBe(32)
      }
    }
  })

  test('經 runBackfill 以假 executor 寫入：49 列全數 inserted（首次跑無重複）', async () => {
    const csvPath = join(tmpdir(), `backfill-rosters-test-49-${process.pid}-${Date.now()}.csv`)
    writeFileSync(csvPath, generateCsv())
    try {
      const { executor, calls } = makeFakeExecutor()
      const reports = await runBackfill({
        csvPath,
        jsonlPath: join(FIXTURES, 'unknown-senders-fake.jsonl'),
        tokensFiles: [join(FIXTURES, 'tokens-fake.json')],
        dryRun: false,
        executor,
      })
      const techReport = reports.find((r) => r.source.includes('tech_users'))!
      expect(techReport.sourceRows).toBe(49)
      expect(techReport.attempted).toBe(49)
      expect(techReport.inserted).toBe(49)
      expect(techReport.ignored).toBe(0)
      expect(calls.filter((c) => c.table === 'tech_users').length).toBe(49)
    } finally {
      rmSync(csvPath, { force: true })
    }
  })
})

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
      csvPath: join(FIXTURES, 'tech-users-sample.csv'),
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
      insertTechUser: async () => {
        executorCalled = true
        return true
      },
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
      csvPath: join(FIXTURES, 'tech-users-sample.csv'),
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
    const techReport = reports.find((r) => r.source.includes('tech_users'))!
    expect(techReport.attempted).toBe(3)
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
      csvPath: join(FIXTURES, 'tech-users-sample.csv'),
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
      insertTechUser: async (row) => {
        const key = `tech_users:${row.email}`
        run2.calls.push({ table: 'tech_users', key, row })
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
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
        csvPath: join(FIXTURES, 'tech-users-sample.csv'),
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
