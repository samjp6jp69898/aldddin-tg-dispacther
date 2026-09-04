import { describe, expect, mock, test } from 'bun:test'
import { unlinkSync, writeFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPushMismatch, shouldNotify, parseRunningBugTickets, writeAuthoritativeOutcome, buildNotifyText, notifyAssigneeOrEscalate } from './post-run-notify.ts'
import type { Classification } from './classify-result.ts'
import { FakeRunsDb } from '../monitor-db/test-support/fake-runs-db.ts'
import { __resetDeclaredMonitorRoleForTest, declareMonitorRoleFromLocalEnv, getDeclaredMonitorRole } from '../monitor-db/env.ts'
import type { SpoolEntry } from '../monitor-db/spool/types.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const PROD_LOG = join(LOG_DIR, 'post-run-notify.log')

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
  test('createMonitorPool() 真的 throw（模擬真實 MON_DB_USER 角色不符，不注入 deps.pool）→ 仍落 spool，資料不遺失，且不污染生產 log', async () => {
    const prevRunId = process.env.MON_RUN_ID
    const prevUser = process.env.MON_DB_USER
    const prevWorker = process.env.CLUSTER_WORKER_NAME
    process.env.MON_RUN_ID = '66666666-6666-6666-6666-666666666666'
    delete process.env.CLUSTER_WORKER_NAME // 確保走 mon_head 分支（跟 head 機器的真實情境一致）
    process.env.MON_DB_USER = 'mon_exec' // 故意跟 mon_head 角色不符——重現 8 次事故的真實錯誤
    // 2026-09-04 污染源修復：這條測試會真的觸發 log() 呼叫（見下方
    // writeAuthoritativeOutcome 內的 catch），過去沒有可注入路徑時會真的寫進
    // 生產 post-run-notify.log（實測污染 19 筆）。改注入暫存路徑，驗證 (a)
    // 原本要測的落 spool 行為不變 (b) 生產 log 內容逐位元組不變。
    const tmpDir = mkdtempSync(join(tmpdir(), 'post-run-notify-log-'))
    const tmpLogPath = join(tmpDir, 'test.log')
    const prodLogBefore = existsSync(PROD_LOG) ? readFileSync(PROD_LOG, 'utf8') : null
    try {
      const fakeSpool = makeFakeSpool()
      // 刻意只傳 deps.spool、不傳 deps.pool：函式因此會真的執行
      // `await import('../monitor-db/pool.ts')` + `createMonitorPool()`，
      // 而不是被測試直接繞過。
      await writeAuthoritativeOutcome('FAQ-9007', 'timeout', 124, '/tmp/FAQ-9007.stdout.log', '/tmp/FAQ-9007.stderr.log', { spool: fakeSpool, logPath: tmpLogPath })
      expect(fakeSpool.appended.length).toBe(1)
      expect(fakeSpool.appended[0]!.run_id).toBe('66666666-6666-6666-6666-666666666666')
      expect(fakeSpool.appended[0]!.fn).toBe('writeRunOutcomeAuthoritative')
      expect((fakeSpool.appended[0]!.args[0] as { outcome: string }).outcome).toBe('timeout')
      // (a) log() 真的被呼叫過（不是路徑注入把整條路徑短路掉、測試變成沒測到東西）
      expect(existsSync(tmpLogPath)).toBe(true)
      expect(readFileSync(tmpLogPath, 'utf8')).toContain('FAQ-9007 監控 DB 連線建立失敗')
      // (b) 生產 log 完全沒有被寫入
      const prodLogAfter = existsSync(PROD_LOG) ? readFileSync(PROD_LOG, 'utf8') : null
      expect(prodLogAfter).toBe(prodLogBefore)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
      if (prevRunId === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prevRunId
      if (prevUser === undefined) delete process.env.MON_DB_USER
      else process.env.MON_DB_USER = prevUser
      if (prevWorker === undefined) delete process.env.CLUSTER_WORKER_NAME
      else process.env.CLUSTER_WORKER_NAME = prevWorker
    }
  })

  // 2026-09-04 回歸測試（ALDREQ-834 事故）：main() 過去在最早執行處寫死呼叫
  // declareMonitorRole('mon_head')，理由是「這支短命 CLI 固定只在 head 機器
  // 上跑」——但 dispatch.ts 的派工機制其實會把 bug pipeline 派去 worker
  // 執行，worker 上 .env 的 MON_DB_USER 是 mon_exec，跟寫死值不符，
  // loadMonitorEnv 的 expectedRole 斷言因此必然拋出、被 best-effort 吞掉，
  // 權威結果永遠寫不進 DB。main() 現已改呼叫 declareMonitorRoleFromLocalEnv()
  // （見 env.ts），依本機 .env 的 MON_DB_USER 判斷角色。main() 本身不是可
  // 匯出的函式，這裡直接呼叫 declareMonitorRoleFromLocalEnv() 模擬 main() 的
  // 宣告時序，驗證 writeAuthoritativeOutcome 實際會執行到的同一段程式碼路徑
  // 正確解析出 mon_exec（不是舊版寫死的 mon_head）。
  test('worker 環境（MON_DB_USER=mon_exec）→ main() 現在正確宣告 mon_exec，不再被寫死宣告成 mon_head，且不污染生產 log', async () => {
    const prevRunId = process.env.MON_RUN_ID
    const prevUser = process.env.MON_DB_USER
    const prevWorker = process.env.CLUSTER_WORKER_NAME
    const prevHost = process.env.MON_DB_HOST
    __resetDeclaredMonitorRoleForTest()
    process.env.MON_RUN_ID = '77777777-7777-7777-7777-777777777777'
    process.env.MON_DB_USER = 'mon_exec' // 真實案例：landon2 的 .env
    process.env.CLUSTER_WORKER_NAME = 'landon2'
    // 故意指到不可路由的位址：這則測試只關心角色宣告本身是否正確，不依賴
    // 任何真的 monitor DB 是否在跑——pool.ts 的 connectTimeout（500ms）讓
    // 連線嘗試確定性地快速失敗，不是靠等待解決正確性問題。
    process.env.MON_DB_HOST = '10.255.255.1'
    declareMonitorRoleFromLocalEnv() // 模擬 main() 在最早執行處已做過的宣告
    // 2026-09-04 污染源修復：同上一條測試理由，這條也會真的觸發 log()。
    const tmpDir = mkdtempSync(join(tmpdir(), 'post-run-notify-log-'))
    const tmpLogPath = join(tmpDir, 'test.log')
    const prodLogBefore = existsSync(PROD_LOG) ? readFileSync(PROD_LOG, 'utf8') : null
    try {
      const fakeSpool = makeFakeSpool()
      // 刻意只傳 deps.spool、不傳 deps.pool：函式真的執行
      // createMonitorPool(monitorRoleForThisHost(), ...)，不是被測試繞過。
      await writeAuthoritativeOutcome('FAQ-9008', 'timeout', 124, '/tmp/FAQ-9008.stdout.log', '/tmp/FAQ-9008.stderr.log', { spool: fakeSpool, logPath: tmpLogPath })
      // 核心斷言：角色正確解析為 mon_exec（跟本機 MON_DB_USER 一致）——這正是
      // ALDREQ-834 的根因修復，舊版寫死 mon_head 這裡會斷言失敗。
      expect(getDeclaredMonitorRole()).toBe('mon_exec')
      // 角色正確、loadMonitorEnv 不再拋出，createMonitorPool() 這一關就不會
      // 失敗——連線目標不可路由，最終仍會在真正嘗試寫入時落 spool
      // （best-effort），但不再是「角色不符」這種自我矛盾的例外。
      expect(fakeSpool.appended.length).toBe(1)
      expect(fakeSpool.appended[0]!.run_id).toBe('77777777-7777-7777-7777-777777777777')
      expect(fakeSpool.appended[0]!.fn).toBe('writeRunOutcomeAuthoritative')
      const logContent = existsSync(tmpLogPath) ? readFileSync(tmpLogPath, 'utf8') : ''
      expect(logContent).not.toContain('角色不符')
      const prodLogAfter = existsSync(PROD_LOG) ? readFileSync(PROD_LOG, 'utf8') : null
      expect(prodLogAfter).toBe(prodLogBefore)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
      if (prevRunId === undefined) delete process.env.MON_RUN_ID
      else process.env.MON_RUN_ID = prevRunId
      if (prevUser === undefined) delete process.env.MON_DB_USER
      else process.env.MON_DB_USER = prevUser
      if (prevWorker === undefined) delete process.env.CLUSTER_WORKER_NAME
      else process.env.CLUSTER_WORKER_NAME = prevWorker
      if (prevHost === undefined) delete process.env.MON_DB_HOST
      else process.env.MON_DB_HOST = prevHost
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

describe('buildNotifyText — 2026-09-04：每種分類的通知文字要一眼看出是哪種結束方式（不能共用同一句泛用文字）', () => {
  const NOTIFY_CLASSIFICATIONS: Classification[] = ['skipped', 'timeout', 'infra_failure', 'cli_failure', 'unknown_failure', 'session_limit']

  test('六種需要補發通知的分類，文字彼此互不相同（不共用同一句話）', () => {
    const texts = NOTIFY_CLASSIFICATIONS.map(c => buildNotifyText('FAQ-1', c, '/tmp/x.stdout.log', '/tmp/x.stderr.log', ''))
    expect(new Set(texts).size).toBe(NOTIFY_CLASSIFICATIONS.length)
  })

  test('每種分類的方括號標籤彼此互不相同', () => {
    const labels = NOTIFY_CLASSIFICATIONS.map(c => {
      const text = buildNotifyText('FAQ-1', c, 'out.log', 'err.log', '')
      const m = /^⚠️ \[(.+?)\]/.exec(text)
      return m ? m[1] : null
    })
    expect(labels.every(l => l !== null)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  test('session_limit：文字含「疑似」（低信心度 heuristic，不能斷言為事實）且提及額度用盡', () => {
    const text = buildNotifyText('FAQ-1', 'session_limit', 'out.log', 'err.log', '')
    expect(text).toContain('疑似')
    expect(text).toContain('額度')
  })

  test('timeout：retryNote 有插入文字裡', () => {
    const text = buildNotifyText('FAQ-1', 'timeout', 'out.log', 'err.log', '已觸發第 1 次自動重試——')
    expect(text).toContain('已觸發第 1 次自動重試——')
  })

  test('log 路徑都會出現在文字裡', () => {
    for (const c of NOTIFY_CLASSIFICATIONS) {
      const text = buildNotifyText('FAQ-1', c, '/tmp/a.stdout.log', '/tmp/a.stderr.log', '')
      expect(text).toContain('/tmp/a.stdout.log')
      expect(text).toContain('/tmp/a.stderr.log')
    }
  })
})

describe('notifyAssigneeOrEscalate — 2026-09-04 bug 修復：assignee 解析/通知失敗時不能只印 log，最終一定要有人收到通知', () => {
  test('正常情境：assignee 解析成功、通知成功 → 只發一次給 assignee，不觸發保底', () => {
    const notify = mock((_email: string, _text: string) => true)
    const resolveEmail = mock((_t: string) => 'tech@example.com')
    notifyAssigneeOrEscalate('FAQ-1', 'infra_failure', 'text', { resolveEmail, notify })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toBe('tech@example.com')
  })

  test('找不到 assignee email（回傳 null）→ 非 timeout 分類要退回發給保底聯絡人，不能只印 log 就結束', () => {
    const notify = mock((_email: string, _text: string) => true)
    const resolveEmail = mock((_t: string) => null)
    notifyAssigneeOrEscalate('FAQ-1', 'infra_failure', 'text', { resolveEmail, notify })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toBe('pkh_samjp6jp69898@photons.com.tw')
  })

  test('resolveEmail 拋例外 → 非 timeout 分類仍要退回發給保底聯絡人', () => {
    const notify = mock((_email: string, _text: string) => true)
    const resolveEmail = mock((_t: string) => {
      throw new Error('Notion API 掛了')
    })
    expect(() => notifyAssigneeOrEscalate('FAQ-1', 'cli_failure', 'text', { resolveEmail, notify })).not.toThrow()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toBe('pkh_samjp6jp69898@photons.com.tw')
  })

  test('對 assignee 發送失敗（notify 回傳 false）→ 非 timeout 分類仍要退回發給保底聯絡人', () => {
    const notify = mock((email: string, _text: string) => email !== 'tech@example.com')
    const resolveEmail = mock((_t: string) => 'tech@example.com')
    notifyAssigneeOrEscalate('FAQ-1', 'session_limit', 'text', { resolveEmail, notify })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0]![0]).toBe('tech@example.com')
    expect(notify.mock.calls[1]![0]).toBe('pkh_samjp6jp69898@photons.com.tw')
  })

  test('classification===timeout 且找不到 assignee → 不重複發保底聯絡人（main() 已在此之前無條件發過一次）', () => {
    const notify = mock((_email: string, _text: string) => true)
    const resolveEmail = mock((_t: string) => null)
    notifyAssigneeOrEscalate('FAQ-1', 'timeout', 'text', { resolveEmail, notify })
    expect(notify).not.toHaveBeenCalled()
  })

  test('classification===timeout 且 assignee 剛好就是保底聯絡人 → 不重複發（避免同一人收到兩則幾乎一樣的訊息）', () => {
    const notify = mock((_email: string, _text: string) => true)
    const resolveEmail = mock((_t: string) => 'pkh_samjp6jp69898@photons.com.tw')
    notifyAssigneeOrEscalate('FAQ-1', 'timeout', 'text', { resolveEmail, notify })
    expect(notify).not.toHaveBeenCalled()
  })
})
