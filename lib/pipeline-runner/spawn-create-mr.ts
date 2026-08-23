import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { GLOBAL_CONCURRENCY_LIMIT, createConcurrencyLimiter } from './concurrency-limiter.ts'
import { markPipelineActive, clearPipelineActive } from './active-pipeline-marker.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SPAWN_ERROR_LOG = join(LOG_DIR, 'spawn-errors.log')
const TICKET_RE = /^FAQ-\d+$/

// T26：全 process 共用同一份額度，這個檔案是唯一消費者（見
// concurrency-limiter.ts 檔頭註解）——tryAcquire 用在下面 spawnCreateMr，
// release 用在背景 process 的 exit/error handler。
const concurrencyLimiter = createConcurrencyLimiter(GLOBAL_CONCURRENCY_LIMIT)

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
 *
 * opts.onExit（T26）：背景 process 真正結束時呼叫一次，不管是正常結束、被
 * timeout 殺、還是中途 crash（'exit' event 不分結束原因都會觸發，見下方
 * 'exit'/'error' 兩個 listener 為何都接、且都經過同一個 guard 保證只呼叫一
 * 次）。用來讓 T26 的全域併發計數器在背景流程真的結束時才釋放名額，不是猜
 * 一個固定時間之後就當作結束——事件驅動，不是 sleep/輪詢。
 */
