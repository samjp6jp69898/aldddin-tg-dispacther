import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnDetachedProcess, WRAPPER_SCRIPT, dispatchMonitorWrite, __setMonitorTestOverrides, __resetMonitorTestOverrides } from './spawn-create-mr.ts'
import { FakeRunsDb } from '../monitor-db/test-support/fake-runs-db.ts'
import { writeRunProgress } from '../monitor-db/writes.ts'
import type { SpoolEntry } from '../monitor-db/spool/types.ts'

// review-integration 發現的真實缺口（E）：trap 裡 release/cleanup/notify 三行
// 的順序完全沒有測試守護，未來有人改動時很容易在不自覺間打亂順序或漏掉一行
// ——直接對真的 claude -p 跑一次太重（需要網路/認證），改成對 WRAPPER_SCRIPT
// 這個字串常數做結構斷言：三個呼叫都在同一個 trap 區塊內、且順序是
// release → cleanup-worktree → post-run-notify（T28 的順序取捨見
// spawn-create-mr.ts 對應註解）。
describe('WRAPPER_SCRIPT — prompt 位置參數（2026-09-08 plan-pipeline-modes-v1 §2.2）', () => {
  test('claude -p 的 prompt 帶 `$1 $3 $4`（ticket / mode / resume），mode 在 resume 之前', () => {
    expect(WRAPPER_SCRIPT).toContain('"/create-mr:create-mr $1 $3 $4"')
  })
})

describe('WRAPPER_SCRIPT — EXIT trap 內收尾呼叫的順序（T13/T28 依賴的結構）', () => {
  test('bug-lock release → cleanup-worktree → post-run-notify，三者都在同一個 trap 區塊內', () => {
    const trapMatch = /trap '([\s\S]*?)' EXIT/.exec(WRAPPER_SCRIPT)
    expect(trapMatch).not.toBeNull()
    const trapBody = trapMatch![1]!

    const releaseIdx = trapBody.indexOf('bug-lock.sh release')
    const cleanupIdx = trapBody.indexOf('cleanup-worktree.ts')
    const notifyIdx = trapBody.indexOf('post-run-notify.ts')

    expect(releaseIdx).toBeGreaterThan(-1)
    expect(cleanupIdx).toBeGreaterThan(-1)
    expect(notifyIdx).toBeGreaterThan(-1)
    expect(releaseIdx).toBeLessThan(cleanupIdx)
    expect(cleanupIdx).toBeLessThan(notifyIdx)
  })

  test('EC 在 trap 第一行就存起來，且 cleanup-worktree.ts 只帶 ticket（$1），不需要 EC/stdoutPath', () => {
    const trapMatch = /trap '([\s\S]*?)' EXIT/.exec(WRAPPER_SCRIPT)
    const trapBody = trapMatch![1]!
    const lines = trapBody
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)

    expect(lines[0]).toBe('EC=$?')
    const cleanupLine = lines.find(l => l.includes('cleanup-worktree.ts'))!
    expect(cleanupLine).toContain('"$1"')
    expect(cleanupLine).not.toContain('$EC')
    expect(cleanupLine).not.toContain('"$2"')
  })
})

// T16 review 發現：spawnDetachedProcess 的 env 合併邏輯（opts.env ? {...process.env, ...opts.env} : undefined）
// 之前完全靠手動 bun -e 驗證，沒有自動化回歸保護。這裡用真的 spawn 一個 bash
// 指令（不是 mock）釘住兩件事：(1) 帶入的新 key 真的傳到子行程；(2) 既有的
// process.env（如 PATH）不會被覆寫掉——這正是 T16 讓 DISPATCHER_TRIGGERED
// 一路傳進 setup-worktree.sh 所依賴的機制。
//
// 硬規則：不得用輪詢間隔規避競態。這裡用 fs.watch 監聽 stdout 檔案所在目錄
// 的真實變更事件當完成訊號（子行程寫完 echo 就會觸發 change），不是猜測
// 一個固定延遲；timeout 只是失敗保護網（子行程真的卡住時讓測試明確失敗，
// 不是拿來當作「等夠久就當作成功」的正確性依據）。
function waitForFileContent(path: string, predicate: (content: string) => boolean, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const check = () => {
      if (settled) return
      let content = ''
      try {
        content = readFileSync(path, 'utf8')
      } catch {
        return // 檔案還沒建立
      }
      if (predicate(content)) {
        settled = true
        clearTimeout(timer)
        watcher.close()
        resolve(content)
      }
    }
    const watcher = watch(dirname(path), check)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      watcher.close()
      reject(new Error(`timeout waiting for content in ${path}`))
    }, timeoutMs)
    check() // 防呆：萬一 spawn 在 watch 掛上之前就已經寫完
  })
}

