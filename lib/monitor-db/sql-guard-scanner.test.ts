// lib/monitor-db/sql-guard-scanner.test.ts — MJ-E7（§6.2.1 S9）三條規則的關門測試。
// 對 writes.ts 內全部 SQL 常數逐條掃描，並附幾條「注入已知違規寫法」的負向測試，
// 證明掃描器真的能抓到 v3 自己在 W1/W4 犯過的錯（不是只會對已修好的語句喊 PASS）。
import { describe, expect, test } from 'bun:test'
import {
  assertGuardOnlyInWhere,
  assertNoDeprecatedValuesFunction,
  scanOdkuStatement,
  scanUpdateStatement,
} from './sql-guard-scanner.ts'
import * as W from './writes.ts'
import { readFileSync } from 'node:fs'

describe('sql-guard-scanner：規則 1/2 對 writes.ts 全部 UPDATE 常數', () => {
  const updates: Array<[string, string]> = [
    ['W2_UPDATE_SQL', W.W2_UPDATE_SQL],
    ['W3_UPDATE_SQL', W.W3_UPDATE_SQL],
    ['W4A_SQL', W.W4A_SQL],
    ['W5_SQL', W.W5_SQL],
    ['HEARTBEAT_UPDATE_SQL', W.HEARTBEAT_UPDATE_SQL],
    ['FILE_OFFSET_UPDATE_SQL', W.FILE_OFFSET_UPDATE_SQL],
    ['DISPATCH_ATTEMPT_ADVANCE_SQL', W.DISPATCH_ATTEMPT_ADVANCE_SQL],
    // migration 005（pipeline-modes Phase 3）
    ['TICKET_STAGE_UPDATE_SQL', W.TICKET_STAGE_UPDATE_SQL],
    ['TICKET_ARTIFACT_SYNC_UPDATE_SQL', W.TICKET_ARTIFACT_SYNC_UPDATE_SQL],
  ]

  for (const [name, sql] of updates) {
    test(`${name} 通過規則 1/2`, () => {
      const r = scanUpdateStatement(sql)
      expect(r.violations).toEqual([])
      expect(r.ok).toBe(true)
    })
  }
})

describe('sql-guard-scanner：規則 1/2 對 writes.ts 全部 ODKU（形狀 A）常數', () => {
  const odkus: Array<[string, string]> = [
    ['W1_SQL', W.W1_SQL],
    ['AGENT_RUN_UPSERT_SQL', W.AGENT_RUN_UPSERT_SQL],
  ]
  for (const [name, sql] of odkus) {
    test(`${name} 通過規則 1/2`, () => {
      const r = scanOdkuStatement(sql)
      expect(r.violations).toEqual([])
      expect(r.ok).toBe(true)
    })
  }
})

describe('sql-guard-scanner：規則 3（守衛只能在 WHERE）', () => {
  test('W2/W3 的 outcome/outcome_tier 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(W.W2_UPDATE_SQL, ['outcome', 'outcome_tier'])).toEqual([])
    expect(assertGuardOnlyInWhere(W.W3_UPDATE_SQL, ['outcome'])).toEqual([])
  })
  test('dispatch 的 status_rank 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(W.DISPATCH_ATTEMPT_ADVANCE_SQL, ['status_rank'])).toEqual([])
  })
  test('heartbeat 的 ts 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(W.HEARTBEAT_UPDATE_SQL, ['ts'])).toEqual([])
  })
  // migration 005：ticket_stages / ticket_artifact_sync 的單調守衛（見 writes.ts
  // 對應段落：這兩張表是「最近一次為準」覆寫語意，正確性靠 finished_at /
  // last_attempt_at 的單調性，守衛必須在 WHERE，不得混進 SET）。
  test('ticket_stages 的 finished_at 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(W.TICKET_STAGE_UPDATE_SQL, ['finished_at'])).toEqual([])
  })
  test('ticket_artifact_sync 的 last_attempt_at 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(W.TICKET_ARTIFACT_SYNC_UPDATE_SQL, ['last_attempt_at'])).toEqual([])
  })
})

describe('sql-guard-scanner：負向測試——注入已知違規寫法，證明掃描器真的會抓', () => {
  test('規則 1：BL-D3(b) 同型錯誤（outcome_source 讀「本語句賦值的另一個欄位」outcome）', () => {
    const bad = `UPDATE runs SET outcome = ?, outcome_source = IF(outcome IS NULL, 'a', 'b') WHERE run_id = ?`
    const r = scanUpdateStatement(bad)
    expect(r.ok).toBe(false)
    expect(r.violations.some(v => v.includes('規則1違反'))).toBe(true)
  })

  test('規則 2：自我賦值但不是 COALESCE/GREATEST/IF 白名單形狀', () => {
    const bad = `UPDATE dispatch_attempts SET status_rank = IF(status_rank < ?, ?, status_rank) WHERE dispatch_id = ?`
    const r = scanUpdateStatement(bad)
    expect(r.ok).toBe(false)
    expect(r.violations.some(v => v.includes('規則2違反'))).toBe(true)
  })

  test('規則 3：guard 欄位「未被賦值」但比較式洩漏進另一欄的 SET（rule 1/2 抓不到，只有 rule 3 抓得到）', () => {
    const bad = `UPDATE dispatch_attempts SET cleared_at = IF(status_rank < 100, NULL, ?) WHERE dispatch_id = ?`
    expect(scanUpdateStatement(bad).ok).toBe(true) // 證明 rule1/2 確實抓不到這種情況
    const violations = assertGuardOnlyInWhere(bad, ['status_rank'])
    expect(violations.length).toBeGreaterThan(0)
  })
})

describe('S2：writes.ts 內不得出現已棄用的 VALUES() 函式呼叫（ODKU 用 AS new 別名）', () => {
  test('writes.ts 原始碼掃描零命中', () => {
    const source = readFileSync(new URL('./writes.ts', import.meta.url), 'utf8')
    const violations = assertNoDeprecatedValuesFunction(source)
    expect(violations).toEqual([])
  })

  test('注入 VALUES() 用法會被抓到（證明掃描器不是空判斷）', () => {
    const bad = `col = VALUES(col)`
    expect(assertNoDeprecatedValuesFunction(bad).length).toBeGreaterThan(0)
  })
})
