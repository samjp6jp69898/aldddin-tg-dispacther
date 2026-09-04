// lib/monitor-db/sql-guard-scanner.ts — writes.ts SQL 常數的靜態守衛掃描器。
//
// 依據 plan-db-as-truth-v3.2.md MJ-E7（§6.2.1 S9 / §9 Phase 1.4 判準重寫）：
// 自己寫一個約 100 行的括號/識別字掃描器，零新依賴（不引入 node-sql-parser——
// SQL 常數是我們自己寫的、形狀已被規則 2 限制在三種，不需要通用 parser）。
//
// 三條可執行規則：
//   規則 1（跨欄禁止）：對每一條 SQL，「被賦值的欄位集合」∩「其他欄位的賦值運算式
//     所引用的欄位集合」= ∅。→ 精確擋掉 `outcome_source = IF(outcome IS NULL, …)`
//     這種「引用同語句內另一個會被賦值的欄位」的寫法。
//   規則 2（自引用白名單）：一個欄位的賦值運算式若引用它自己，形狀只允許四種：
//     COALESCE(<自己>, <參數|new.同名欄>)、GREATEST(<自己>, <參數|new.同名欄>)、
//     IF(<守衛>, <前兩種之一>, <自己>)、IF(<守衛>, <new.同名欄（裸值）>, <自己>)，
//     其中 <守衛> 只允許引用「本語句不賦值」的欄位。第四種形狀是第三種的變體：中間分支
//     直接是 new.同名欄的裸值而不再包一層 COALESCE——語意等價（COALESCE(x) = x，當 new
//     一定帶值時兩者是同一件事），F-0 擴充規則 2 覆蓋 lib/registry/token-registry.ts 既有
//     上線的 ISSUE_UPSERT_SQL 時發現既有三形狀漏收這個變體，故補上（不是放寬防線，是承認
//     一個已經安全的語法變體）。
//   規則 3（守衛位置）：形狀 B 的每一條 UPDATE，其守衛（比較/IS NULL 判斷）必須出現在
//     WHERE，不得出現在任何 SET 運算式裡（規則 2 允許的 IF 守衛除外——那個守衛本身
//     不是「決定要不要覆寫終態」的業務守衛，是純粹的 host 相符檢查，且被規則 2 明文放行）。
//
// 這支掃描器只服務「我們自己控制格式的 SQL 常數」，不是通用 SQL parser；解析失敗
// 一律 FAIL（不允許「解析不了就跳過」，MJ-E7 明文禁止）。同時服務 S2 的靜態測試：
// 「writes.ts 內不得出現 VALUES( 這個函式呼叫形式」（ODKU 的 `AS new` 別名一旦使用，
// 就不得再用 VALUES() 讀新值）。

export interface Assignment {
  column: string
  expr: string
}

export interface ScanResult {
  ok: boolean
  violations: string[]
  assignments: Assignment[]
}

/** 依括號深度切分（逗號分隔，depth 0 才算分隔點）。 */
function splitTopLevel(s: string, sepChar: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sepChar && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur)
  return parts.map(p => p.trim()).filter(p => p.length > 0)
}

/** 取出 UPDATE 語句的 SET 子句與 WHERE 子句（本檔控制格式：一律 `UPDATE t SET ... WHERE ...`）。 */
function splitUpdateClauses(sql: string): { setClause: string; whereClause: string } {
  const normalized = sql.replace(/\s+/g, ' ').trim()
  const setIdx = normalized.search(/\bSET\b/i)
  const whereIdx = normalized.search(/\bWHERE\b/i)
  if (setIdx === -1 || whereIdx === -1 || whereIdx < setIdx) {
    throw new Error(`splitUpdateClauses: 不是預期的 UPDATE … SET … WHERE … 形狀，解析失敗：${sql}`)
  }
  return {
    setClause: normalized.slice(setIdx + 3, whereIdx).trim(),
    whereClause: normalized.slice(whereIdx + 5).trim(),
  }
}

/** 解析 SET 子句成 `{column, expr}[]`。 */
function parseSetAssignments(setClause: string): Assignment[] {
  return splitTopLevel(setClause, ',').map(part => {
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) throw new Error(`parseSetAssignments: 找不到 '='：${part}`)
    return { column: part.slice(0, eqIdx).trim(), expr: part.slice(eqIdx + 1).trim() }
  })
}