describe('spawnDetachedProcess — env 合併（T16 依賴的機制）', () => {
  test('opts.env 帶入的 key 會傳給子行程，且不會洗掉既有 process.env（如 PATH）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-env-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')

    spawnDetachedProcess('bash', ['-c', 'echo "DISPATCHER_TRIGGERED=$DISPATCHER_TRIGGERED"; echo "PATH_NONEMPTY=$([ -n \\"$PATH\\" ] && echo yes || echo no)"'], {
      cwd: dir,
      stdoutPath,
      stderrPath,
      env: { DISPATCHER_TRIGGERED: '1' },
    })

    const content = await waitForFileContent(stdoutPath, c => c.includes('PATH_NONEMPTY='))
    expect(content).toContain('DISPATCHER_TRIGGERED=1')
    expect(content).toContain('PATH_NONEMPTY=yes')

    rmSync(dir, { recursive: true, force: true })
  })

  test('不帶 opts.env 時維持既有行為（undefined，等同繼承整個 process.env）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-env-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')

    spawnDetachedProcess('bash', ['-c', 'echo "DISPATCHER_TRIGGERED=${DISPATCHER_TRIGGERED:-unset}"'], {
      cwd: dir,
      stdoutPath,
      stderrPath,
    })

    const content = await waitForFileContent(stdoutPath, c => c.includes('DISPATCHER_TRIGGERED='))
    expect(content).toContain('DISPATCHER_TRIGGERED=unset')

    rmSync(dir, { recursive: true, force: true })
  })
})

