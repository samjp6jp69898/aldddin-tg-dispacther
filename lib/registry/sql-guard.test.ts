// lib/registry/sql-guard.test.ts — F-0：SQL 常數雙防線（規則 1/2/3 + S2）擴及 lib/registry。
// 沿用 lib/monitor-db/sql-guard-scanner.ts 同一套掃描器，對本目錄的 SQL 常數逐條掃描，
// 比照 lib/monitor-db/sql-guard-scanner.test.ts 對 writes.ts 的接法。
import { describe, expect, test } from 'bun:test'
import {
  assertGuardOnlyInWhere,
  assertNoDeprecatedValuesFunction,
  scanOdkuStatement,
  scanUpdateStatement,
} from '../monitor-db/sql-guard-scanner.ts'
import {
  ISSUE_UPSERT_SQL,
  REVOKE_UPDATE_SQL,
  RENAME_UPDATE_SQL,
} from './token-registry.ts'

describe('sql-guard-scanner：規則 1/2 對 token-registry.ts 的 ODKU 常數', () => {
  test('ISSUE_UPSERT_SQL 通過規則 1/2（4 個欄位皆為 IF(guard, new.同名欄, self) 形狀）', () => {
    const r = scanOdkuStatement(ISSUE_UPSERT_SQL)
    expect(r.violations).toEqual([])
    expect(r.ok).toBe(true)
    // 4 個自引用欄位都要真的被掃到、不是因為解析失敗才「沒有違規」。
    expect(r.assignments.map(a => a.column)).toEqual(['token_enc', 'token_bidx', 'issued_at', 'display_name'])
  })
})

describe('sql-guard-scanner：規則 1/2/3 對 token-registry.ts 的 UPDATE 常數', () => {
  test('REVOKE_UPDATE_SQL 通過規則 1/2（無自引用，單純寫 revoked_at）', () => {
    const r = scanUpdateStatement(REVOKE_UPDATE_SQL)
    expect(r.violations).toEqual([])
    expect(r.ok).toBe(true)
  })
  test('RENAME_UPDATE_SQL 通過規則 1/2（無自引用，單純寫 display_name）', () => {
    const r = scanUpdateStatement(RENAME_UPDATE_SQL)
    expect(r.violations).toEqual([])
    expect(r.ok).toBe(true)
  })
  test('REVOKE_UPDATE_SQL 的 revoked_at IS NULL 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(REVOKE_UPDATE_SQL, ['revoked_at'])).toEqual([])
  })
  test('RENAME_UPDATE_SQL 的 revoked_at IS NULL 守衛只出現在 WHERE', () => {
    expect(assertGuardOnlyInWhere(RENAME_UPDATE_SQL, ['revoked_at'])).toEqual([])
  })
})

describe('sql-guard-scanner：規則 2 第四種白名單形狀 IF(guard, new.同名欄, self) 的關門測試', () => {
  test('正面：ISSUE_UPSERT_SQL 同型的最小案例（裸 new 值，不包 COALESCE）通過', () => {
    const odku = `INSERT INTO t (a) VALUES (?) AS new ON DUPLICATE KEY UPDATE token_enc = IF(revoked_at IS NULL, new.token_enc, t.token_enc)`
    expect(scanOdkuStatement(odku).ok).toBe(true)
  })

  test('負向：guard 被拿掉（middle 分支不再受任何條件保護）——規則 2 應該抓到，不是白名單形狀', () => {
    const bad = `INSERT INTO t (a) VALUES (?) AS new ON DUPLICATE KEY UPDATE token_enc = new.token_enc`
    const r = scanOdkuStatement(bad)
    expect(r.ok).toBe(false)
    expect(r.violations.some(v => v.includes('規則2違反'))).toBe(true)
  })

  test('負向：中間分支不是「同名欄的裸 new 值」而是別的欄位——不該被第四形狀誤放行', () => {
    const bad = `INSERT INTO t (a,b) VALUES (?,?) AS new ON DUPLICATE KEY UPDATE token_enc = IF(revoked_at IS NULL, new.other_field, t.token_enc)`
    const r = scanOdkuStatement(bad)
    expect(r.ok).toBe(false)
    expect(r.violations.some(v => v.includes('規則2違反'))).toBe(true)
  })

  test('負向：中間分支是常數字面值而非 new.同名欄——不該被第四形狀誤放行', () => {
    const bad = `INSERT INTO t (a) VALUES (?) AS new ON DUPLICATE KEY UPDATE token_enc = IF(revoked_at IS NULL, 'hacked', t.token_enc)`
    const r = scanOdkuStatement(bad)
    expect(r.ok).toBe(false)
    expect(r.violations.some(v => v.includes('規則2違反'))).toBe(true)
  })
})

describe('S2：token-registry.ts 內不得出現已棄用的 VALUES() 函式呼叫（ODKU 用 AS new 別名）', () => {
  test('token-registry.ts 原始碼掃描零命中', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./token-registry.ts', import.meta.url), 'utf8')
    const violations = assertNoDeprecatedValuesFunction(source)
    expect(violations).toEqual([])
  })
})

// ── tech-users-sync.ts：F-0 範圍內查證發現的既有真違規，記錄但不強制通過 ──────────
// tech-users-sync.ts:428-431 的 upsertSql 使用了 `ON DUPLICATE KEY UPDATE col = VALUES(col)`
// 這個已棄用形式（S2 明文禁止），而不是 writes.ts 統一採用的 `AS new` 別名寫法。這不是
// 守衛邏輯漏洞（該欄位本來就設計成「每次無條件覆寫」，見檔案內註解），是遺留的舊語法。
// 是否要重寫成 `AS new` 別名形式是會改動既有已上線 SQL 文字的決定，F-0 這次只負責把
// lib/registry 接上掃描器覆蓋、如實回報現況，不在本輪自行判定要不要改寫——見台帳。
describe('S2：tech-users-sync.ts 現況記錄（已知違規，待總指揮裁定是否重寫，非本測試強制項）', () => {
  test('目前的 upsertSql 確實使用了已棄用的 VALUES() 語法（記錄現況，非「應該通過」的斷言）', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./tech-users-sync.ts', import.meta.url), 'utf8')
    const violations = assertNoDeprecatedValuesFunction(source)
    // 刻意斷言「有違規」而非「零違規」——如果哪天有人把它改成 AS new 形式，這則測試會
    // 提醒維護者順便把上面這一段註解與斷言方向改回「零命中」。
    expect(violations.length).toBeGreaterThan(0)
  })
})
