import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, appendFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/user/aladdin'
const MAIN_REPOS = ['agrabah', 'abu', 'lago', 'rajah'] as const
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const LOG_PATH = join(LOG_DIR, 'cleanup-worktree.log')
const TICKET_RE = /^FAQ-\d+$/

// review 發現：跟同目錄 post-run-notify.ts 的 EXEC_TIMEOUT_MS 同一個理由
// （見該檔案 :16 註解）——這支腳本從 spawn-create-mr.ts 的 bash EXIT trap
// 呼叫，git 指令若卡住不返回，會拖住同一個 trap 裡排在後面的
// post-run-notify.ts（使用者收不到補發通知）。四個 repo 各跑數個 git 指令，
// 逐一加上限，最壞情況有界。
const EXEC_TIMEOUT_MS = 30_000

export type RemoveStatus = 'removed' | 'force_removed' | 'skipped_missing' | 'skipped_not_worktree' | 'failed' | 'invalid_ticket'

function defaultLog(msg: string): void {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
}

/**
 * T28：判斷 wtPath 是不是「這個 repo 真正的 git 連結 worktree」，而不是
 * setup-worktree.sh 對非 affected repo 建的、指回主 repo 的 symlink（見該
 * 腳本第 3 節「其餘主 repo + 共用庫 symlink」）。
 *
 * review 發現並修正的兩個真實問題：
 *
 * 1) 一律先用 `lstatSync().isSymbolicLink()` 擋 symlink，不管 git 判準怎麼說
 *    ——這是結構保證，不是啟發式。原因：若 wtPath 剛好是指向「另一個真
 *    worktree」的 symlink（理論上 setup-worktree.sh 目前只 symlink 回主
 *    repo，但這裡不依賴呼叫端的假設），走 git 判準會誤判成 true，實測
 *    `git worktree remove --force <symlink>` 會直接摧毀 symlink 目標裡的
 *    未 commit 內容且不可回復；lstat 檔案類型判斷不會有這種誤判空間。
 *
 * 2) `git rev-parse --git-dir` / `--git-common-dir` 不帶 `--path-format`
 *    時，git 對兩者回傳的路徑格式不對稱：從 repo 根目錄呼叫兩者都是相對
 *    路徑（相等），但從深層子目錄呼叫，`--git-dir` 會變成絕對路徑、
 *    `--git-common-dir` 卻仍是相對路徑（如 `../../.git`），單純字串比較
 *    因此誤判為「不同」＝linked worktree。這不是邊界情況：
 *    `/Users/user/aladdin` 本身就是 git repo（`worktrees/{ticket}/{repo}`
 *    正是它的深層子目錄），所以任何殘留在該路徑、但其實只是一般子目錄的
 *    東西（bootstrap 中斷、手動複製）都會被誤判。改用
 *    `--path-format=absolute` 讓兩者都回傳絕對路徑，字串比較才有意義（已
 *    實測驗證：加了這個 flag 後，主 repo 子目錄與真 linked worktree 兩種
 *    情境的判斷都正確）。
 *
 * wtPath 不存在或不是合法 git 目錄時一律回傳 false（不動它——寧可少清
 * 理，不可誤傷主 repo）。
 */