export function spawnDetachedProcess(
  command: string,
  args: string[],
  opts: { cwd: string; stdoutPath: string; stderrPath: string; env?: NodeJS.ProcessEnv; onExit?: () => void },
): number | undefined {
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
    // T16 需要多帶 DISPATCHER_TRIGGERED 這一個 key，這裡永遠明確展開
    // { ...process.env, ...opts.env }（不是把 env 設成 undefined 交給
    // runtime 預設），確保 TG_DISPATCH_BOT_TOKEN 這類既有必要環境變數不會
    // 被意外丟掉。刻意不依賴「省略 env 時預設繼承」這個行為：這個專案實際
    // 跑在 Bun 上，Bun 的 spawn 對「省略/undefined」的 env 走的是行程啟動
    // 時的環境快照（不是呼叫當下即時讀 process.env），跟 Node 的語意不完全
    // 一樣（review 實測發現）——明確展開才是兩邊 runtime 都驗證過正確的寫法。
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  })

  // fd 已經 dup2 進子行程、子行程有自己的獨立複本——parent 這邊用不到了，
  // 不關閉的話這兩個 fd 會在長駐的 webhook server 裡一路累積到撞 ulimit -n。
  closeSync(outFd)
  closeSync(errFd)

  // 'error'（spawn 本身失敗，例如指令不存在）跟 'exit'（process 真的跑過、
  // 結束）理論上互斥，但 Node 對 spawn 失敗時是否還會補發 'exit' 這件事沒有
  // 跨版本/跨平台的穩定保證——用 guard 確保 onExit 不管哪個事件觸發都只算
  // 一次，避免『spawn 失敗卻被兩個 event 各釋放一次名額』這種計數器多釋放
  // 的邊界情況。
  let onExitCalled = false
  function callOnExitOnce(): void {
    if (onExitCalled) return
    onExitCalled = true
    opts.onExit?.()
  }

  child.on('error', err => {
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawn 失敗: ${command} ${args.join(' ')} -> ${err}\n`)
    callOnExitOnce()
  })
  child.on('exit', () => callOnExitOnce())

  child.unref()
  return child.pid
}

const POST_RUN_NOTIFY_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/post-run-notify.ts'
const CLEANUP_WORKTREE_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/cleanup-worktree.ts'
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
 * 那份檔案——必須先確保它沒被弄髒。cleanup-worktree.ts（T28）同一個理由，也
 * 接 `>/dev/null 2>&1`。
 *
 * T28：release 之後、post-run-notify 之前多插一行 cleanup-worktree.ts，一樣
 * 綁在同一個 EXIT trap 裡，跟 release 具備一樣的『無論成功/失敗/中斷都會
 * 執行到』保證（trap 觸發時 timeout/claude 那行已經結束，不管什麼原因）。
 * 用 $1（ticket）即可，不需要 $2（stdoutPath）——worktree 路徑是
 * `/Users/user/aladdin/worktrees/{ticket}/{repo}` 這種固定慣例，不依賴
 * stdout log 內容。cleanup 失敗（例如強制清理仍失敗）只會記進它自己的 log，
 * 不影響這裡的 EC/後續 post-run-notify。
 *
 * review 提出的排序取捨（bug-lock release 排在 cleanup-worktree 之前，不是
 * 之後）：release 先執行代表同一張 ticket 理論上可以在 worktree 還沒清完前
 * 就被重新認領——但反過來若讓 cleanup 排在 release 之前，一旦
 * cleanup-worktree.ts 卡住（四個 repo 的 git worktree remove 逐一跑），鎖會
 * 永遠不釋放，比『worktree 清理跟新流程的 setup-worktree.sh 撞在一起』的風險
 * 更嚴重——後者本來就有自癒機制（setup-worktree.sh 開頭的 attempt 迴圈本來
 * 就會先 `worktree remove --force` + `branch -D` 再 add，見該腳本『1. 建
 * worktree』一節），且同一張單重新被認領到跑進 Step 4 通常要 15–40 分鐘，
 * 窗口極小。兩害相權，維持現有順序（release 優先）。
 */
// T26 實測期間發現並修正（跟 T26 本身無關，屬既有嚴重問題，經使用者確認
// 現在就修）：.claude/commands/create-mr/create-mr.md 是巢狀資料夾結構，
// Claude Code 會把它註冊成帶命名空間的指令 create-mr:create-mr，不是原本
// 這裡寫死的純 /create-mr——用純 /create-mr 呼叫會得到「Unknown command」，
// 整個背景流程立刻結束，完全沒進到 pipeline 邏輯（真實 log 佐證，見 T26
// changelog）。已用真實 claude -p 呼叫 /create-mr:create-mr（帶假單號，30 秒
// timeout 內主動中斷）驗證這個命名空間前綴的指令真的會被辨識、真的開始跑
// pipeline（多輪 tool use），不是憑猜測改。
// claude 必須用絕對路徑，禁止裸呼叫 `claude` 交給 PATH 解析：實測（FAQ-4616
// 2026-08-16 全部五次真實失敗 log + transcript version 欄位）dispatcher spawn
// 出來的 bash 會解析到 ~/node_modules 的舊版 1.0.128（經 ~/.bun/bin/claude
// symlink），該版把 opus alias 對應到已下架的 claude-opus-4-1-20250805、背景
// 小模型用已下架的 claude-3-5-haiku，啟動 1 秒內 API 404 結束，完全沒進
// pipeline。外部以相同 env 模擬卻解析到 .local/bin 的新版——PATH 解析在
// 這條 spawn 鏈上不可靠，直接把「用哪個 claude」從環境問題變成常數。
const CLAUDE_BIN = '/Users/user/.local/bin/claude'

// 模型必須明確指定 --model opus（alias，由 CLI 解析成當下最新的 Opus 正式
// 版），不能省略讓它吃 ~/.claude/settings.json 的使用者預設：settings.json
// 殘留已下架的舊 model ID 時同樣直接 404。alias 而非寫死完整 ID，正是為了
// 不重蹈「寫死的 ID 之後下架」同一個坑。
// unset CLAUDE_EFFORT：server 若是從某個 Claude Code session 裡手動啟動的，
// 會沿繼承鏈把該 session 的 CLAUDE_EFFORT（如 high）一路傳給背景 claude -p；
// 明確清掉，讓背景流程永遠用 CLI 預設 effort，不隨啟動 server 的環境漂移。
// 診斷行寫進 stderr log（失敗案例中該檔一直是空的，不影響 stdout 的乾淨
// JSON 前提）：留下當次真實 PATH 與 claude 解析結果，之後再出現版本漂移
// 可直接從 log 定位，不用重走這次的推理。
export const WRAPPER_SCRIPT = `
trap '
  EC=$?
  bash ${BUG_LOCK_SH} release "$1" >/dev/null 2>&1
  bun ${CLEANUP_WORKTREE_TS} "$1" >/dev/null 2>&1
  bun ${POST_RUN_NOTIFY_TS} "$1" "$EC" "$2" >/dev/null 2>&1
' EXIT
unset CLAUDE_EFFORT
{ echo "diag PATH=$PATH"; echo "diag which claude: $(which -a claude 2>&1 | tr '\\n' ' ')"; echo "diag version: $(${CLAUDE_BIN} --version 2>&1)"; } >&2
timeout 3600 ${CLAUDE_BIN} -p "/create-mr:create-mr $1" --model opus --permission-mode bypassPermissions --output-format json
`

/**
 * T11：CLAIMED 後 fire-and-forget 觸發 /create-mr 背景流程。
 * cwd 維持 /Users/user/aladdin（不是 dispatcher 自己建 worktree）——實際的
 * worktree 建立仍由 /create-mr 內部呼叫既有的 setup-worktree.sh 完成；T16
 * 規範的『全部涉及 repo 真隔離』主要邏輯在 setup-worktree.sh 那邊（AFFECTED
 * 強制展開成全部 MAIN_REPOS），本函式只負責傳遞 DISPATCHER_TRIGGERED=1 這個
 * 訊號——env 沿著 bash 子行程繼承鏈一路傳下去（spawn 的 bash → claude -p →
 * 它自己執行 Step 4 setup-worktree.sh 時的 Bash 呼叫），不需要改
 * create-mr.md 呼叫 setup-worktree.sh 的語法本身。用 timeout 外包逾時
 * （claude -p 本身無內建 timeout/輪次上限）——
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
 *
 * T26（不牴觸上一段）：全域併發計數器改用 Node 側 child.on('exit', ...)
 * （見 spawnDetachedProcess 的 opts.onExit）釋放名額，這裡不是走 bash
 * trap。原因：這個計數器本來就是 in-memory、只存在於「這個 webhook server
 * process 自己記得自己啟動過幾個還沒結束的背景流程」，跟上一段講的『收尾
 * 邏輯要撐過 server 重啟』是不同性質的東西——server 重啟時計數器本來就該
 * 歸零（見 concurrency-limiter.ts 檔頭），不需要、也不可能靠 bash trap 讓
 * 一個活在 Node process 記憶體裡的數字撐過那個 process 自己的重啟。
 *
 * review 發現並修正：tryAcquire 成功之後、真正 spawn 之前這段（mkdirSync／
 * openSync，見 spawnDetachedProcess 開頭）是同步的，理論上可能丟出例外
 * （磁碟滿、EMFILE fd 用盡——spawnDetachedProcess 自己的註解就承認這是長駐
 * process 的真實風險、權限錯誤等）。若在這裡丟例外卻沒接住：(1) 上面已經
 * tryAcquire 佔用的名額永遠不會釋放（onExit 根本沒機會註冊），變成永久洩漏；
 * (2) 例外會一路往上炸穿 claim.ts、whitelist.ts，最後只被 server.ts 的
 * app.onError 接住回 500——Telegram 使用者完全收不到任何回覆，違反 claim.ts
 * 自己的既有原則『每個分支都要有明確回覆，沒有安靜失敗的路徑』。用 try/catch
 * 包住，失敗時歸還名額、寫進既有的 SPAWN_ERROR_LOG（跟 spawnDetachedProcess
 * 的 'error' handler 同一個 log 檔，同一種『記錄但不讓呼叫端連坐』的慣例），
 * 回傳一個獨立的 reason 讓 claim.ts 能回覆使用者明確的失敗訊息。
 */
export function spawnCreateMr(
  ticket: string,
): { ok: true; pid: number | undefined } | { ok: false; reason: 'concurrency_limit' | 'spawn_error' } {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }

  if (!concurrencyLimiter.tryAcquire()) {
    return { ok: false, reason: 'concurrency_limit' }
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${ticket}.${timestamp}`
    const stdoutPath = join(LOG_DIR, `${base}.stdout.log`)
    const stderrPath = join(LOG_DIR, `${base}.stderr.log`)

    // T26 review 修正：在真的 spawn 之前標記「這張單是 dispatcher 觸發的」
    // （見 active-pipeline-marker.ts 檔頭註解）——stale-lock-reaper.ts 只會
    // 對有這份標記的 ticket 動手，避免誤殺人工/批次跑的 pipeline 持有的鎖。
    markPipelineActive(ticket)

    const pid = spawnDetachedProcess('bash', ['-c', WRAPPER_SCRIPT, 'run-create-mr', ticket, stdoutPath], {
      cwd: '/Users/user/aladdin',
      stdoutPath,
      stderrPath,
      // T16：告訴這條背景流程「我是被 dispatcher 觸發的」，setup-worktree.sh
      // 收到這個訊號後強制全部 repo 真隔離（見該腳本內對應註解），根除多人
      // 同時觸發時共用主 repo symlink 的 bootstrap 碰撞風險。單線 /create-mr、
      // /create-mrs 不會設這個環境變數，行為不受影響。
      env: { DISPATCHER_TRIGGERED: '1' },
      // T26：不管背景流程最後是成功、失敗、被 timeout 殺、還是中途 crash，
      // 只要真的結束就釋放名額——見 spawnDetachedProcess 的 'exit'/'error'
      // handler，兩者都保證只呼叫一次。正常結束時一併清掉 active-pipeline
      // 標記（被 kill -9/斷電打斷、onExit 沒機會執行時標記會殘留，這是
      // stale-lock-reaper 需要偵測的訊號，不是缺陷，見該檔案註解）。
      onExit: () => {
        concurrencyLimiter.release()
        clearPipelineActive(ticket)
      },
    })
    return { ok: true, pid }
  } catch (err) {
    concurrencyLimiter.release()
    clearPipelineActive(ticket)
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawnCreateMr 失敗（${ticket}）: ${err}\n`)
    return { ok: false, reason: 'spawn_error' }
  }
}
