// lib/monitor-db/cancel-resolve.test.ts — 五段 run_id 解析（cancel 專用）結構性測試。
//
// 依據 impl-errata-g2.md MJ-H1 指揮官裁定與 plan-review-G2.md 的可證偽關卡要求：
// 「Phase 1.4 測試清單必須補『同票 auto-retry 交疊 + R1 失效』情境（G2 明言現行
// 清單只列良性方向，擔不起關卡之責）」——本檔的
// 「MJ-H1：同票 auto-retry 交疊 + R1 失效」測試就是那條關卡，不是佔位。
//
// 這個情境同時是 lib/monitor-db/spool/spool-gate.test.ts 裡 MJ-H1 todo 指向的
// 真測試（該 todo 只留描述性佔位，理由是 cancel 解析屬本檔/writes.ts 所有權
// 範圍，不在 spool 模組職責內）。
import { describe, expect, test } from 'bun:test'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { R3_LEGACY_KEY_SQL, R4_LATEST_RUNNING_SQL, buildR1PidMatchSql, resolveRunId, type ResolveRunIdInput } from './cancel-resolve.ts'
import { MON_HOST } from './env.ts'
import type { MonitorDbExecutor } from './writes.ts'

interface FakeRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  lifecycle_rank: number
  outcome: string | null
  pid: number | null
  legacy_key: string | null
  stdout_path: string | null
  started_at: string | null
  created_at: string
}

/** SQL 三值邏輯的最小模擬：`col = ?` 在任一邊是 null 時視為不成立（不是「兩者皆 null 即相等」）。 */
function sqlEq(a: unknown, b: unknown): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a === b
}

/**
 * 專用假 DB：只需要支撐 cancel-resolve.ts 的三條 SELECT（R1/R3/R4），用內容
 * 特徵（而非 writes.test.ts 那種 SQL 常數參照相等）比對——R1 的 SQL 含動態
 * 數量的 `pid IN (...)` 占位符，無法用固定字串常數比對。
 */
class FakeCancelDb implements MonitorDbExecutor {
  rows: FakeRow[] = []
  calls: Array<{ sql: string; params: unknown[] }> = []

  async execute<T = ResultSetHeader>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    this.calls.push({ sql, params })

    if (sql.includes('pid IN')) return [this.handleR1(params) as unknown as T, []]
    if (sql === R3_LEGACY_KEY_SQL) return [this.handleR3(params) as unknown as T, []]
    if (sql === R4_LATEST_RUNNING_SQL) return [this.handleR4(params) as unknown as T, []]
    throw new Error(`FakeCancelDb: 未預期的 SQL：${sql}`)
  }

  private handleR1(params: unknown[]): RowDataPacket[] {
    const [host, ticket, kind, ...pids] = params as [string, string, string, ...number[]]
    const matched = this.rows.filter(
      r => r.host === host && r.ticket === ticket && r.kind === kind && r.lifecycle_rank === 30 && r.outcome === null && r.pid !== null && pids.includes(r.pid),
    )
    return matched.map(r => ({ run_id: r.run_id })) as unknown as RowDataPacket[]
  }

  private handleR3(params: unknown[]): RowDataPacket[] {
    const [host, ticket, kind, legacyKey, stdoutPath] = params as [string, string, string, string | null, string | null]
    const matched = this.rows.filter(
      r =>
        r.host === host &&
        r.ticket === ticket &&
        r.kind === kind &&
        r.lifecycle_rank === 30 &&
        r.outcome === null &&
        (sqlEq(r.legacy_key, legacyKey) || sqlEq(r.stdout_path, stdoutPath)),
    )
    return matched.map(r => ({ run_id: r.run_id })) as unknown as RowDataPacket[]
  }

  private handleR4(params: unknown[]): RowDataPacket[] {
    const [host, ticket, kind] = params as [string, string, string]
    const matched = this.rows
      .filter(r => r.host === host && r.ticket === ticket && r.kind === kind && r.lifecycle_rank === 30 && r.outcome === null)
      .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '') || b.created_at.localeCompare(a.created_at))
    return matched.length > 0 ? ([{ run_id: matched[0]!.run_id }] as unknown as RowDataPacket[]) : ([] as unknown as RowDataPacket[])
  }
}

function makeRow(overrides: Partial<FakeRow> & { run_id: string }): FakeRow {
  return {
    host: MON_HOST,
    ticket: 'FAQ-1',
    kind: 'bug',
    lifecycle_rank: 30,
    outcome: null,
    pid: null,
    legacy_key: null,
    stdout_path: null,
    started_at: null,
    created_at: '2026-09-02 00:00:00.000',
    ...overrides,
  }
}

function baseInput(overrides: Partial<ResolveRunIdInput> = {}): ResolveRunIdInput {
  return {
    kind: 'bug',
    ticket: 'FAQ-1',
    target: { pid: 100, pidSet: [100] },
    legacyKey: null,
    stdoutPath: null,
    marker: { runId: null, kind: null },
    ...overrides,
  }
}