const SQL_RESERVED = new Set([
  'IF',
  'COALESCE',
  'GREATEST',
  'NULL',
  'AND',
  'OR',
  'NOT',
  'IS',
  'AS',
  'NEW',
  'TRUE',
  'FALSE',
  'NOW',
  'INTERVAL',
])

/**
 * 從一段運算式抓出所有「看起來像欄位」的識別字（排除 SQL 保留字、`?` 參數、字串/數字字面值）。
 * `table.column` 一律去掉表名前綴（不論表名是 `runs`／`new`／`agent_runs`……），因為在
 * 「該欄位是否被賦值」這個問題上，表名前綴不影響同一張表內的欄位身分。
 */
function referencedIdentifiers(expr: string): string[] {
  const withoutStrings = expr.replace(/'(?:[^'\\]|\\.)*'/g, "''")
  const idents = withoutStrings.match(/\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?\b/g) ?? []
  return idents
    .map(id => (id.includes('.') ? id.slice(id.indexOf('.') + 1) : id))
    .filter(id => !SQL_RESERVED.has(id.toUpperCase()))
}

const SELF_REF_PATTERNS = [
  // COALESCE(<self>, <anything>) —— 允許巢狀在 IF() 內；<self> 前可能有任意表名前綴。
  (col: string, expr: string) => new RegExp(`^COALESCE\\(\\s*(?:[a-zA-Z_]+\\.)?${col}\\s*,\\s*.+\\)$`, 'i').test(expr),
  // GREATEST(<self>, <anything>)
  (col: string, expr: string) => new RegExp(`^GREATEST\\(\\s*(?:[a-zA-Z_]+\\.)?${col}\\s*,\\s*.+\\)$`, 'i').test(expr),
  // IF(<guard>, <COALESCE|GREATEST 其一>, <self>)
  (col: string, expr: string) => {
    const m = new RegExp(`^IF\\(.+,\\s*(?:COALESCE|GREATEST)\\(.+\\)\\s*,\\s*(?:[a-zA-Z_]+\\.)?${col}\\s*\\)$`, 'i').exec(expr)
    return m !== null
  },
  // IF(<guard>, <new.同名欄（裸值，不包 COALESCE/GREATEST）>, <self>)
  (col: string, expr: string) => {
    const m = new RegExp(`^IF\\(.+,\\s*new\\.${col}\\s*,\\s*(?:[a-zA-Z_]+\\.)?${col}\\s*\\)$`, 'i').exec(expr)
    return m !== null
  },
]

function isAllowedSelfReferenceShape(column: string, expr: string): boolean {
  return SELF_REF_PATTERNS.some(check => check(column, expr))
}

/**
 * 掃描一條「UPDATE … SET … WHERE …」形狀的語句，回傳規則 1/2 的違規清單。
 * 規則 3（守衛必須在 WHERE）由呼叫端另外用 `assertGuardOnlyInWhere` 檢查
 * （守衛欄位清單因表而異，掃描器本身不猜）。
 */
export function scanUpdateStatement(sql: string): ScanResult {
  const violations: string[] = []
  const { setClause } = splitUpdateClauses(sql)
  const assignments = parseSetAssignments(setClause)
  const assignedColumns = new Set(assignments.map(a => a.column.toLowerCase()))

  for (const { column, expr } of assignments) {
    const refs = referencedIdentifiers(expr)
    const selfRef = refs.some(r => r.toLowerCase() === column.toLowerCase())
    const otherAssignedRefs = refs.filter(r => r.toLowerCase() !== column.toLowerCase() && assignedColumns.has(r.toLowerCase()))

    // 規則 1：不得引用「本語句賦值的其他欄位」。
    if (otherAssignedRefs.length > 0) {
      violations.push(`規則1違反：欄位 '${column}' 的賦值運算式引用了同語句賦值的其他欄位 [${otherAssignedRefs.join(', ')}]：${expr}`)
    }

    // 規則 2：若引用自己，形狀必須落在白名單三種之一。
    if (selfRef && !isAllowedSelfReferenceShape(column, expr)) {
      violations.push(`規則2違反：欄位 '${column}' 引用自己，但不是 COALESCE/GREATEST/IF 白名單形狀：${expr}`)
    }
  }

  return { ok: violations.length === 0, violations, assignments }
}

/**
 * 規則 3：守衛欄位（如 `outcome_tier`、`status_rank`）只允許在 WHERE 出現比較/NULL 判斷，
 * 在 SET 子句中若出現，只能是規則 2 允許的 IF() 守衛用途（如 `runs.host = new.host`）。
 * `guardColumns` 由呼叫端依表而定（例如 runs 的 W2/W3 是 `outcome`/`outcome_tier`）。
 */
