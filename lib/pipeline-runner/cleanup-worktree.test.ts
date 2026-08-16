import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupWorktreesForTicket, removeRepoWorktree } from './cleanup-worktree.ts'

// 這裡全程用真的 git repo + 真的 `git worktree add/remove`（不 mock
// child_process）——T28 的正確性完全依賴 git 本身對 dirty worktree 的判斷跟
// isLinkedWorktree() 的 git-dir/common-dir 判準，mock 掉 git 就等於什麼都沒
// 測到。每個 test 用獨立 mkdtemp 目錄當作 root，不碰真正的
// /Users/user/aladdin。

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo(root: string, repo: string): void {
  const dir = join(root, repo)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'README.md'), 'init\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

function addWorktree(root: string, repo: string, ticket: string): string {
  const wtPath = join(root, 'worktrees', ticket, repo)
  mkdirSync(join(root, 'worktrees', ticket), { recursive: true })
  git(join(root, repo), ['worktree', 'add', '-q', wtPath, '-b', `mr/${ticket}`])
  return wtPath
}

function branchExists(root: string, repo: string, branch: string): boolean {
  const out = git(join(root, repo), ['branch', '--list', branch])
  return out.trim().length > 0
}

function collectLog(): { log: (msg: string) => void; lines: string[] } {
  const lines: string[] = []
  return { log: (msg: string) => lines.push(msg), lines }
}

// backupDirtyWorktree／bootstrap.log 保留邏輯預設寫進真正的
// telegram-dispatcher/logs/（見 cleanup-worktree.ts 的 LOG_DIR 常數）——
// 測試一律帶自己的 tmp logDir，不污染這個 repo 真正的 logs 目錄。
function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleanup-wt-logdir-'))
}

describe('removeRepoWorktree — 乾淨 worktree（AC1）', () => {
  test('無未 commit 變更：直接 remove 成功，worktree 目錄消失但分支保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-clean-'))
    makeRepo(root, 'agrabah')
    const wtPath = addWorktree(root, 'agrabah', 'FAQ-9001')
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-9001', { root, log })

    expect(status).toBe('removed')
    expect(existsSync(wtPath)).toBe(false)
    expect(branchExists(root, 'agrabah', 'mr/FAQ-9001')).toBe(true)
    expect(lines.some(l => l.includes('worktree remove 成功'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })
})

describe('removeRepoWorktree — 有未 commit 變更（AC2）', () => {
  test('worktree 內有未追蹤檔案：一般 remove 失敗後強制清理，log 留痕強制清理過的內容，且完整內容有備份可還原', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-dirty-'))
    const logDir = makeLogDir()
    makeRepo(root, 'agrabah')
    const wtPath = addWorktree(root, 'agrabah', 'FAQ-9002')
    writeFileSync(join(wtPath, 'uncommitted.txt'), '遺漏尚未 commit 的東西\n')
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-9002', { root, logDir, log })

    expect(status).toBe('force_removed')
    expect(existsSync(wtPath)).toBe(false)
    expect(branchExists(root, 'agrabah', 'mr/FAQ-9002')).toBe(true)
    // AC2 要求「至少要在 log 中明確記錄是否強制清理過未 commit 的內容」
    const forceLog = lines.join('\n')
    expect(forceLog).toContain('強制清理前的 git status --porcelain')
    expect(forceLog).toContain('uncommitted.txt')
    expect(forceLog).toContain('worktree remove --force 完成')

    // review 發現：`git stash create` 不含 untracked 檔案，不足以保護
    // risk_notes 要求的『不是遺漏了尚未推送的重要工作』——這裡驗證真的有
    // 完整備份、且備份裡的檔案內容原封不動可還原（不只是記了檔名）。
    const backupMatch = forceLog.match(/完整目錄已備份到 (\S+)/)
    expect(backupMatch).not.toBeNull()
    const backupPath = backupMatch![1]!
    expect(existsSync(backupPath)).toBe(true)
    expect(readFileSync(join(backupPath, 'uncommitted.txt'), 'utf8')).toBe('遺漏尚未 commit 的東西\n')

    rmSync(root, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  })
})