function isLinkedWorktree(wtPath: string): boolean {
  try {
    if (lstatSync(wtPath).isSymbolicLink()) return false
  } catch {
    return false
  }
  try {
    const gitDir = execFileSync('git', ['-C', wtPath, 'rev-parse', '--path-format=absolute', '--git-dir'], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim()
    const commonDir = execFileSync('git', ['-C', wtPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim()
    return gitDir !== commonDir
  } catch {
    return false
  }
}

/**
 * 強制清理前把整個 dirty worktree 目錄原封不動複製一份，而不是靠
 * `git stash create`——review 實測過：`git stash create` 預設不含 untracked
 * 檔案（純新增的檔案完全不會被捕捉，回傳空字串），risk_notes 要求的『確認
 * 不是遺漏了尚未推送的重要工作』對純新增檔案完全沒防護；直接複製整個目錄
 * （`cp -R` 對 symlink 只複製連結本身、不遞迴進目標，跟 node_modules /
 * .env.local 這類 symlink 共存安全）不管 tracked/untracked/staged 狀態都能
 * 完整保留，是更保守也更簡單的作法。備份不設自動清理（沒有隱藏上限，失敗
 * 時也會記進 log——只有真的發生過未 commit 變更被強制清理，才會產生備份，
 * 預期是罕見情況，累積速度不構成本 task「釋放磁碟空間」目標的實質抵銷）。
 */
function backupDirtyWorktree(wtPath: string, ticket: string, repo: string, logDir: string, log: (msg: string) => void): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(logDir, 'force-cleanup-backups')
    const dest = join(backupDir, `${ticket}.${repo}.${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    execFileSync('cp', ['-R', wtPath, dest], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    return dest
  } catch (err) {
    log(`${ticket} ${repo}: 備份未 commit 變更失敗，強制清理將不可回復（僅剩下面的 git status 檔名清單可查）: ${err}`)
    return null
  }
}

/**
 * 對單一 repo 的 worktree 做清理：分支（mr/{ticket}）完全不受影響——
 * `git worktree remove` 只動 working tree 目錄本身，不碰分支。
 *
 * 先嘗試不帶 --force 的移除；只有在失敗（推測是有未 commit 的變更）時才
 * 落到 --force，且落地前先把 `git status --porcelain` 記進 log、並完整備份
 * 整個目錄（見 backupDirtyWorktree）——risk_notes 要求『用 --force 前先確認
 * 不是遺漏了尚未推送的重要工作』，這裡做不到自動判斷『重要與否』，但保證
 * 強制清理過的內容既有留痕、也有實際可還原的備份（AC2）。
 */
export function removeRepoWorktree(
  repo: string,
  ticket: string,
  opts: { root?: string; logDir?: string; log?: (msg: string) => void } = {},
): RemoveStatus {
  const root = opts.root ?? ROOT
  const logDir = opts.logDir ?? LOG_DIR
  const log = opts.log ?? defaultLog

  if (!TICKET_RE.test(ticket)) {
    log(`ticket 格式不對（${ticket}），拒絕操作`)
    return 'invalid_ticket'
  }

  const wtPath = join(root, 'worktrees', ticket, repo)

  if (!existsSync(wtPath)) {
    log(`${ticket} ${repo}: 路徑不存在，略過`)
    return 'skipped_missing'
  }

  if (!isLinkedWorktree(wtPath)) {
    log(`${ticket} ${repo}: 非真正的 git 連結 worktree（可能是 symlink 回主 repo），略過不動`)
    return 'skipped_not_worktree'
  }

  const mainRepoPath = join(root, repo)
  try {
    execFileSync('git', ['-C', mainRepoPath, 'worktree', 'remove', wtPath], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    log(`${ticket} ${repo}: worktree remove 成功（無未 commit 變更），分支 mr/${ticket} 保留`)
    return 'removed'
  } catch {
    // 落到下面走 --force，先留痕、備份，再強制清理。
  }

  let statusOutput: string
  try {
    statusOutput = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS }).trim()
  } catch (err) {
    statusOutput = `(讀不到 git status: ${err})`
  }
  const backupPath = backupDirtyWorktree(wtPath, ticket, repo, logDir, log)
  log(
    `${ticket} ${repo}: 一般 remove 失敗，強制清理前的 git status --porcelain：\n${statusOutput || '(空白，可能是其他原因失敗)'}\n` +
      (backupPath ? `完整目錄已備份到 ${backupPath}` : '備份失敗，見上一行記錄'),
  )

  try {
    execFileSync('git', ['-C', mainRepoPath, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
    log(`${ticket} ${repo}: worktree remove --force 完成，分支 mr/${ticket} 保留`)
    return 'force_removed'
  } catch (err) {
    log(`${ticket} ${repo}: worktree remove --force 仍失敗: ${err}`)
    return 'failed'
  }
}

/**
 * 四個 repo 各自 remove 完之後，$WT_BASE/{ticket} 底下通常只剩 SHARED repo
 * 的 symlink（jasmine/genie/jafar，見 setup-worktree.sh）與 bootstrap.log——
 * rm -rf 對 symlink 只會解除連結本身、不會遞迴進目標，安全。只要四個 repo
 * 都不是「還留著目錄」的狀態（只有 force remove 也失敗才會留下）才動手；
 * 任何一個 repo 清理失敗就保留母目錄供人工檢查，不要在清理不完整時假裝
 * 「已釋放空間」。
 *
 * bootstrap.log 是 ticket 目錄內唯一的 forensic 產物（其餘產出都在
 * obsidian/Debug/{ticket}/，不受這裡影響，見 create-mr.md 各步輸出路徑）——
 * review 指出直接砍掉會讓失敗單事後查因少一份線索，這裡先搬一份到
 * telegram-dispatcher/logs/ 再刪母目錄，成本很低。已知殘留落差（review
 * 指出，未處理）：create-mr.md 產生的完成報告與 BOOTSTRAP_PARTIAL 訊息仍會
 * 印出原始路徑 `{worktree_path}/bootstrap.log`——這份共用文件不分辨呼叫者
 * 是不是 dispatcher，本 task 不改它；經 dispatcher 觸發的單子若要查
 * bootstrap.log，正確位置是這裡搬過去的 `telegram-dispatcher/logs/
 * {ticket}.bootstrap.log`，不是報告裡寫的原路徑。
 *
 * 全程包在 try/catch：這支腳本的呼叫端是 bash EXIT trap（見
 * spawn-create-mr.ts），文件承諾『best-effort，任何一步失敗只記 log、不丟
 * 例外』，這裡的檔案系統操作（readdirSync/rmSync/copyFileSync）理論上仍可能
 * 丟例外（權限錯誤等），沒接住的話會讓整支 CLI 例外退出、且因為呼叫端接的
 * 是 `>/dev/null 2>&1`，會變成完全靜默、連 log 都沒有——review 抓到的真實
 * 落差，這裡補上。
 */
function cleanupTicketDir(ticket: string, root: string, logDir: string, log: (msg: string) => void): void {
  try {
    const ticketDir = join(root, 'worktrees', ticket)
    if (!existsSync(ticketDir)) return

    const stillHasRepoDir = MAIN_REPOS.some(repo => existsSync(join(ticketDir, repo)))
    if (stillHasRepoDir) {
      log(`${ticket}: 仍有 repo 目錄清理失敗，保留母目錄 ${ticketDir} 供人工檢查`)
      return
    }

    const bootstrapLog = join(ticketDir, 'bootstrap.log')
    if (existsSync(bootstrapLog)) {
      try {
        mkdirSync(logDir, { recursive: true })
        const savedPath = join(logDir, `${ticket}.bootstrap.log`)
        copyFileSync(bootstrapLog, savedPath)
        log(`${ticket}: bootstrap.log 已保留到 ${savedPath}`)
      } catch (err) {
        log(`${ticket}: 保留 bootstrap.log 失敗（不影響母目錄清除）: ${err}`)
      }
    }

    const remaining = readdirSync(ticketDir)
    rmSync(ticketDir, { recursive: true, force: true })
    log(`${ticket}: 母目錄 ${ticketDir} 已清除（原剩餘內容：${remaining.join(', ') || '(空)'}）`)
  } catch (err) {
    log(`${ticket}: 清理母目錄時發生未預期錯誤: ${err}`)
  }
}

/**
 * T28 主流程：對指定 ticket 的四個 MAIN_REPOS 依序清理 worktree，最後嘗試
 * 清掉母目錄。個別 repo 之間互不影響（一個失敗不影響其他 repo 繼續清，
 * 滿足 AC3「多個不同 ticket 的 worktree 各自獨立清理，互不影響」——本函式
 * 每次只處理單一 ticket 底下自己的路徑，不同 ticket 天生就是不同目錄）。
 *
 * review 發現：這是唯一會呼叫 `rmSync(ticketDir, {recursive:true})` 的路徑，
 * 若 ticket 是空字串或含 `..`，`join(root,'worktrees',ticket)` 可能算出
 * `root/worktrees` 本身（空字串）甚至跳出去，一旦四個 MAIN_REPOS 子目錄檢查
 * 都不成立就會整個砍掉——這裡是匯出的公開 API，不能只靠 main() 那層的
 * TICKET_RE 檢查（那只保護 CLI 入口）。破壞性動作前置驗證。
 */
export function cleanupWorktreesForTicket(
  ticket: string,
  opts: { root?: string; logDir?: string; log?: (msg: string) => void } = {},
): Record<string, RemoveStatus> {
  const root = opts.root ?? ROOT
  const logDir = opts.logDir ?? LOG_DIR
  const log = opts.log ?? defaultLog

  if (!TICKET_RE.test(ticket)) {
    log(`ticket 格式不對（${ticket}），拒絕操作，不清理任何目錄`)
    const invalid: Record<string, RemoveStatus> = {}
    for (const repo of MAIN_REPOS) invalid[repo] = 'invalid_ticket'
    return invalid
  }

  const results: Record<string, RemoveStatus> = {}
  for (const repo of MAIN_REPOS) {
    results[repo] = removeRepoWorktree(repo, ticket, { root, logDir, log })
  }
  cleanupTicketDir(ticket, root, logDir, log)
  return results
}

/**
 * T28 CLI 進入點：從 spawn-create-mr.ts 的 bash EXIT trap 呼叫（比照 T13
 * post-run-notify.ts 的呼叫慣例），argv = [ticket]。全程 best-effort，任何
 * 一步失敗只記 log、不丟例外——trap 裡不會接任何錯誤處理，也不能讓這一步
 * 拖住 trap 裡其餘收尾工作（release 鎖／補發通知）。
 */
function main(): void {
  const [ticket] = process.argv.slice(2)
  if (!ticket || !TICKET_RE.test(ticket)) {
    defaultLog(`參數不足或格式不對，略過: ${process.argv.slice(2).join(' ')}`)
    return
  }
  cleanupWorktreesForTicket(ticket)
}

if (import.meta.main) {
  main()
}