export function assertGuardOnlyInWhere(sql: string, guardColumns: string[]): string[] {
  const violations: string[] = []
  const { setClause, whereClause } = splitUpdateClauses(sql)
  if (whereClause.trim().length === 0) {
    violations.push('規則3違反：語句沒有 WHERE 子句')
  }
  const assignments = parseSetAssignments(setClause)
  for (const col of guardColumns) {
    const comparisonRe = new RegExp(`\\b${col}\\b\\s*(<|<=|>|>=|=|IS)`, 'i')
    for (const { column, expr } of assignments) {
      // 允許：守衛欄位本身被賦值（例如 `outcome_tier = 2`，這不是「比較」）。
      if (column.toLowerCase() === col.toLowerCase()) continue
      if (comparisonRe.test(expr) && !isAllowedSelfReferenceShape(column, expr)) {
        violations.push(`規則3違反：守衛欄位 '${col}' 的比較/NULL 判斷出現在 SET（欄位 '${column}'），不在 WHERE：${expr}`)
      }
    }
  }
  return violations
}

/** 取出 ODKU 語句（形狀 A）的 `ON DUPLICATE KEY UPDATE` 子句。 */
function extractOdkuClause(sql: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim()
  const idx = normalized.search(/\bON DUPLICATE KEY UPDATE\b/i)
  if (idx === -1) {
    throw new Error(`extractOdkuClause: 找不到 ON DUPLICATE KEY UPDATE，不是預期的形狀 A 語句：${sql}`)
  }
  return normalized.slice(idx + 'ON DUPLICATE KEY UPDATE'.length).trim()
}

/**
 * 掃描一條「INSERT … VALUES … AS new ON DUPLICATE KEY UPDATE …」（形狀 A）語句，
 * 套用與 `scanUpdateStatement` 相同的規則 1/2（形狀 A 沒有 WHERE，規則 3 不適用——
 * 形狀 A 的守衛用 `IF(<本語句不賦值的欄位比較>, …, <自己>)` 表達，已被規則 2 涵蓋）。
 */
export function scanOdkuStatement(sql: string): ScanResult {
  const violations: string[] = []
  const odkuClause = extractOdkuClause(sql)
  const assignments = parseSetAssignments(odkuClause)
  const assignedColumns = new Set(assignments.map(a => a.column.toLowerCase()))

  for (const { column, expr } of assignments) {
    const refs = referencedIdentifiers(expr)
    const selfRef = refs.some(r => r.toLowerCase() === column.toLowerCase())
    const otherAssignedRefs = refs.filter(r => r.toLowerCase() !== column.toLowerCase() && assignedColumns.has(r.toLowerCase()))

    if (otherAssignedRefs.length > 0) {
      violations.push(`規則1違反：欄位 '${column}' 的賦值運算式引用了同語句賦值的其他欄位 [${otherAssignedRefs.join(', ')}]：${expr}`)
    }
    if (selfRef && !isAllowedSelfReferenceShape(column, expr)) {
      violations.push(`規則2違反：欄位 '${column}' 引用自己，但不是 COALESCE/GREATEST/IF 白名單形狀：${expr}`)
    }
  }

  return { ok: violations.length === 0, violations, assignments }
}

/**
 * S2 的一部分：全 repo（本模組）內不得出現 `VALUES(<單一欄位>)` 這個已棄用的函式呼叫形式
 * （ODKU 的 `AS new` 別名一旦使用，就不得再用 `VALUES()`）。
 * 只抓 `VALUES(` 後面緊接「單一裸識別字」再收 `)`（例如 `VALUES(col)`）——這是 MySQL 8.0.20
 * 起 deprecated 的 ODKU 讀值函式；不誤傷 `INSERT INTO … VALUES (?,?,…)` 這種帶多個
 * 逗號分隔佔位符/字面值的 VALUES 子句（那個 `(` 前通常有空白，且內容不是單一裸識別字）。
 */
export function assertNoDeprecatedValuesFunction(source: string): string[] {
  const violations: string[] = []
  const deprecatedCallRe = /\bVALUES\(\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\)/
  const lines = source.split('\n')
  lines.forEach((line, idx) => {
    if (deprecatedCallRe.test(line)) {
      violations.push(`第 ${idx + 1} 行疑似使用已棄用的 VALUES() 函式：${line.trim()}`)
    }
  })
  return violations
}
