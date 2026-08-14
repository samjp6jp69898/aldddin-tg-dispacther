import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnDetachedProcess } from './spawn-create-mr.ts'

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
