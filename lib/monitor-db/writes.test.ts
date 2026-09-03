// lib/monitor-db/writes.test.ts — Phase 1.4 結構性測試（不打真實 DB，注入假 client）。
//
// 依據 plan-db-as-truth-v3.md §9 Phase 1.4 與 plan-db-as-truth-v3.2.md 裁定 2 的
// MJ-E1/MJ-E5 修訂，涵蓋本模組（lib/monitor-db/writes.ts）職責範圍內的結構性斷言：
//   - 終態 UPDATE 先於 running INSERT → 最終列 = finished 且欄位被補齊
//   - 同事件重放 3 次 → 欄位不變、落在 guarded_terminal
//   - 暫定終態 → 權威終態覆寫成功；權威 → 權威不覆寫；暫定 → 暫定不覆寫（BL-C1／R3'）
//   - cancel 旗標在終態之前／之後／重放兩次 → 三種都得到 cancelled
//   - lifecycle rank 後退寫入 → guarded_rank，值不變
//   - host 不符 → r1_violation（W1 一條、W2 一條，【G:MJ-E1】要求的兩條）
// 真正的 MySQL UPDATE/ODKU 語意（affectedRows 三值、Rows matched: 解析、
// lc_messages 等）交給 semantic-verify.test.ts 對真實 mon-mysql 實測（S1-S11）。
import { describe, expect, test } from 'bun:test'
import { FakeRunsDb } from './test-support/fake-runs-db.ts'
import {
  advanceDispatchAttempt,
  createDispatchAttempt,
  DISPATCH_ATTEMPT_ADVANCE_SQL,
  DISPATCH_ATTEMPT_INSERT_SQL,
  fixCancelLateOutcome,
  writeCancelFlag,
  writeRunOutcomeAuthoritative,
  writeRunOutcomeProvisional,
  writeRunProgress,
  type MonitorDbExecutor,
} from './writes.ts'
import { MON_HOST } from './env.ts'
import type { ResultSetHeader } from 'mysql2/promise'

function ident(overrides: Partial<{ runId: string; ticket: string; kind: 'bug' | 'demand' }> = {}) {
  return { runId: 'run-1', ticket: 'FAQ-1', kind: 'bug' as const, ...overrides }
}

describe('writeRunProgress（W1，形狀 A）', () => {
  test('queued 之後 running：兩次呼叫都成功，rank 單調前進，欄位補齊', async () => {
    const db = new FakeRunsDb()
    const r1 = await writeRunProgress(db, { ...ident(), lifecycleRank: 10 })
    expect(r1.kind).toBe('inserted')
    const r2 = await writeRunProgress(db, {
      ...ident(),
      lifecycleRank: 30,
      pid: 4321,
      startedAt: '2026-09-02T00:00:00.000Z',
      stdoutPath: '/tmp/run-1.stdout.log',
      stderrPath: '/tmp/run-1.stderr.log',
      triggeredByEmail: 'a@b.com',
      triggeredByName: 'A B',
    })
    expect(r2.kind).toBe('applied')
    const row = db.rows.get('run-1')!
    expect(row.lifecycle_rank).toBe(30)
    expect(row.pid).toBe(4321)
    expect(row.stdout_path).toBe('/tmp/run-1.stdout.log')
    expect(row.stderr_path).toBe('/tmp/run-1.stderr.log')
    expect(row.triggered_by_email).toBe('a@b.com')
    expect(row.triggered_by_name).toBe('A B')
  })

  test('lifecycle rank 後退寫入 → guarded_rank，值不變', async () => {
    const db = new FakeRunsDb()
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30 })
    const before = { ...db.rows.get('run-1')! }
    const r = await writeRunProgress(db, { ...ident(), lifecycleRank: 10 })
    expect(r).toEqual({ kind: 'guarded', guardedReason: 'guarded_rank' })
    expect(db.rows.get('run-1')).toEqual(before)
  })

  test('host 不符 → r1_violation（W1 那一條，【G:MJ-E1】）', async () => {
    const db = new FakeRunsDb()
    db.rows.set('run-1', {
      run_id: 'run-1',
      host: 'some-other-host',
      ticket: 'FAQ-1',
      kind: 'bug',
      lifecycle_rank: 30,
      started_at: null,
      pid: null,
      stdout_path: null,
      stderr_path: null,
      trigger_source: null,
      retry_of_run_id: null,
      dispatch_id: null,
      legacy_key: null,
      triggered_by_email: null,
      triggered_by_name: null,
      outcome: null,
      outcome_tier: null,
      outcome_source: null,
      finished_at: null,
      exit_code: null,
      cancel_requested_at: null,
      cancel_resolved_by: null,
    })
    const r = await writeRunProgress(db, { ...ident(), lifecycleRank: 30 })
    expect(r).toEqual({ kind: 'guarded', guardedReason: 'r1_violation' })
  })

  test('終態 UPDATE 先於 running INSERT 抵達 → 最終列＝finished，且 W1 補齊 started_at/pid（COALESCE 只補空欄）', async () => {
    const db = new FakeRunsDb()
    await writeRunOutcomeAuthoritative(db, {
      ...ident(),
      outcome: 'success',
      outcomeSource: 'exit_trap',
      finishedAt: '2026-09-02T00:05:00.000Z',
      exitCode: 0,
    })
    const afterW2 = db.rows.get('run-1')!
    expect(afterW2.lifecycle_rank).toBe(100)
    expect(afterW2.outcome).toBe('success')

    const r = await writeRunProgress(db, { ...ident(), lifecycleRank: 30, pid: 999, startedAt: '2026-09-02T00:00:00.000Z' })
    // W2 已經把 outcome 定案，W1 的 lifecycle_rank 用 GREATEST 不會把 100 拉回 30；
    // 但 started_at/pid 從 NULL 被 COALESCE 補上，仍算「有變更」→ applied（affectedRows=2）。
    expect(r.kind).toBe('applied')
    const row = db.rows.get('run-1')!
    expect(row.lifecycle_rank).toBe(100) // 不被拉回
    expect(row.outcome).toBe('success') // 終態不受影響
  })
})

