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
export function spawnDetachedProcess(command: string, args: string[], opts: { cwd: string; stdoutPath: string; stderrPath: string }): number | undefined {
  // stdout/stderr 分開兩個檔案（不是同一個檔案輪流寫）：--output-format json
  // 的 stdout 保證是單一乾淨的 JSON 陣列（實測驗證過），跟 stderr 雜訊混在
  // 同一檔會讓 T12 的分類器得用脆弱的正則去猜 JSON 邊界，遇到雜訊裡剛好有
  // 方括號（如 `[HH:MM:SS]`、`[eslint]` 這類常見前綴）就可能誤判——分開寫
  // 從根本解掉這個問題，T12 直接 JSON.parse(stdout 內容) 即可。
  mkdirSync(dirname(opts.stdoutPath), { recursive: true })
  mkdirSync(dirname(opts.stderrPath), { recursive: true })
  const outFd = openSync(opts.stdoutPath, 'a')
  const errFd = openSync(opts.stderrPath, 'a')

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

const POST_RUN_NOTIFY_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/post-run-notify.ts'
const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'

/**
 * T13：EXIT trap 收尾腳本。用 bash -c 的位置參數（$1=ticket, $2=stdoutPath）
 * 而非字串內插組進 script 本體——ticket 雖已過 TICKET_RE 驗證，但位置參數
 * 傳遞是更直接的免注入寫法，不依賴驗證正確性。
 *
 * trap 綁在 EXIT，不管 timeout/claude 是正常結束、被 timeout 殺（124）、還是
 * 中途 crash 都會觸發，且是同一個 shell（不是 subshell），$? 在 trap 內第一行
 * 讀到的就是 timeout/claude 那行的結束碼——先存進 EC 再往下呼叫別的指令，
 * 避免被後面指令的 $? 蓋掉。
 *
 * release 呼叫本身是安全網、非唯一釋放點：create-mr.md Step 8『所有出口路徑
 * 必經』本身已經會 release 同一張鎖；bug-lock.sh release 對已釋放/未上鎖的
 * ticket 是 no-op（見 scripts/bug-lock.sh 的 NOT_LOCKED 分支，exit 0），這裡
 * 重複呼叫無害，只補上 claude -p 被 kill/crash 導致 create-mr 自己根本沒機會
 * 跑到 Step 8 的那個縫。
 *
 * release 與 post-run-notify 都接 `>/dev/null 2>&1`——兩者的 stdout 跟
 * timeout/claude 共用同一個 fd（T11 的 stdio 設定），trap 在 claude 那行結束
 * 之後才觸發，若不遮蔽，release 的 "RELEASED: ..." 之類文字會被續寫進同一個
 * stdout log 檔，接在 claude 吐出的 JSON 陣列後面，破壞 T11「stdout 保證是
 * 單一乾淨 JSON」的前提，也是 post-run-notify.ts 自己接下來要 JSON.parse 的
 * 那份檔案——必須先確保它沒被弄髒。
 */
const WRAPPER_SCRIPT = `
trap '
  EC=$?
  bash ${BUG_LOCK_SH} release "$1" >/dev/null 2>&1
  bun ${POST_RUN_NOTIFY_TS} "$1" "$EC" "$2" >/dev/null 2>&1
' EXIT
timeout 3600 claude -p "/create-mr $1" --permission-mode bypassPermissions --output-format json
`

/**
 * T11：CLAIMED 後 fire-and-forget 觸發 /create-mr 背景流程。
 * cwd 維持 /Users/user/aladdin（不是 dispatcher 自己建 worktree）——實際的
 * worktree 建立仍由 /create-mr 內部呼叫既有的 setup-worktree.sh 完成；T16
 * 規範的『全部涉及 repo 真隔離』透過調整 setup-worktree.sh 達成，不是本函式
 * 的職責。用 timeout 外包逾時（claude -p 本身無內建 timeout/輪次上限）——
 * 這裡的 timeout 是 GNU coreutils 版本，macOS 原生不附，本機透過 Homebrew
 * 安裝（`brew install coreutils`，通常在 /opt/homebrew/bin/timeout）；缺失時
 * `timeout`/`claude` command not found 是 bash script **內部**執行才知道的事
 * （exit code 127，落在 WRAPPER_SCRIPT 的 EXIT trap 裡被當成 infra_failure
 * 分類、觸發補發通知——見 T13），不會觸發 Node 這邊 spawnDetachedProcess 的
 * 'error' event（該 event 只在 spawn `bash` 這個可執行檔本身失敗時才觸發，
 * T13 之前直接 spawn `timeout` 時才適用，該版行為已被下面的 wrapper 取代）。
 *
 * T13：實際 spawn 的指令換成 bash -c 包住的 WRAPPER_SCRIPT（見上方），不是
 * 直接 spawn timeout。刻意不用 Node 側 child.on('exit', ...) 監聽來做收尾：
 * spawnDetachedProcess 本來就是為了讓這個背景流程完全脫離 webhook server 的
 * 行程生命週期（見該函式註解），若收尾邏輯綁在 Node 的事件監聽上，webhook
 * server 重啟/崩潰就會漏接收尾——違背 detached+unref 當初的設計初衷。改用
 * bash trap，讓收尾邏輯跟著這個獨立行程本身走，不依賴 Node 父行程存活。
 */
export function spawnCreateMr(ticket: string): number | undefined {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${ticket}.${timestamp}`
  const stdoutPath = join(LOG_DIR, `${base}.stdout.log`)
  const stderrPath = join(LOG_DIR, `${base}.stderr.log`)

  return spawnDetachedProcess('bash', ['-c', WRAPPER_SCRIPT, 'run-create-mr', ticket, stdoutPath], {
    cwd: '/Users/user/aladdin',
    stdoutPath,
    stderrPath,
  })
}