describe('resolveRunId — 五段解析次序（errata MJ-H1：R1 → R3 → R2 → R4 → R5）', () => {
  test('R1 命中：ps pid 對得上 runs.pid → pid_match，且不觸發任何 WARN 路徑', async () => {
    const db = new FakeCancelDb()
    db.rows.push(makeRow({ run_id: 'run-old', pid: 100, legacy_key: 'FAQ-1.2026-09-02T00:00:00.000Z' }))
    const result = await resolveRunId(db, baseInput({ target: { pid: 100, pidSet: [100, 101] } }))
    expect(result).toEqual({ runId: 'run-old', resolvedBy: 'pid_match', markerMismatch: false })
  })

  test('R1 落空、R3 命中：legacy_key 對位優先於 R2 marker', async () => {
    const db = new FakeCancelDb()
    db.rows.push(makeRow({ run_id: 'run-old', pid: null, legacy_key: 'FAQ-1.2026-09-02T00:00:00.000Z' }))
    const result = await resolveRunId(
      db,
      baseInput({
        legacyKey: 'FAQ-1.2026-09-02T00:00:00.000Z',
        marker: { runId: 'run-SOMETHING-ELSE', kind: 'bug' }, // 就算 marker 有值，R3 命中時完全不理它
      }),
    )
    expect(result).toEqual({ runId: 'run-old', resolvedBy: 'legacy_key', markerMismatch: false })
  })

  test('R1/R3 皆落空、R2 命中且 kind 一致 → marker，無 mismatch', async () => {
    const db = new FakeCancelDb() // 空表：R1/R3 都是 0 列
    const result = await resolveRunId(db, baseInput({ marker: { runId: 'run-marker', kind: 'bug' } }))
    expect(result).toEqual({ runId: 'run-marker', resolvedBy: 'marker', markerMismatch: false })
  })

  test('R2 命中但 kind 不一致（自我驗證失敗）→ 降級到 R4，markerMismatch=true', async () => {
    const db = new FakeCancelDb()
    db.rows.push(makeRow({ run_id: 'run-latest', started_at: '2026-09-02T00:05:00.000Z', created_at: '2026-09-02 00:05:00.000' }))
    const result = await resolveRunId(db, baseInput({ kind: 'bug', marker: { runId: 'run-marker', kind: 'demand' } }))
    expect(result).toEqual({ runId: 'run-latest', resolvedBy: 'latest_running', markerMismatch: true })
  })

  test('R1/R2/R3 皆落空、R4 命中 → latest_running（取 started_at 最新那列）', async () => {
    const db = new FakeCancelDb()
    db.rows.push(makeRow({ run_id: 'run-a', started_at: '2026-09-02T00:01:00.000Z', created_at: '2026-09-02 00:01:00.000' }))
    db.rows.push(makeRow({ run_id: 'run-b', started_at: '2026-09-02T00:02:00.000Z', created_at: '2026-09-02 00:02:00.000' }))
    const result = await resolveRunId(db, baseInput())
    expect(result).toEqual({ runId: 'run-b', resolvedBy: 'latest_running', markerMismatch: false })
  })

  test('R1–R4 全部落空 → R5 placeholder，鑄一個合法 UUIDv4', async () => {
    const db = new FakeCancelDb()
    const result = await resolveRunId(db, baseInput())
    expect(result.resolvedBy).toBe('placeholder')
    expect(result.markerMismatch).toBe(false)
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('R1 命中但列數 > 1（不明確）→ 不採用，降級到下一段', async () => {
    const db = new FakeCancelDb()
    db.rows.push(makeRow({ run_id: 'run-x', pid: 100 }))
    db.rows.push(makeRow({ run_id: 'run-y', pid: 100 })) // 理論上不該發生，但測「不明確就不猜」
    const result = await resolveRunId(db, baseInput({ marker: { runId: 'run-marker', kind: 'bug' } }))
    expect(result.resolvedBy).toBe('marker') // R1 因 >1 列跳過，R3 落空（無 legacyKey/stdoutPath），落到 R2
  })
})

describe('resolveRunId — MJ-H1：同票 auto-retry 交疊 + R1 失效（可證偽關卡，impl-errata-g2.md 指名）', () => {
  test(
    '兩個 run（R_old 正在被 ps 命中、R_new 是 reaper 觸發的 auto-retry 覆寫了 marker），' +
      'R1 因 runs.pid 尚未落地（非阻斷寫入延遲）而失效 → 解析出的 run_id 必須對應 ps 命中的 R_old，' +
      '不能被覆寫後的 marker（指向 R_new）誤導',
    async () => {
      const db = new FakeCancelDb()
      // legacy_key 格式＝`<ticket>.<ISO>`（v3 §10.2；ISO 用冒號，不是檔名裡
      // 反推前的 dash-obfuscated 格式——那個轉換屬呼叫端 deriveLegacyKey 的
      // 職責，不在本模組內）。
      const legacyKeyOld = 'FAQ-99.2026-09-02T10:00:00.000Z'
      const legacyKeyNew = 'FAQ-99.2026-09-02T12:00:00.000Z'

      // R_old：使用者實際按取消、ps 上還活著的那個 run。pid 尚未落地（W1 非
      // 阻斷寫入延遲，v3.2 自己承認「這不是罕見退路，是常態」）→ R1 SELECT
      // 的 `pid IN (...)` 對這一列必然落空（pid IS NULL）。
      db.rows.push(
        makeRow({
          run_id: 'run-old-uuid',
          ticket: 'FAQ-99',
          pid: null,
          legacy_key: legacyKeyOld,
          started_at: '2026-09-02T10:00:00.000Z',
          created_at: '2026-09-02 10:00:00.000',
        }),
      )
      // R_new：reaper 在 195 分門檻對同票觸發的 auto-retry，pid 已落地且較晚
      // start_at，同時是 marker 檔目前記錄的 runId（markPipelineActive 覆寫）。
      db.rows.push(
        makeRow({
          run_id: 'run-new-uuid',
          ticket: 'FAQ-99',
          pid: 200,
          legacy_key: legacyKeyNew,
          started_at: '2026-09-02T12:00:00.000Z',
          created_at: '2026-09-02 12:00:00.000',
        }),
      )

      const input = baseInput({
        ticket: 'FAQ-99',
        // ps 快照命中的是 P_old（cachedRunning.find 回陣列第一個符合的，可能
        // 是較舊、還活著的那個），但 runs.pid 還沒寫進去（R1 必然失效）。
        target: { pid: 9999, pidSet: [9999] },
        // 呼叫端（tg-monitor cancelPipeline）由 ps 命中的 target 反推 stdout
        // 檔名 → legacy_key，這與 R_old 的 legacy_key 逐位元組相同（同一個
        // spawn 產生）。
        legacyKey: legacyKeyOld,
        stdoutPath: null,
        // marker 檔已被 R_new 的 markPipelineActive 覆寫（active-pipeline-
        // marker.ts:36 檔名只有 ticket，同票第二個 run 直接覆寫第一個）。
        marker: { runId: 'run-new-uuid', kind: 'bug' },
      })

      const result = await resolveRunId(db, input)

      // 核心斷言：解析出的 run_id 必須對應 ps 命中的那一個（R_old），不是
      // marker 指向的 R_new——這正是 R3 排在 R2 前面要保證的事。若次序錯了
      // （v3.2 原文的 R2→R3），這裡會得到 'run-new-uuid'，重現 A-MJ-5 /
      // B-MAJOR-4 的原始 bug（旗標寫錯列，真正被殺的 R_old 落 infra_failure，
      // 沒被殺的 R_new 反而被固化成 cancelled）。
      expect(result.runId).toBe('run-old-uuid')
      expect(result.resolvedBy).toBe('legacy_key')
      expect(result.markerMismatch).toBe(false) // 根本沒走到 R2，不算 mismatch
    },
  )

  test('同一情境但 legacy_key 也對不上（R3 真的失效）→ 才會退到 marker（R2），並如實回報 marker', async () => {
    const db = new FakeCancelDb()
    db.rows.push(makeRow({ run_id: 'run-old-uuid', ticket: 'FAQ-99', pid: null, legacy_key: 'FAQ-99.2026-09-02T10:00:00.000Z' }))
    db.rows.push(makeRow({ run_id: 'run-new-uuid', ticket: 'FAQ-99', pid: 200, legacy_key: 'FAQ-99.2026-09-02T12:00:00.000Z' }))

    const input = baseInput({
      ticket: 'FAQ-99',
      target: { pid: 9999, pidSet: [9999] },
      legacyKey: null, // ps 反推失敗（例如檔名格式意外對不上正規表達式）
      stdoutPath: null,
      marker: { runId: 'run-new-uuid', kind: 'bug' },
    })

    const result = await resolveRunId(db, input)
    // R3 失效時退到 R2，marker 的 kind 一致（都是 'bug'）→ 採用它，即使它其實
    // 指向錯誤的 run——這是本裁定明文承認的殘餘風險（見 cancel-resolve.ts
    // 檔頭），不是本測試要擋的東西；本測試只驗證「R3 有效時一定贏」。
    expect(result.runId).toBe('run-new-uuid')
    expect(result.resolvedBy).toBe('marker')
  })
})

describe('buildR1PidMatchSql', () => {
  test('依 pid 數量產生對應數量的占位符', () => {
    expect(buildR1PidMatchSql(1)).toContain('pid IN (?)')
    expect(buildR1PidMatchSql(3)).toContain('pid IN (?, ?, ?)')
  })
})