describe("writeRunOutcomeAuthoritative（W2，tier 2）與 writeRunOutcomeProvisional（W3，tier 1）— R3' / BL-C1", () => {
  test('暫定終態（tier1）→ 權威終態（tier2）覆寫成功，且標記 supersededProvisional', async () => {
    const db = new FakeRunsDb()
    await writeRunOutcomeProvisional(db, { ...ident(), outcome: 'unknown_no_writer', outcomeSource: 'sweeper', finishedAt: '2026-09-02T00:01:00.000Z' })
    expect(db.rows.get('run-1')!.outcome_tier).toBe(1)

    const r = await writeRunOutcomeAuthoritative(db, {
      ...ident(),
      outcome: 'success',
      outcomeSource: 'exit_trap',
      finishedAt: '2026-09-02T00:02:00.000Z',
      exitCode: 0,
    })
    expect(r.kind).toBe('applied')
    expect(r.supersededProvisional).toBe(true)
    expect(db.rows.get('run-1')!.outcome).toBe('success')
    expect(db.rows.get('run-1')!.outcome_tier).toBe(2)
  })

  test('權威終態 → 權威終態不覆寫（先到先定）', async () => {
    const db = new FakeRunsDb()
    await writeRunOutcomeAuthoritative(db, { ...ident(), outcome: 'success', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:01:00.000Z' })
    const before = { ...db.rows.get('run-1')! }
    const r = await writeRunOutcomeAuthoritative(db, { ...ident(), outcome: 'failed', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:02:00.000Z' })
    expect(r).toEqual({ kind: 'guarded', guardedReason: 'guarded_terminal' })
    expect(db.rows.get('run-1')).toEqual(before)
  })

  test('暫定終態 → 暫定終態不覆寫', async () => {
    const db = new FakeRunsDb()
    await writeRunOutcomeProvisional(db, { ...ident(), outcome: 'unknown_no_writer', outcomeSource: 'sweeper', finishedAt: '2026-09-02T00:01:00.000Z' })
    const before = { ...db.rows.get('run-1')! }
    const r = await writeRunOutcomeProvisional(db, { ...ident(), outcome: 'unknown_reaped', outcomeSource: 'reaper', finishedAt: '2026-09-02T00:02:00.000Z' })
    expect(r).toEqual({ kind: 'guarded', guardedReason: 'guarded_terminal' })
    expect(db.rows.get('run-1')).toEqual(before)
  })

  test('同一權威終態重放 3 次 → 欄位不變、每次都落在 guarded_terminal', async () => {
    const db = new FakeRunsDb()
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30 }) // 先有一個 running 列，模擬正常時序
    const input = { ...ident(), outcome: 'success', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:01:00.000Z', exitCode: 0 }
    const first = await writeRunOutcomeAuthoritative(db, input)
    expect(first.kind).toBe('applied')
    const snapshot = { ...db.rows.get('run-1')! }
    for (let i = 0; i < 3; i++) {
      const r = await writeRunOutcomeAuthoritative(db, input)
      expect(r).toEqual({ kind: 'guarded', guardedReason: 'guarded_terminal' })
      expect(db.rows.get('run-1')).toEqual(snapshot)
    }
  })

  test('host 不符 → r1_violation（W2 那一條，【G:MJ-E1】的兩條測試之二）', async () => {
    const db = new FakeRunsDb()
    db.rows.set('run-1', {
      run_id: 'run-1',
      host: 'some-other-host',
      ticket: 'FAQ-1',
      kind: 'bug',
      lifecycle_rank: 30,
      started_at: null,
      pid: null,
      stdout_path: null,
      stderr_path: null,
      trigger_source: null,
      retry_of_run_id: null,
      dispatch_id: null,
      legacy_key: null,
      triggered_by_email: null,
      triggered_by_name: null,
      outcome: null,
      outcome_tier: null,
      outcome_source: null,
      finished_at: null,
      exit_code: null,
      cancel_requested_at: null,
      cancel_resolved_by: null,
    })
    const r = await writeRunOutcomeAuthoritative(db, { ...ident(), outcome: 'success', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:01:00.000Z' })
    expect(r).toEqual({ kind: 'guarded', guardedReason: 'r1_violation' })
  })

  test('W2 insert-fallback：run_id 完全不存在時直接建出終態列（tier 2）', async () => {
    const db = new FakeRunsDb()
    const r = await writeRunOutcomeAuthoritative(db, {
      ...ident({ runId: 'run-fresh' }),
      outcome: 'spawn_error',
      outcomeSource: 'spawn_failed',
      finishedAt: '2026-09-02T00:00:00.000Z',
    })
    expect(r).toEqual({ kind: 'inserted' })
    const row = db.rows.get('run-fresh')!
    expect(row.outcome).toBe('spawn_error')
    expect(row.outcome_tier).toBe(2)
    expect(row.lifecycle_rank).toBe(100)
  })

  // 2026-09-03 根因修復（見 switch-readiness.ts C4/C6 持續性缺口）：模擬「W1
  // 完全遺失（server 崩潰窄縫），只有 W2 INSERT fallback 路徑執行」的真實情境
  // ——run_id 在 runs 表完全不存在，直接進 W2_INSERT_SQL。呼叫端（
  // post-run-notify.ts）本來就知道 legacyKey/stdoutPath/stderrPath/startedAt，
  // 這裡驗證 writeRunOutcomeAuthoritative 真的會把四者寫進新建的列，不再永遠
  // 留 NULL（legacy_key/stdout_path/stderr_path 三欄的 NULL 導致 C4/C6 對不上
  // sqlite；started_at 留 NULL 則導致列被 RUNS_LIST_WHERE 整個濾掉，C4 依然
  // 看不到）。退回舊版 writes.ts（W2_INSERT_SQL 沒有這四欄、
  // WriteRunOutcomeAuthoritativeInput 沒有這四個欄位）時，這個測試會因為
  // legacyKey/stdoutPath/stderrPath/startedAt 根本不是合法輸入欄位（TS 編譯期）
  // 或即使硬塞進去也不會被 INSERT 到 row（執行期 FakeRunsDb 讀不到對應
  // params）而斷言失敗——見下方 test 附註的退版驗證紀錄。
  test('W2 insert-fallback（W1 遺失）：呼叫端提供的 legacyKey/stdoutPath/stderrPath/startedAt 要正確落地，不再永遠 NULL', async () => {
    const db = new FakeRunsDb()
    const r = await writeRunOutcomeAuthoritative(db, {
      ...ident({ runId: 'run-headless' }),
      ticket: 'FAQ-4865',
      outcome: 'infra_failure',
      outcomeSource: 'post-run-notify',
      finishedAt: '2026-09-03T03:44:27.630Z',
      exitCode: 1,
      legacyKey: 'FAQ-4865.2026-09-03T03-44-00-000Z',
      stdoutPath: '/Users/user/aladdin/telegram-dispatcher/logs/FAQ-4865.2026-09-03T03-44-00-000Z.stdout.log',
      stderrPath: '/Users/user/aladdin/telegram-dispatcher/logs/FAQ-4865.2026-09-03T03-44-00-000Z.stderr.log',
      startedAt: '2026-09-03T03:44:00.000Z',
    })
    expect(r).toEqual({ kind: 'inserted' })
    const row = db.rows.get('run-headless')!
    expect(row.legacy_key).toBe('FAQ-4865.2026-09-03T03-44-00-000Z')
    expect(row.stdout_path).toBe('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-4865.2026-09-03T03-44-00-000Z.stdout.log')
    expect(row.stderr_path).toBe('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-4865.2026-09-03T03-44-00-000Z.stderr.log')
    // dt()（isoToMysqlDatetime3OrNull）把 ISO 字串轉成 MySQL DATETIME(3) 字面格式
    // （空白分隔、無 T/Z）——writes.ts 檔頭已有說明，這裡驗證的是同一個轉換。
    expect(row.started_at).toBe('2026-09-03 03:44:00.000')
  })
})

describe('cancel：W4（旗標）／W5（遲到修正）— 三種到達順序都收斂到 cancelled', () => {
  test('旗標先到（run 還在 running）：W2 寫終態時在同一語句內合成成 cancelled', async () => {
    const db = new FakeRunsDb()
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30 })
    const flag = await writeCancelFlag(db, { ...ident(), cancelRequestedAt: '2026-09-02T00:01:00.000Z', resolvedBy: 'pid_match' })
    expect(flag.kind).toBe('applied')
    const outcome = await writeRunOutcomeAuthoritative(db, { ...ident(), outcome: 'infra_failure', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:02:00.000Z', exitCode: 143 })
    expect(outcome.kind).toBe('applied')
    expect(db.rows.get('run-1')!.outcome).toBe('cancelled')
  })

  test('旗標晚到（run 已經以 infra_failure 收尾）：W5 把它改正為 cancelled', async () => {
    const db = new FakeRunsDb()
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30 })
    await writeRunOutcomeAuthoritative(db, { ...ident(), outcome: 'infra_failure', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:02:00.000Z', exitCode: 143 })
    expect(db.rows.get('run-1')!.outcome).toBe('infra_failure')

    const flag = await writeCancelFlag(db, { ...ident(), cancelRequestedAt: '2026-09-02T00:03:00.000Z', resolvedBy: 'marker' })
    expect(flag.kind).toBe('applied') // 列已存在，W4a 命中

    const fix = await fixCancelLateOutcome(db, 'run-1')
    expect(fix.kind).toBe('applied')
    expect(db.rows.get('run-1')!.outcome).toBe('cancelled')
  })

  test('W5 重放兩次（冪等）：第一次修正，第二次守衛擋下（outcome 已不是 infra_failure）', async () => {
    const db = new FakeRunsDb()
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30 })
    await writeRunOutcomeAuthoritative(db, { ...ident(), outcome: 'infra_failure', outcomeSource: 'exit_trap', finishedAt: '2026-09-02T00:02:00.000Z' })
    await writeCancelFlag(db, { ...ident(), cancelRequestedAt: '2026-09-02T00:03:00.000Z', resolvedBy: 'marker' })

    const first = await fixCancelLateOutcome(db, 'run-1')
    expect(first.kind).toBe('applied')
    const second = await fixCancelLateOutcome(db, 'run-1')
    expect(second).toEqual({ kind: 'guarded', guardedReason: 'guarded_other' })
    expect(db.rows.get('run-1')!.outcome).toBe('cancelled')
  })

  test('W4b：旗標先於任何 W1/W2 抵達 → 建最小佔位列（rank=10，outcome 仍為 NULL）', async () => {
    const db = new FakeRunsDb()
    const flag = await writeCancelFlag(db, { ...ident(), cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'placeholder', legacyKey: 'FAQ-1.2026-09-02T00:00:00.000Z' })
    expect(flag.kind).toBe('inserted')
    const row = db.rows.get('run-1')!
    expect(row.lifecycle_rank).toBe(10)
    expect(row.outcome).toBeNull()
    expect(row.cancel_requested_at).toBe('2026-09-02 00:00:00.000')

    // W1 隨後抵達，把佔位列補成正常 running 列，旗標不受影響（W1 的八條賦值裡沒有 cancel_requested_at）。
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30, pid: 111 })
    const after = db.rows.get('run-1')!
    expect(after.lifecycle_rank).toBe(30)
    expect(after.cancel_requested_at).toBe('2026-09-02 00:00:00.000')
  })

  test('cancel 旗標的 COALESCE 冪等：重放兩次不覆寫第一次的 resolvedBy/時間', async () => {
    const db = new FakeRunsDb()
    await writeRunProgress(db, { ...ident(), lifecycleRank: 30 })
    await writeCancelFlag(db, { ...ident(), cancelRequestedAt: '2026-09-02T00:01:00.000Z', resolvedBy: 'pid_match' })
    await writeCancelFlag(db, { ...ident(), cancelRequestedAt: '2026-09-02T00:99:00.000Z', resolvedBy: 'placeholder' })
    const row = db.rows.get('run-1')!
    expect(row.cancel_requested_at).toBe('2026-09-02 00:01:00.000')
    expect(row.cancel_resolved_by).toBe('pid_match')
  })
})

describe('MON_HOST：runs 寫入函式一律不接受呼叫端傳入的 host（【G:MJ-E1】型別擋）', () => {
  test('MON_HOST 是模組載入時決定的固定字串', () => {
    expect(typeof MON_HOST).toBe('string')
    expect(MON_HOST.length).toBeGreaterThan(0)
  })

  test('靜態掃描：writes.ts 內 runs 寫入函式的公開輸入型別不含 host 欄位', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./writes.ts', import.meta.url), 'utf8')
    // 抓出所有 `export interface Write*Input extends RunIdentity { ... }` 區塊，
    // 斷言區塊內文字不含 `host`（不分大小寫的欄位名）。
    const blocks = [...source.matchAll(/export interface (Write\w*Input) extends RunIdentity \{([^}]*)\}/g)]
    expect(blocks.length).toBeGreaterThan(0)
    for (const [, name, body] of blocks) {
      expect(body).not.toMatch(/\bhost\s*[:?]/i)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// dispatch_attempts（§5.3）：整合修補——advanceDispatchAttempt 補
// worker_name/worker_url（2C 回報：confirm 後永遠 NULL）。
// ─────────────────────────────────────────────────────────────────────────

interface FakeDispatchRow {
  dispatch_id: string
  status: string
  status_rank: number
  confirmed_at: string | null
  cleared_at: string | null
  clear_reason: string | null
  remote_run_id: string | null
  worker_name: string | null
  worker_url: string | null
}

// MA-2 教訓（review-final-A-dispatcher.md）：**假 DB 比被測 SQL 寬鬆等於沒測**
// ——舊版對 remote_run_id 寫的是 COALESCE 語意而真 SQL 是 plain 賦值、且完全沒
// 模型 confirmed_at，於是「job_done advance 抹掉 confirmed_at/remote_run_id」
// 在測試裡恆綠、在真 DB 上 2/2 列中招。本 fake 現在**逐字對照**
// DISPATCH_ATTEMPT_ADVANCE_SQL 的每一條賦值；改 SQL 時必須同步改這裡，SQL 的
// 形狀本身另由下方「SQL 文字釘」測試把 COALESCE 子句釘死（fake 以 sql 字串
// 全等分派，SQL 被改壞時 fake 不會自己發現）。
class FakeDispatchAttemptsDb implements MonitorDbExecutor {
  rows = new Map<string, FakeDispatchRow>()

  async execute<T = ResultSetHeader>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    if (sql === DISPATCH_ATTEMPT_INSERT_SQL) {
      const [dispatchId, , , , , status, statusRank] = params as [string, string, string, string | null, string | null, string, number]
      this.rows.set(dispatchId, {
        dispatch_id: dispatchId,
        status,
        status_rank: statusRank,
        confirmed_at: null,
        cleared_at: null,
        clear_reason: null,
        remote_run_id: null,
        worker_name: null,
        worker_url: null,
      })
      return [{ affectedRows: 1 } as unknown as T, []]
    }
    if (sql === DISPATCH_ATTEMPT_ADVANCE_SQL) {
      const [status, statusRank, confirmedAt, clearedAt, clearReason, remoteRunId, workerName, workerUrl, dispatchId, guardRank] = params as [
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        number,
      ]
      const row = this.rows.get(dispatchId)
      if (!row || !(row.status_rank < guardRank)) {
        return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' } as unknown as T, []]
      }
      // 與 SQL 逐條對照：status/status_rank plain 賦值，其餘八欄 COALESCE(col, ?)。
      row.status = status
      row.status_rank = statusRank
      row.confirmed_at = row.confirmed_at ?? confirmedAt
      row.cleared_at = row.cleared_at ?? clearedAt
      row.clear_reason = row.clear_reason ?? clearReason
      row.remote_run_id = row.remote_run_id ?? remoteRunId
      row.worker_name = row.worker_name ?? workerName
      row.worker_url = row.worker_url ?? workerUrl
      return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' } as unknown as T, []]
    }
    throw new Error(`FakeDispatchAttemptsDb: 未預期的 SQL：${sql}`)
  }
}

describe('advanceDispatchAttempt — worker_name/worker_url（整合修補：2C 回報缺口）', () => {
  test('advance(dispatched) 帶 workerName/workerUrl → 落庫，不再永遠 NULL', async () => {
    const db = new FakeDispatchAttemptsDb()
    await createDispatchAttempt(db, { dispatchId: 'd-1', ticket: 'FAQ-1', kind: 'bug', status: 'dispatching', statusRank: 10 })
    const r = await advanceDispatchAttempt(db, {
      dispatchId: 'd-1',
      status: 'dispatched',
      statusRank: 20,
      workerName: 'w1',
      workerUrl: 'http://10.0.0.1:8801',
    })
    expect(r.kind).toBe('applied')
    expect(db.rows.get('d-1')!.worker_name).toBe('w1')
    expect(db.rows.get('d-1')!.worker_url).toBe('http://10.0.0.1:8801')
  })

  test('後續 advance(cleared) 未帶 worker 資訊 → COALESCE 不清空既有值', async () => {
    const db = new FakeDispatchAttemptsDb()
    await createDispatchAttempt(db, { dispatchId: 'd-1', ticket: 'FAQ-1', kind: 'bug', status: 'dispatching', statusRank: 10 })
    await advanceDispatchAttempt(db, { dispatchId: 'd-1', status: 'dispatched', statusRank: 20, workerName: 'w1', workerUrl: 'http://10.0.0.1:8801' })
    const r = await advanceDispatchAttempt(db, { dispatchId: 'd-1', status: 'cleared', statusRank: 100, clearReason: 'exception' })
    expect(r.kind).toBe('applied')
    expect(db.rows.get('d-1')!.worker_name).toBe('w1')
    expect(db.rows.get('d-1')!.worker_url).toBe('http://10.0.0.1:8801')
  })

  // ── MA-2 迴歸（review-final-A-dispatcher.md）：dispatched 寫好的
  // confirmed_at/remote_run_id 不得被 job_done 的 advance 抹回 NULL ──
  test('MA-2：dispatched 帶 confirmedAt/remoteRunId → job_done 只帶 clearedAt/clearReason → 前者保留、後者寫入', async () => {
    const db = new FakeDispatchAttemptsDb()
    await createDispatchAttempt(db, { dispatchId: 'd-2', ticket: 'FAQ-2', kind: 'bug', status: 'dispatching', statusRank: 10 })
    await advanceDispatchAttempt(db, {
      dispatchId: 'd-2',
      status: 'dispatched',
      statusRank: 20,
      confirmedAt: '2026-09-03T01:00:00.000Z',
      remoteRunId: 'run-remote-1',
      workerName: 'w1',
      workerUrl: 'http://10.0.0.1:8801',
    })
    const r = await advanceDispatchAttempt(db, {
      dispatchId: 'd-2',
      status: 'cleared',
      statusRank: 100,
      clearedAt: '2026-09-03T02:00:00.000Z',
      clearReason: 'job_done',
    })
    expect(r.kind).toBe('applied')
    const row = db.rows.get('d-2')!
    expect(row.confirmed_at).toBe('2026-09-03 01:00:00.000') // dt() 轉 mysql 格式後保留，不被 NULL 抹掉
    expect(row.remote_run_id).toBe('run-remote-1')
    expect(row.cleared_at).toBe('2026-09-03 02:00:00.000')
    expect(row.clear_reason).toBe('job_done')
  })

  // fake 以 sql 字串全等分派、行為寫死——SQL 被改回 plain 賦值時 fake 不會自己
  // 變紅，所以 COALESCE 子句用 SQL 文字直接釘住（MA-2 教訓：假 DB 比真 SQL
  // 寬鬆等於沒測，防線必須釘在真 SQL 的形狀上）。
  test('MA-2 SQL 文字釘：八個選填欄全部是 COALESCE(col, ?)，一次寫定', () => {
    for (const col of ['confirmed_at', 'cleared_at', 'clear_reason', 'remote_run_id', 'worker_name', 'worker_url']) {
      expect(DISPATCH_ATTEMPT_ADVANCE_SQL).toContain(`${col} = COALESCE(${col}, ?)`)
    }
  })
})
