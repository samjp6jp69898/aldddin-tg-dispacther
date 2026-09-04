import { describe, expect, mock, test } from 'bun:test'
import { unlinkSync, writeFileSync } from 'node:fs'
import { checkPushMismatch, shouldNotify, parseRunningBugTickets, writeAuthoritativeOutcome } from './post-run-notify.ts'
import { FakeRunsDb } from '../monitor-db/test-support/fake-runs-db.ts'
import { __resetDeclaredMonitorRoleForTest, declareMonitorRole } from '../monitor-db/env.ts'
import type { SpoolEntry } from '../monitor-db/spool/types.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'

/** 假 spool writer：只記錄 append 呼叫，不碰真的檔案系統。 */
function makeFakeSpool() {
  const appended: Array<Omit<SpoolEntry, 'seq'>> = []
  return {
    appended,
    append: (e: Omit<SpoolEntry, 'seq'>) => appended.push(e),
    appendBatch: (es: Array<Omit<SpoolEntry, 'seq'>>) => appended.push(...es),
    filePath: () => '/tmp/fake-spool-test.jsonl',
    close: () => {},
  }
}

describe('writeAuthoritativeOutcome — v3.2 §9 Phase2 bug 終態（權威）寫入點', () => {
  test('process.env.MON_RUN_ID 為空 → 完全不寫、不落 spool（即使帶了假 deps）', async () => {
    const prev = process.env.MON_RUN_ID
    delete process.env.MON_RUN_ID
    try {
      const fakeDb = new FakeRunsDb()
      const fakeSpool = makeFakeSpool()
      await writeAuthoritativeOutcome('FAQ-9001', 'success', 0, '/tmp/FAQ-9001.stdout.log', '/tmp/FAQ-9001.stderr.log', { pool: fakeDb, spool: fakeSpool })
      expect(fakeDb.calls.length).toBe(0)
      expect(fakeSpool.appended.length).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prev
    }
  })

  test('有 run_id、pool 正常 → 直接寫入 W2（不落 spool）', async () => {
    const prev = process.env.MON_RUN_ID
    process.env.MON_RUN_ID = '11111111-1111-1111-1111-111111111111'
    try {
      const fakeDb = new FakeRunsDb()
      const fakeSpool = makeFakeSpool()
      const stdoutPath = '/Users/user/aladdin/telegram-dispatcher/logs/FAQ-9002.2026-09-03T00-00-00-000Z.stdout.log'
      const stderrPath = '/Users/user/aladdin/telegram-dispatcher/logs/FAQ-9002.2026-09-03T00-00-00-000Z.stderr.log'
      await writeAuthoritativeOutcome('FAQ-9002', 'infra_failure', 1, stdoutPath, stderrPath, { pool: fakeDb, spool: fakeSpool })
      const row = fakeDb.rows.get('11111111-1111-1111-1111-111111111111')
      expect(row).not.toBeUndefined()
      expect(row!.outcome).toBe('infra_failure')
      expect(row!.outcome_tier).toBe(2)
      expect(row!.exit_code).toBe(1)
      // 2026-09-03 根因修復：run_id 在 FakeRunsDb 裡完全不存在 → W2 走 INSERT
      // fallback（模擬 W1 遺失的真實情境），legacy_key/stdout_path/stderr_path
      // 要跟著這次寫入正確落地，不再永遠 NULL（見 writes.ts W2_INSERT_SQL）。
      // started_at 也要能從 stdoutPath 檔名時間戳反推（不然 RUNS_LIST_WHERE
      // 會把這列從 pipelineRuns()／C4 的讀取結果整個濾掉，見同一份修復）。
      expect(row!.legacy_key).toBe('FAQ-9002.2026-09-03T00-00-00-000Z')
      expect(row!.stdout_path).toBe(stdoutPath)
      expect(row!.stderr_path).toBe(stderrPath)
      // dt()（isoToMysqlDatetime3OrNull）把 ISO 字串轉成 MySQL DATETIME(3) 字面格式
      // （空白分隔、無 T/Z）。
      expect(row!.started_at).toBe('2026-09-03 00:00:00.000')
      expect(fakeSpool.appended.length).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prev
    }
  })

  test('pool 為 null（模擬連線建立失敗）→ 落 spool，條目帶正確的 run_id/fn', async () => {
    const prev = process.env.MON_RUN_ID
    process.env.MON_RUN_ID = '22222222-2222-2222-2222-222222222222'
    try {
      const fakeSpool = makeFakeSpool()
      await writeAuthoritativeOutcome('FAQ-9003', 'timeout', 124, '/tmp/FAQ-9003.stdout.log', '/tmp/FAQ-9003.stderr.log', { pool: null, spool: fakeSpool })
      expect(fakeSpool.appended.length).toBe(1)
      expect(fakeSpool.appended[0]!.run_id).toBe('22222222-2222-2222-2222-222222222222')
      expect(fakeSpool.appended[0]!.fn).toBe('writeRunOutcomeAuthoritative')
      expect((fakeSpool.appended[0]!.args[0] as { outcome: string }).outcome).toBe('timeout')
    } finally {
      if (prev === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prev
    }
  })

  // 2026-09-03 稽核：過去 24 小時 8 次 FAQ 票的 post-run-notify.log 都留下
  // 「監控 DB 連線建立失敗: Error: loadMonitorEnv: 角色不符...」——即
  // createMonitorPool() 內的 loadMonitorEnv(expectedRole) 因 .env 的
  // MON_DB_USER 跟呼叫端要求的角色不符而同步 throw（見 env.ts 該檢查）。
  // 上面「pool 為 null」測試直接注入 `deps.pool: null`，繞過了 writeAuthoritativeOutcome
  // 內部真正的 try/catch（304-315 行，圍住 dynamic import + createMonitorPool()
  // 呼叫）；本測試刻意不傳 `deps.pool`，讓函式走真正的 dynamic import 分支，
  // 用真的環境變數角色不符（不動 .env 檔本身，只在測試期間暫時覆寫
  // process.env 後還原）觸發跟生產環境逐字相同的例外，驗證這條 try/catch →
  // pool 維持 null → else 分支落 spool 的整合路徑沒有被繞過、資料真的落地。
  // 刻意不用 mock.module 掉 pool.ts：pool.test.ts／semantic-verify.test.ts
  // 在同一次 `bun test` 行程內依賴同一個 module 的真實 createMonitorPool，
  // 全域 mock 會互相污染（見 whitelist-auto-sync-trigger.test.ts 檔頭同類警示）。
  test('createMonitorPool() 真的 throw（模擬真實 MON_DB_USER 角色不符，不注入 deps.pool）→ 仍落 spool，資料不遺失', async () => {
    const prevRunId = process.env.MON_RUN_ID
    const prevUser = process.env.MON_DB_USER
    const prevWorker = process.env.CLUSTER_WORKER_NAME
    process.env.MON_RUN_ID = '66666666-6666-6666-6666-666666666666'
    delete process.env.CLUSTER_WORKER_NAME // 確保走 mon_head 分支（跟 head 機器的真實情境一致）
    process.env.MON_DB_USER = 'mon_exec' // 故意跟 mon_head 角色不符——重現 8 次事故的真實錯誤
    try {
      const fakeSpool = makeFakeSpool()
      // 刻意只傳 deps.spool、不傳 deps.pool：函式因此會真的執行
      // `await import('../monitor-db/pool.ts')` + `createMonitorPool()`，
      // 而不是被測試直接繞過。
      await writeAuthoritativeOutcome('FAQ-9007', 'timeout', 124, '/tmp/FAQ-9007.stdout.log', '/tmp/FAQ-9007.stderr.log', { spool: fakeSpool })
      expect(fakeSpool.appended.length).toBe(1)
      expect(fakeSpool.appended[0]!.run_id).toBe('66666666-6666-6666-6666-666666666666')
      expect(fakeSpool.appended[0]!.fn).toBe('writeRunOutcomeAuthoritative')
      expect((fakeSpool.appended[0]!.args[0] as { outcome: string }).outcome).toBe('timeout')
    } finally {
      if (prevRunId === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prevRunId
      if (prevUser === undefined) delete process.env.MON_DB_USER
      else process.env.MON_DB_USER = prevUser
      if (prevWorker === undefined) delete process.env.CLUSTER_WORKER_NAME
      else process.env.CLUSTER_WORKER_NAME = prevWorker
    }
  })

  // 2026-09-03 回歸測試：main() 在最早執行處呼叫 declareMonitorRole('mon_head')
  // 之後（見本檔 main()），writeAuthoritativeOutcome 內的角色判斷（現已改用
  // monitorRoleForThisHost()）即使遇到 CLUSTER_WORKER_NAME 被汙染成非空字串，
  // 也必須固定回報 mon_head，不能再被嗅探結果覆蓋——這裡直接呼叫
  // declareMonitorRole('mon_head') 模擬 main() 的宣告時序，驗證的是
  // writeAuthoritativeOutcome 實際會執行到的同一段程式碼路徑（跟上面
  // 「createMonitorPool() 真的 throw」測試同一套手法：故意讓 MON_DB_USER 跟
  // 「若角色被嗅探成 mon_exec」時會相符的值不一致，藉由 loadMonitorEnv 的
  // expectedRole 同步檢查間接證明實際解析出的角色是 mon_head，不是 mon_exec
  // ——若角色判斷退回嗅探（CLUSTER_WORKER_NAME 非空 → mon_exec），
  // MON_DB_USER='mon_exec' 會通過角色比對、不觸發這個例外，落 spool 的行為
  // 就不會發生，測試會失敗，藉此把「宣告優先於嗅探」的保證落到這支 CLI 的
  // 實際程式碼路徑上，不只是 runtime.ts/env.ts 的通用單元測試）。
  test('main() 已宣告 mon_head 後：即使 CLUSTER_WORKER_NAME 被汙染成非空字串，角色判斷仍固定回報 mon_head', async () => {
    const prevRunId = process.env.MON_RUN_ID
    const prevUser = process.env.MON_DB_USER
    const prevWorker = process.env.CLUSTER_WORKER_NAME
    __resetDeclaredMonitorRoleForTest()
    process.env.MON_RUN_ID = '77777777-7777-7777-7777-777777777777'
    process.env.CLUSTER_WORKER_NAME = 'polluted-worker-name' // 模擬環境變數污染
    process.env.MON_DB_USER = 'mon_exec' // 若角色仍被嗅探成 mon_exec，這裡會「相符」、不觸發下面的例外
    declareMonitorRole('mon_head') // 模擬 main() 在最早執行處已做過的宣告
    try {
      const fakeSpool = makeFakeSpool()
      // 刻意只傳 deps.spool、不傳 deps.pool：函式真的執行
      // createMonitorPool(monitorRoleForThisHost(), ...)，不是被測試繞過。
      await writeAuthoritativeOutcome('FAQ-9008', 'timeout', 124, '/tmp/FAQ-9008.stdout.log', '/tmp/FAQ-9008.stderr.log', { spool: fakeSpool })
      // 角色正確解析為 mon_head（跟 MON_DB_USER='mon_exec' 不符）→
      // loadMonitorEnv 同步拋出「角色不符」→ 外層 catch 把 pool 留在 null →
      // 落 spool。若角色錯誤解析成 mon_exec，這個 spool 條目就不會出現。
      expect(fakeSpool.appended.length).toBe(1)
      expect(fakeSpool.appended[0]!.run_id).toBe('77777777-7777-7777-7777-777777777777')
      expect(fakeSpool.appended[0]!.fn).toBe('writeRunOutcomeAuthoritative')
    } finally {
      if (prevRunId === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prevRunId
      if (prevUser === undefined) delete process.env.MON_DB_USER
      else process.env.MON_DB_USER = prevUser
      if (prevWorker === undefined) delete process.env.CLUSTER_WORKER_NAME
      else process.env.CLUSTER_WORKER_NAME = prevWorker
      __resetDeclaredMonitorRoleForTest()
    }
  })

  test('pool.execute 丟例外 → 落 spool（不是直接讓例外往外拋，best-effort）', async () => {
    const prev = process.env.MON_RUN_ID
    process.env.MON_RUN_ID = '33333333-3333-3333-3333-333333333333'
    try {
      const throwingPool = { execute: async () => Promise.reject(new Error('連線斷了')) }
      const fakeSpool = makeFakeSpool()
      await expect(
        writeAuthoritativeOutcome('FAQ-9004', 'cli_failure', 1, '/tmp/FAQ-9004.stdout.log', '/tmp/FAQ-9004.stderr.log', { pool: throwingPool, spool: fakeSpool }),
      ).resolves.toBeUndefined()
      expect(fakeSpool.appended.length).toBe(1)
      expect(fakeSpool.appended[0]!.run_id).toBe('33333333-3333-3333-3333-333333333333')
    } finally {
      if (prev === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prev
    }
  })

  // 2026-09-03 根因修復：補列路徑（W1 遺失、走 W2 INSERT fallback）原本完全
  // 沒讀 `logs/<legacy_key>.triggered-by.json`，即使該檔跟 stdout/stderr log
  // 同一個 key 前綴、資料齊全——見 readTriggeredBy（post-run-notify.ts）。
  test('triggered-by.json 存在（事後補列情境）→ trigger_source/triggered_by_email/triggered_by_name 正確填值', async () => {
    const prev = process.env.MON_RUN_ID
    process.env.MON_RUN_ID = '44444444-4444-4444-4444-444444444444'
    const legacyKey = 'FAQ-9005.2026-09-03T00-00-01-000Z'
    const stdoutPath = `${LOG_DIR}/${legacyKey}.stdout.log`
    const stderrPath = `${LOG_DIR}/${legacyKey}.stderr.log`
    const triggeredByPath = `${LOG_DIR}/${legacyKey}.triggered-by.json`
    writeFileSync(triggeredByPath, JSON.stringify({ name: '測試員', email: 'tester@example.com', at: new Date().toISOString() }))
    try {
      const fakeDb = new FakeRunsDb()
      const fakeSpool = makeFakeSpool()
      await writeAuthoritativeOutcome('FAQ-9005', 'infra_failure', 1, stdoutPath, stderrPath, { pool: fakeDb, spool: fakeSpool })
      const row = fakeDb.rows.get('44444444-4444-4444-4444-444444444444')
      expect(row).not.toBeUndefined()
      expect(row!.trigger_source).toBe('telegram')
      expect(row!.triggered_by_email).toBe('tester@example.com')
      expect(row!.triggered_by_name).toBe('測試員')
    } finally {
      unlinkSync(triggeredByPath)
      if (prev === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prev
    }
  })

  test('triggered-by.json 不存在（例如本來就是 cli 觸發）→ 三欄維持 NULL，不拋錯、不誤植假值', async () => {
    const prev = process.env.MON_RUN_ID
    process.env.MON_RUN_ID = '55555555-5555-5555-5555-555555555555'
    const legacyKey = 'FAQ-9006.2026-09-03T00-00-02-000Z'
    const stdoutPath = `${LOG_DIR}/${legacyKey}.stdout.log`
    const stderrPath = `${LOG_DIR}/${legacyKey}.stderr.log`
    try {
      const fakeDb = new FakeRunsDb()
      const fakeSpool = makeFakeSpool()
      await expect(writeAuthoritativeOutcome('FAQ-9006', 'infra_failure', 1, stdoutPath, stderrPath, { pool: fakeDb, spool: fakeSpool })).resolves.toBeUndefined()
      const row = fakeDb.rows.get('55555555-5555-5555-5555-555555555555')
      expect(row).not.toBeUndefined()
      expect(row!.trigger_source).toBeNull()
      expect(row!.triggered_by_email).toBeNull()
      expect(row!.triggered_by_name).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prev
    }
  })
})

describe('shouldNotify — T13 補發通知範圍（2026-08-14 使用者定案，見 tasks.json changelog）', () => {
  test('create-mr 自己已通知/已留言過的三類，不重複發', () => {
    expect(shouldNotify('success')).toBe(false)
    expect(shouldNotify('needs_qa_clarification')).toBe(false)
    expect(shouldNotify('failed')).toBe(false)
  })

  test('create-mr 完全沒機會通知的五類，補發', () => {
    expect(shouldNotify('skipped')).toBe(true)
    expect(shouldNotify('unknown_failure')).toBe(true)
    expect(shouldNotify('timeout')).toBe(true)
    expect(shouldNotify('infra_failure')).toBe(true)
    expect(shouldNotify('cli_failure')).toBe(true)
  })
})

describe('checkPushMismatch — 2026-08-23：pipeline 回報 success 但 Notion AI分析=分析失敗 時通知 Landon', () => {
  test('classification 不是 success → 完全不查 Notion、不通知（例如 failed 自己就會走既有的補發判準)', () => {
    const getAiAnalysisStatus = mock((_t: string) => '分析失敗')
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-1', 'failed', 'out.log', 'err.log', { getAiAnalysisStatus, notify })
    expect(getAiAnalysisStatus).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  test('success 且 Notion AI分析=分析成功（一致）→ 不通知', () => {
    const getAiAnalysisStatus = mock((_t: string) => '分析成功')
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-1', 'success', 'out.log', 'err.log', { getAiAnalysisStatus, notify })
    expect(notify).not.toHaveBeenCalled()
  })

  test('success 但 Notion AI分析=分析失敗（不一致）→ 通知 Landon，內容含 ticket 與 log 路徑', () => {
    const getAiAnalysisStatus = mock((_t: string) => '分析失敗')
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-9999', 'success', '/tmp/x.stdout.log', '/tmp/x.stderr.log', { getAiAnalysisStatus, notify })
    expect(notify).toHaveBeenCalledTimes(1)
    const text = notify.mock.calls[0]![0]
    expect(text).toContain('FAQ-9999')
    expect(text).toContain('/tmp/x.stdout.log')
    expect(text).toContain('/tmp/x.stderr.log')
  })

  test('查詢 Notion 本身丟例外 → 只吞掉，不讓例外炸穿（best-effort，不阻斷 trap 裡的其他收尾）', () => {
    const getAiAnalysisStatus = mock((_t: string) => {
      throw new Error('Notion API 掛了')
    })
    const notify = mock((_t: string) => true)
    expect(() => checkPushMismatch('FAQ-1', 'success', 'out.log', 'err.log', { getAiAnalysisStatus, notify })).not.toThrow()
    expect(notify).not.toHaveBeenCalled()
  })

  test('查無 AI分析（null）→ 不通知（沒有明確不一致證據就不誤報）', () => {
    const getAiAnalysisStatus = mock((_t: string) => null)
    const notify = mock((_t: string) => true)
    checkPushMismatch('FAQ-1', 'success', 'out.log', 'err.log', { getAiAnalysisStatus, notify })
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('parseRunningBugTickets — 排除自己的 wrapper（2026-08-26 aladdin-05 review 抓到的真實 bug：自動重試永遠誤判自己在跑）', () => {
  test('excludePid 命中的那行（自己這輪的 wrapper bash，trap 執行期間仍活著）要被排除，即使 argv 命中 regex', () => {
    const selfPid = 56046
    const psOutput = [
      `${selfPid} bash -c trap "true" EXIT\\012sleep 3 run-create-mr FAQ-1234 /tmp/fake.log`,
      `70001 bash -c trap "true" EXIT\\012sleep 3 run-create-mr FAQ-5678 /tmp/other.log`,
      `1 /sbin/launchd`,
    ].join('\n')
    expect(parseRunningBugTickets(psOutput, selfPid)).toEqual(['FAQ-5678'])
  })

  test('excludePid 沒有命中任何行時，正常回傳全部匹配的票（不會誤刪不相干的行）', () => {
    const psOutput = [`70001 bash -c trap "true" EXIT\\012sleep 3 run-create-mr FAQ-5678 /tmp/other.log`].join('\n')
    expect(parseRunningBugTickets(psOutput, 99999)).toEqual(['FAQ-5678'])
  })

  test('沒有任何 bug pipeline wrapper 時回傳空陣列', () => {
    const psOutput = ['1 /sbin/launchd', '42 /usr/sbin/cron'].join('\n')
    expect(parseRunningBugTickets(psOutput, 99999)).toEqual([])
  })
})
