import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SPAWN_ERROR_LOG = join(LOG_DIR, 'spawn-errors.log')
const TICKET_RE = /^FAQ-\d+$/

/**
 * 起一個完全脫離目前行程生命週期的背景 process：stdout/stderr 明確導向獨立
 * log 檔（不可裸接 pipe 給呼叫端——claude -p 結尾一次吐出的 JSON 加 stderr
 * 雜訊可能超過 macOS 預設 pipe buffer，繼承未持續讀取的 pipe 會卡死在
 * write()，webhook server 完全感知不到，見 tasks.json T11 risk_notes），
 * detached + unref 確保不被 webhook server 未來的重啟/崩潰連坐殺掉。
 * 呼叫本身立即返回，不 await、不用 sleep/輪詢等它結束。
 *
 * spawn() 找不到指令／cwd 有問題時不是同步丟例外，而是非同步 'error' event；
 * 沒接 listener 會被 Node 當成 uncaught exception，直接炸掉整個長駐的
 * webhook server process（review 實測驗證過）。這裡接住並寫進獨立的錯誤
 * log，換掉「整台 bot 陪葬」的後果。
 */
export function spawnDetachedProcess(command: string, args: string[], opts: { cwd: string; logPath: string }): number | undefined {
  mkdirSync(dirname(opts.logPath), { recursive: true })
  const outFd = openSync(opts.logPath, 'a')
  const errFd = openSync(opts.logPath, 'a')

  const child = spawn(command, args, {
    cwd: opts.cwd,
    stdio: ['ignore', outFd, errFd],
    detached: true,
  })

  // fd 已經 dup2 進子行程、子行程有自己的獨立複本——parent 這邊用不到了，
  // 不關閉的話這兩個 fd 會在長駐的 webhook server 裡一路累積到撞 ulimit -n。
  closeSync(outFd)
  closeSync(errFd)

  child.on('error', err => {
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawn 失敗: ${command} ${args.join(' ')} -> ${err}\n`)
  })

  child.unref()
  return child.pid
}

/**
 * T11：CLAIMED 後 fire-and-forget 觸發 /create-mr 背景流程。
 * cwd 維持 /Users/user/aladdin（不是 dispatcher 自己建 worktree）——實際的
 * worktree 建立仍由 /create-mr 內部呼叫既有的 setup-worktree.sh 完成；T16
 * 規範的『全部涉及 repo 真隔離』透過調整 setup-worktree.sh 達成，不是本函式
 * 的職責。用 timeout 外包逾時（claude -p 本身無內建 timeout/輪次上限）——
 * 這裡的 timeout 是 GNU coreutils 版本，macOS 原生不附，本機透過 Homebrew
 * 安裝（`brew install coreutils`，通常在 /opt/homebrew/bin/timeout）；缺失時
 * 會走上面 spawnDetachedProcess 的 'error' handler，不會炸掉整個 process。
 */
export function spawnCreateMr(ticket: string): number | undefined {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(LOG_DIR, `${ticket}.${timestamp}.log`)

  return spawnDetachedProcess(
    'timeout',
    ['3600', 'claude', '-p', `/create-mr ${ticket}`, '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
    { cwd: '/Users/user/aladdin', logPath },
  )
}