// T26 依賴的機制：全域併發計數器要在背景 process 真正結束時才釋放名額，
// 事件驅動（'exit'/'error'），不是 sleep/輪詢猜一個固定時間。這裡用真的
// spawn（不 mock child_process），用 Promise 包住 onExit 呼叫本身當作
// 完成訊號——沒有等待時間的猜測成分，onExit 什麼時候真的被呼叫，Promise
// 就什麼時候 resolve。
function waitForOnExit(spawnFn: (onExit: () => void) => void, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for onExit')), timeoutMs)
    spawnFn(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('spawnDetachedProcess — opts.onExit（T26 依賴的機制）', () => {
  test('process 正常結束（exit 0）：onExit 被呼叫恰好一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onexit-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let calls = 0

    await waitForOnExit(onExit =>
      spawnDetachedProcess('bash', ['-c', 'exit 0'], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onExit: () => {
          calls++
          onExit()
        },
      }),
    )

    expect(calls).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('process 以非 0 結束（模擬失敗/被 kill）：onExit 一樣被呼叫恰好一次——不是只有成功才釋放名額', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onexit-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let calls = 0

    await waitForOnExit(onExit =>
      spawnDetachedProcess('bash', ['-c', 'exit 1'], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onExit: () => {
          calls++
          onExit()
        },
      }),
    )

    expect(calls).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('spawn 本身失敗（指令不存在）：onExit 仍被呼叫恰好一次，不會永久卡住名額', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onexit-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let calls = 0

    await waitForOnExit(onExit =>
      spawnDetachedProcess('this-command-definitely-does-not-exist-xyz', [], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onExit: () => {
          calls++
          onExit()
        },
      }),
    )

    expect(calls).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  // T26 review 發現的測試空白：之前只測過「正常結束」跟「exit code 非 0」
  // 兩種，沒有真的送過 kill signal 驗證 'exit' 事件真的會觸發——這正是
  // spawnCreateMr 文件裡『被 timeout 殺』這個情境實際依賴的機制，之前只有
  // 論證（Node 語意），沒有實測。這裡真的 spawn 一個長時間 sleep，再真的
  // SIGKILL 它，確認 onExit 依然恰好被呼叫一次。
  test('process 被真的 SIGKILL：onExit 依然被呼叫恰好一次（不是只有自然結束/exit code 才觸發）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onexit-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let calls = 0
    let capturedPid: number | undefined

    // waitForOnExit 的 Promise executor 是同步執行的，spawnFn(onExit) 這行
    // 跑完時 spawnDetachedProcess 已經同步回傳（child.pid 已知），所以下面
    // 緊接著就能安全讀到 capturedPid，不需要額外等待。
    const onExitPromise = waitForOnExit(onExit => {
      capturedPid = spawnDetachedProcess('sleep', ['30'], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onExit: () => {
          calls++
          onExit()
        },
      })
    })

    expect(capturedPid).toBeDefined()
    process.kill(capturedPid!, 'SIGKILL')

    await onExitPromise
    expect(calls).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  // T26 review 發現的真實 bug 對應測試：spawnDetachedProcess 的
  // mkdirSync/openSync（見函式開頭）在 onExit 監聽器掛上之前執行，若丟出
  // 例外，onExit 完全沒機會被呼叫——這正是 spawnCreateMr 現在用 try/catch
  // 接住並歸還名額的前提。這裡用一個「路徑中間段是檔案不是目錄」的
  // stdoutPath 逼 mkdirSync 真的丟 ENOTDIR，驗證這個前提本身是真的（不是
  // 想像的邊界情況）。
  test('mkdirSync 目標路徑不合法（中間段是檔案不是目錄）：同步丟出例外，不是靜默失敗或非同步錯誤', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onexit-test-'))
    const notADir = join(dir, 'this-is-a-file')
    writeFileSync(notADir, 'x')
    const stdoutPath = join(notADir, 'subdir', 'out.log') // notADir 是檔案，底下不能再建目錄
    const stderrPath = join(dir, 'err.log')

    expect(() =>
      spawnDetachedProcess('bash', ['-c', 'exit 0'], {
        cwd: dir,
        stdoutPath,
        stderrPath,
      }),
    ).toThrow()

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('spawnDetachedProcess — opts.onSpawnError（plan-db-as-truth-v3.2.md §9 Phase2：非同步 error 事件專用，區別於 onExit）', () => {
  test('spawn 本身失敗（指令不存在）：onSpawnError 與 onExit 都被呼叫恰好一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onerror-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let onSpawnErrorCalls = 0
    let onExitCalls = 0

    await waitForOnExit(onExit =>
      spawnDetachedProcess('this-command-definitely-does-not-exist-xyz', [], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onSpawnError: () => {
          onSpawnErrorCalls++
        },
        onExit: () => {
          onExitCalls++
          onExit()
        },
      }),
    )

    expect(onSpawnErrorCalls).toBe(1)
    expect(onExitCalls).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('process 正常結束（exit 0）：onSpawnError 完全不被呼叫', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onerror-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let onSpawnErrorCalls = 0

    await waitForOnExit(onExit =>
      spawnDetachedProcess('bash', ['-c', 'exit 0'], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onSpawnError: () => {
          onSpawnErrorCalls++
        },
        onExit,
      }),
    )

    expect(onSpawnErrorCalls).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test('不傳 onSpawnError（既有呼叫端 spawn-demand-pipeline.ts／trigger-auto-sync.ts）：完全不受影響，不拋例外', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onerror-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')

    await waitForOnExit(onExit =>
      spawnDetachedProcess('this-command-definitely-does-not-exist-xyz', [], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onExit,
      }),
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('onSpawnError 自己丟例外：吞掉並記 log，不影響既有的 onExit 呼叫', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-onerror-test-'))
    const stdoutPath = join(dir, 'out.log')
    const stderrPath = join(dir, 'err.log')
    let onExitCalls = 0

    await waitForOnExit(onExit =>
      spawnDetachedProcess('this-command-definitely-does-not-exist-xyz', [], {
        cwd: dir,
        stdoutPath,
        stderrPath,
        onSpawnError: () => {
          throw new Error('監控 DB 寫入掛了')
        },
        onExit: () => {
          onExitCalls++
          onExit()
        },
      }),
    )

    expect(onExitCalls).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})

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

describe('dispatchMonitorWrite — plan-db-as-truth-v3.2.md §6.7 非阻斷派送：逾時/失敗落 spool，flag 關閉時零行為', () => {
  afterEach(() => {
    __resetMonitorTestOverrides()
  })

  test('寫入成功 → 直接落地，不落 spool', async () => {
    const fakeDb = new FakeRunsDb()
    const fakeSpool = makeFakeSpool()
    __setMonitorTestOverrides({ pool: fakeDb, spool: fakeSpool })

    const input = { runId: 'r-1', ticket: 'FAQ-1', kind: 'bug' as const, lifecycleRank: 30 as const, pid: 111 }
    await dispatchMonitorWrite('writeRunProgress', input, pool => writeRunProgress(pool, input))

    expect(fakeDb.rows.get('r-1')).not.toBeUndefined()
    expect(fakeSpool.appended.length).toBe(0)
  })

  test('call() 丟例外（模擬連線中斷）→ 落 spool，條目帶正確 run_id/fn/args', async () => {
    const throwingPool = { execute: async () => Promise.reject(new Error('連線斷了')) }
    const fakeSpool = makeFakeSpool()
    __setMonitorTestOverrides({ pool: throwingPool, spool: fakeSpool })

    const input = { runId: 'r-2', ticket: 'FAQ-2', kind: 'bug' as const, lifecycleRank: 30 as const, pid: 222 }
    await dispatchMonitorWrite('writeRunProgress', input, pool => writeRunProgress(pool, input))

    expect(fakeSpool.appended.length).toBe(1)
    expect(fakeSpool.appended[0]!.run_id).toBe('r-2')
    expect(fakeSpool.appended[0]!.fn).toBe('writeRunProgress')
    expect(fakeSpool.appended[0]!.args).toEqual([input])
  })

  test('pool 為 null（模擬 createMonitorPool 失敗）→ 落 spool', async () => {
    const fakeSpool = makeFakeSpool()
    __setMonitorTestOverrides({ pool: null, spool: fakeSpool })

    const input = { runId: 'r-3', ticket: 'FAQ-3', kind: 'bug' as const, lifecycleRank: 30 as const }
    await dispatchMonitorWrite('writeRunProgress', input, pool => writeRunProgress(pool, input))

    expect(fakeSpool.appended.length).toBe(1)
    expect(fakeSpool.appended[0]!.run_id).toBe('r-3')
  })

  test('spool.append 本身也丟例外 → 吞掉，不讓呼叫端連坐（best-effort，只記 log）', async () => {
    const throwingPool = { execute: async () => Promise.reject(new Error('連線斷了')) }
    const throwingSpool = {
      append: () => {
        throw new Error('磁碟滿了')
      },
      appendBatch: () => {
        throw new Error('磁碟滿了')
      },
      filePath: () => '/tmp/x',
      close: () => {},
    }
    __setMonitorTestOverrides({ pool: throwingPool, spool: throwingSpool })

    const input = { runId: 'r-4', ticket: 'FAQ-4', kind: 'bug' as const, lifecycleRank: 30 as const }
    await expect(dispatchMonitorWrite('writeRunProgress', input, pool => writeRunProgress(pool, input))).resolves.toBeUndefined()
  })

  test('MON_DB_ENABLED 未設、無覆寫 → 不拋例外、不觸碰真的 logs/spool 目錄（§9.0(B) 零行為變化）', async () => {
    __resetMonitorTestOverrides()
    const prevFlag = process.env.MON_DB_ENABLED
    delete process.env.MON_DB_ENABLED
    try {
      const { SPOOL_DIR } = await import('../monitor-db/spool/types.ts')
      const { existsSync } = await import('node:fs')
      const existedBefore = existsSync(SPOOL_DIR)
      // 刻意完全不呼叫 __setMonitorTestOverrides：驗證的正是「一旦真的沒有
      // 任何覆寫、旗標也關著」這個最真實的關閉情境——getMonitorPool() 應在
      // isMonitorDbEnabled() 為 false 時直接回 null，連 getMonitorSpoolWriter()
      // 都不會被呼叫，所以連 SPOOL_DIR 都不該被建立出來。
      const input = { runId: 'r-5', ticket: 'FAQ-5', kind: 'bug' as const, lifecycleRank: 30 as const }
      await expect(dispatchMonitorWrite('writeRunProgress', input, pool => writeRunProgress(pool, input))).resolves.toBeUndefined()
      if (!existedBefore) expect(existsSync(SPOOL_DIR)).toBe(false)
    } finally {
      if (prevFlag === undefined) delete process.env.MON_DB_ENABLED
      else process.env.MON_DB_ENABLED = prevFlag
    }
  })
})