describe('removeRepoWorktree — 非真正的 git worktree（symlink 回主 repo）', () => {
  test('symlink 路徑不會被當成 worktree 處理，也不會誤傷主 repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-symlink-'))
    makeRepo(root, 'abu')
    const ticketDir = join(root, 'worktrees', 'FAQ-9003')
    mkdirSync(ticketDir, { recursive: true })
    const linkPath = join(ticketDir, 'abu')
    symlinkSync(join(root, 'abu'), linkPath)
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('abu', 'FAQ-9003', { root, log })

    expect(status).toBe('skipped_not_worktree')
    // symlink 本身跟它指向的主 repo 都必須完好無損
    expect(existsSync(linkPath)).toBe(true)
    expect(existsSync(join(root, 'abu', '.git'))).toBe(true)
    expect(lines.some(l => l.includes('略過不動'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  // review-git-logic 發現的真實破壞路徑（F2）：若 wtPath 是指向「另一個真
  // worktree」（不是主 repo）的 symlink，舊版判準（git-dir/common-dir 字串
  // 比較）會誤判成 true，導致 `git worktree remove --force` 摧毀 symlink
  // 目標裡未 commit 的內容且不可回復。這裡直接驗證修好的版本：一律先擋
  // symlink，不管目標是什麼。
  test('symlink 指向另一個真正的 linked worktree（非主 repo）：一樣略過不動，不會摧毀目標內容', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-symlink-to-worktree-'))
    makeRepo(root, 'agrabah')
    const realWtPath = addWorktree(root, 'agrabah', 'FAQ-90031')
    writeFileSync(join(realWtPath, 'important-wip.txt'), '尚未推送的重要工作\n')

    const ticketDir = join(root, 'worktrees', 'FAQ-90032')
    mkdirSync(ticketDir, { recursive: true })
    const linkPath = join(ticketDir, 'agrabah')
    symlinkSync(realWtPath, linkPath)
    const { log } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-90032', { root, log })

    expect(status).toBe('skipped_not_worktree')
    expect(existsSync(realWtPath)).toBe(true)
    expect(readFileSync(join(realWtPath, 'important-wip.txt'), 'utf8')).toBe('尚未推送的重要工作\n')

    rmSync(root, { recursive: true, force: true })
  })
})

describe('removeRepoWorktree — 路徑不存在', () => {
  test('worktree 目錄根本不存在：略過，不丟例外', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-missing-'))
    makeRepo(root, 'lago')
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('lago', 'FAQ-9004', { root, log })

    expect(status).toBe('skipped_missing')
    expect(lines.some(l => l.includes('路徑不存在'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })
})

// review-git-logic 發現的真實問題（F1）：git-dir/git-common-dir 不帶
// --path-format=absolute 時，回傳的路徑格式在「repo 根目錄」跟「深層子
// 目錄」不對稱（後者 --git-dir 是絕對路徑、--git-common-dir 卻是相對路
// 徑），單純字串比較會把「root 本身也是 git repo、worktrees/{ticket}/{repo}
// 只是它一般子目錄」的情境誤判成 linked worktree。這裡刻意讓 root 本身是
// git repo（貼近生產：/Users/user/aladdin 本身就是），驗證修好後的判準正確。
describe('removeRepoWorktree — root 本身是 git repo（生產環境的真實結構，F1 迴歸測試）', () => {
  test('root 是 git repo 時，worktrees/{ticket}/{repo} 若只是一般子目錄（非註冊 worktree），仍正確判定略過不動', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-root-is-repo-'))
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'test'])
    writeFileSync(join(root, 'README.md'), 'init\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'init'])

    // 模擬殘留：worktrees/{ticket}/agrabah 是一般目錄（不是 git worktree），
    // 但因為 root 自己是 git repo，這個路徑其實落在 root 的 working tree 裡。
    const strayDir = join(root, 'worktrees', 'FAQ-9010', 'agrabah')
    mkdirSync(strayDir, { recursive: true })
    writeFileSync(join(strayDir, 'leftover.txt'), 'x')
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-9010', { root, log })

    expect(status).toBe('skipped_not_worktree')
    expect(existsSync(strayDir)).toBe(true)
    expect(lines.some(l => l.includes('略過不動'))).toBe(true)

    rmSync(join(root, 'worktrees'), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  test('root 是 git repo 時，真正的 linked worktree 仍正確判定並清理', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-root-is-repo-real-'))
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'test'])
    writeFileSync(join(root, 'README.md'), 'init\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'init'])

    // agrabah 作為子目錄本身也是獨立 repo（貼近生產：root=/Users/user/aladdin
    // 是 repo，agrabah/ 底下也是另一個獨立 repo）。
    makeRepo(root, 'agrabah')
    const wtPath = addWorktree(root, 'agrabah', 'FAQ-9011')
    const { log } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-9011', { root, log })

    expect(status).toBe('removed')
    expect(existsSync(wtPath)).toBe(false)
    expect(branchExists(root, 'agrabah', 'mr/FAQ-9011')).toBe(true)

    rmSync(join(root, 'worktrees'), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
})

describe('removeRepoWorktree — worktree 被 git worktree lock 鎖住', () => {
  test('鎖住的 worktree：一般 remove 與 --force 都真的失敗，回傳 failed，目錄與分支都原封不動保留（安全側失敗）', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-locked-'))
    const logDir = makeLogDir()
    makeRepo(root, 'agrabah')
    const wtPath = addWorktree(root, 'agrabah', 'FAQ-9012')
    git(join(root, 'agrabah'), ['worktree', 'lock', wtPath])
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-9012', { root, logDir, log })

    expect(status).toBe('failed')
    expect(existsSync(wtPath)).toBe(true)
    expect(branchExists(root, 'agrabah', 'mr/FAQ-9012')).toBe(true)
    expect(lines.some(l => l.includes('worktree remove --force 仍失敗'))).toBe(true)

    git(join(root, 'agrabah'), ['worktree', 'unlock', wtPath])
    rmSync(root, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  })
})

describe('removeRepoWorktree / cleanupWorktreesForTicket — ticket 格式驗證（F5）', () => {
  test('removeRepoWorktree：格式不對的 ticket 直接拒絕，不嘗試組路徑操作', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-invalid-ticket-'))
    makeRepo(root, 'agrabah')
    const { log, lines } = collectLog()

    const status = removeRepoWorktree('agrabah', '../../etc', { root, log })

    expect(status).toBe('invalid_ticket')
    expect(lines.some(l => l.includes('格式不對'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  // review-git-logic 發現的真實風險（F5）：cleanupWorktreesForTicket 是唯一
  // 會對 `worktrees/{ticket}` 整個目錄做 rmSync(recursive:true) 的路徑；若
  // ticket 是空字串，join(root,'worktrees','') 算出來就是 `worktrees` 本身
  // ——一旦沒有驗證，會把所有 ticket 的 worktree 一次砍光。這裡驗證修好後
  // 的版本：空字串／不合法格式一律在最前面被拒絕，完全不去碰檔案系統。
  test('cleanupWorktreesForTicket：空字串 ticket 不會刪掉整個 worktrees 目錄（其他 ticket 的東西必須存活）', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-empty-ticket-'))
    makeRepo(root, 'agrabah')
    const otherTicketWt = addWorktree(root, 'agrabah', 'FAQ-9013')
    const { log, lines } = collectLog()

    const results = cleanupWorktreesForTicket('', { root, log })

    expect(Object.values(results).every(s => s === 'invalid_ticket')).toBe(true)
    expect(lines.some(l => l.includes('拒絕操作，不清理任何目錄'))).toBe(true)
    // 別的 ticket 的 worktree 完全沒被動到
    expect(existsSync(otherTicketWt)).toBe(true)
    expect(branchExists(root, 'agrabah', 'mr/FAQ-9013')).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })
})

describe('cleanupWorktreesForTicket — 整合（AC1 + AC3）', () => {
  test('四個 repo 全部清乾淨後，母目錄也一併移除（bootstrap.log 先保留一份）；分支全部保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-full-'))
    const logDir = mkdtempSync(join(tmpdir(), 'cleanup-wt-full-logs-'))
    const repos = ['agrabah', 'abu', 'lago', 'rajah']
    for (const repo of repos) {
      makeRepo(root, repo)
      addWorktree(root, repo, 'FAQ-9005')
    }
    // 模擬 setup-worktree.sh 留下的 SHARED symlink 與 bootstrap.log——
    // cleanup 完應該連這些一起清掉（rm -rf 對 symlink 安全，不遞迴進目標）。
    const ticketDir = join(root, 'worktrees', 'FAQ-9005')
    mkdirSync(join(root, 'jasmine'), { recursive: true })
    symlinkSync(join(root, 'jasmine'), join(ticketDir, 'jasmine'))
    writeFileSync(join(ticketDir, 'bootstrap.log'), 'bootstrap ok\n')
    const { log, lines } = collectLog()

    const results = cleanupWorktreesForTicket('FAQ-9005', { root, logDir, log })

    for (const repo of repos) {
      expect(results[repo]).toBe('removed')
      expect(branchExists(root, repo, 'mr/FAQ-9005')).toBe(true)
    }
    expect(existsSync(ticketDir)).toBe(false)
    // SHARED repo 本體（symlink 目標）不受影響
    expect(existsSync(join(root, 'jasmine'))).toBe(true)
    // bootstrap.log 在母目錄被刪之前，已經先保留一份到 logDir
    expect(readFileSync(join(logDir, 'FAQ-9005.bootstrap.log'), 'utf8')).toBe('bootstrap ok\n')
    expect(lines.some(l => l.includes('bootstrap.log 已保留到'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  })

  test('不同 ticket 各自獨立清理，互不影響（AC3）', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-multi-ticket-'))
    makeRepo(root, 'agrabah')
    const wtA = addWorktree(root, 'agrabah', 'FAQ-9006')
    const wtB = addWorktree(root, 'agrabah', 'FAQ-9007')
    const { log } = collectLog()

    const status = removeRepoWorktree('agrabah', 'FAQ-9006', { root, log })

    expect(status).toBe('removed')
    expect(existsSync(wtA)).toBe(false)
    // FAQ-9007 的 worktree 完全沒被動到
    expect(existsSync(wtB)).toBe(true)
    expect(branchExists(root, 'agrabah', 'mr/FAQ-9007')).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  test('其中一個 repo 清理失敗（worktree 被鎖住）時，保留母目錄不假裝已清空，其他 repo 照常清理', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-wt-partial-fail-'))
    const logDir = makeLogDir()
    makeRepo(root, 'agrabah')
    makeRepo(root, 'abu')
    addWorktree(root, 'agrabah', 'FAQ-9008')
    const wtAbu = addWorktree(root, 'abu', 'FAQ-9008')
    git(join(root, 'abu'), ['worktree', 'lock', wtAbu])
    const { log } = collectLog()

    const results = cleanupWorktreesForTicket('FAQ-9008', { root, logDir, log })

    // agrabah 正常清乾淨，abu 因為鎖住而失敗——兩者互不影響
    expect(results.agrabah).toBe('removed')
    expect(results.abu).toBe('failed')
    expect(existsSync(wtAbu)).toBe(true)
    // 母目錄因為 abu 還留著（清理失敗）而保留，不假裝已釋放空間
    const ticketDir = join(root, 'worktrees', 'FAQ-9008')
    expect(existsSync(ticketDir)).toBe(true)

    git(join(root, 'abu'), ['worktree', 'unlock', wtAbu])
    rmSync(root, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  })
})
