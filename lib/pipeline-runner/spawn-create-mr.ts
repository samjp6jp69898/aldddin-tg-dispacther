import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { openSync, closeSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { GLOBAL_CONCURRENCY_LIMIT, createConcurrencyLimiter } from './concurrency-limiter.ts'
import { createPipelineQueue, type QueueEntry, type QueueTriggeredBy, type RecoverFromDiskResult, type SkipReason, type SubmitResult } from './pipeline-queue.ts'
import { markPipelineActive, clearPipelineActive } from './active-pipeline-marker.ts'
import { isTicketLocked } from './ticket-progress.ts'
import { resolveTechUserByEmail, type TechUser } from '../user-resolution/tech-user.ts'
import { writeRunProgress, writeRunOutcomeAuthoritative, type MonitorDbExecutor } from '../monitor-db/writes.ts'
import type { RunKind } from '../monitor-db/types.ts'
import { dispatchMonitorWrite } from '../monitor-db/runtime.ts'
import { BUG_MODES, coerceBugMode, isBugMode, type BugMode } from './bug-mode.ts'
import { snapshotTicketStages } from './stage-snapshot.ts'

// ─────────────────────────────────────────────────────────────────────────
// 監控 DB 化（plan-db-as-truth-v3.2.md §9 Phase2；Bug pipeline 生命週期寫入
// 點）。全部包在 isMonitorDbEnabled() 之後、lazy import（§9.0(B)：關閉時連
// mysql2 都不載入，行為與遷移前逐位元組相同）。
//
// §6.7 熱路徑非阻斷紀律：本檔（含經由 pipeline-queue.ts 的 hook 注入）全部
// 運行在長駐的 webhook server process 裡，呼叫端一律不 await 這裡的寫入——
// dispatchMonitorWrite() 內部自己控制 1000ms 逾時預算，逾時/失敗就落 spool，
// 呼叫端拿到的永遠是立即返回的 void。
//
// 整合修補批次 item 7：pool/spool 單例與 dispatchMonitorWrite 本體已收斂進
// lib/monitor-db/runtime.ts（demand pipeline 的長駐路徑複用同一份，見
// demand-monitor-writes.ts 檔頭）；這裡沿用舊名重新匯出，本檔與呼叫端的
// import 路徑、行為都不變。
// ─────────────────────────────────────────────────────────────────────────

export { dispatchMonitorWrite, __setMonitorTestOverrides, __resetMonitorTestOverrides } from '../monitor-db/runtime.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SPAWN_ERROR_LOG = join(LOG_DIR, 'spawn-errors.log')
const TICKET_RE = /^FAQ-\d+$/

// T26：全 process 共用同一份額度，這個檔案是唯一消費者（見
// concurrency-limiter.ts 檔頭註解）。2026-08-28 起額度交給 pipeline-queue.ts
// 統一管理（tryAcquire 在 submit/drain、release 在背景 process 的 exit/error
// handler），額滿改排隊而非拒絕。
const concurrencyLimiter = createConcurrencyLimiter(GLOBAL_CONCURRENCY_LIMIT)

const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'

/** 排隊的單輪到（或啟動失敗）時通知當初認領的人。fire-and-forget：
 * tg-notify.sh 本身永遠 exit 0、失敗只印一行，不阻斷遞補流程。CLI 觸發
 * （無 triggeredBy）沒有通知對象，跳過。 */
export function notifyQueueEvent(triggeredBy: QueueTriggeredBy, text: string): void {
  if (!triggeredBy?.email) return
  execFile('bash', [TG_NOTIFY_SH, '--email', triggeredBy.email, '--text', text], () => {})
}

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
  opts: {
    cwd: string
    stdoutPath: string
    stderrPath: string
    env?: NodeJS.ProcessEnv
    onExit?: () => void
    /** 【plan-db-as-truth-v3.2.md §9 Phase2】非同步 'error' 事件專用（不是
     * onExit 的替代品，兩者都會被呼叫，見下方 'error' handler）：呼叫端用
     * 這個 hook 分辨「這次 onExit 是因為 spawn 從未真正開始執行」，藉此把
     * 監控 DB 已寫的 running 列改寫成 spawn_error（tier2）——單純用 onExit
     * 分不出這個情況（'exit' 也會呼叫 onExit）。可選：不傳就跟舊行為完全
     * 一樣，不影響 spawn-demand-pipeline.ts / trigger-auto-sync.ts 這兩個
     * 既有呼叫端。 */
    onSpawnError?: (err: Error) => void
  },
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

  // 'error'（spawn 本身失敗，例如指令不存在）跟 'exit'（process 真的跑過、
  // 結束）理論上互斥，但 Node 對 spawn 失敗時是否還會補發 'exit' 這件事沒有
  // 跨版本/跨平台的穩定保證——用 guard 確保 onExit 不管哪個事件觸發都只算
  // 一次，避免『spawn 失敗卻被兩個 event 各釋放一次名額』這種計數器多釋放
  // 的邊界情況。
  //
  // 對抗性 review（2026-08-28）：listener 必須是 spawn() 之後的第一件事——
  // 若在掛 listener 之前（例如下面的 closeSync）丟例外，子行程已在跑但
  // onExit 永遠不會被呼叫，呼叫端 catch 又會歸還名額，實際併發變成
  // LIMIT+1。event 由 event loop 派發，同一個同步區塊內掛上必然來得及。
  let onExitCalled = false
  function callOnExitOnce(): void {
    if (onExitCalled) return
    onExitCalled = true
    opts.onExit?.()
  }

  child.on('error', err => {
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawn 失敗: ${command} ${args.join(' ')} -> ${err}\n`)
    try {
      opts.onSpawnError?.(err)
    } catch (hookErr) {
      console.error(`spawnDetachedProcess: onSpawnError hook 失敗（不影響既有收尾）: ${hookErr}`)
    }
    callOnExitOnce()
  })
  child.on('exit', () => callOnExitOnce())

  // fd 已經 dup2 進子行程、子行程有自己的獨立複本——parent 這邊用不到了，
  // 不關閉的話這兩個 fd 會在長駐的 webhook server 裡一路累積到撞 ulimit -n。
  // try/catch：listener 已掛上，這之後任何 throw 都會讓呼叫端 catch 再釋放
  // 一次名額（與 onExit 的釋放重複＝超賣），所以 close 失敗只記 log 不拋出。
  try {
    closeSync(outFd)
    closeSync(errFd)
  } catch (err) {
    console.error(`spawnDetachedProcess: closeSync 失敗（不影響子行程）: ${err}`)
  }

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

// 2026-09-14：-p 呼叫本身改走 claude-p-rate-watch.sh（透明包裝，額外監控 -p
// 呼叫的 5hr/weekly rate limit；stdout/exit code/訊號轉送對呼叫端完全透通，見
// aladdin_ai/scripts/claude-p-rate-watch.sh 檔頭說明）。上面的 CLAUDE_BIN 保留
// 給 241 行診斷用的 --version 檢查，維持原本「不透過 PATH、鎖死真正 binary」
// 的用意不變，不受這次改動影響。
const CLAUDE_P_WRAPPER = '/Users/user/aladdin/scripts/claude-p-rate-watch.sh'

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
timeout 10800 ${CLAUDE_P_WRAPPER} -p "/create-mr:create-mr $1 $3 $4" --model opus --permission-mode bypassPermissions --output-format stream-json --verbose
`
// --output-format 於 2026-08-26 由 json 改為 stream-json（+ -p 模式必帶的
// --verbose）：舊格式整包 JSON 在行程結束那一刻才 flush，執行中 stdout 永遠
// 0 bytes（tg-monitor 的 Agent 流程/log 進度整段空白），被 timeout 砍掉的
// run 更是**連事後都一無所有**（無從 debug，實際踩過 FAQ-4743 timeout 全空）。
// stream-json 逐行 JSONL 即時落盤，事件物件結構與舊格式陣列元素相同，最後
// 一行仍是 type=result。下游解析（classify-result.ts、tg-monitor ingest）
// 均已改為「先試整檔 JSON（相容歷史 log），失敗再逐行 JSONL」雙格式支援。
// $3 = 執行模式（2026-09-08，plan-pipeline-modes-v1 §2.2）：恆為 BUG_MODES 之一
// （full|analysis|fix|reanalyze，spawnCreateMrNow 用 coerceBugMode 保證不會是
// 空字串或任意字串——舊佇列檔恢復出來的 entry 沒有 mode 欄也會落回 full）。
// $4 = resume 模式參數：只會傳字面 'resume' 或空字串（TS 端寫死，不接受任意
// 字串，杜絕注入面）。空字串時 prompt 尾端多一個空白，無害。
// ⚠ 這些位置參數是 ps 命令列掃描契約的一部分：tg-monitor lib/ingest.ts、本目錄
// post-run-notify.ts 與 local-proc-scan.ts 都用
// `run-create-mr <ticket> <stdout> [mode] [resume]` 的尾端樣式辨識 wrapper 行程
// ——要再加新的位置參數，三處 regex 必須同步放行（2026-08-26 加 resume 時漏了，
// resume run 被監控面板誤判成已結束，實際踩過；2026-09-08 加 mode 時三處已同步）。

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
// 2026-08-28（使用者定案）：額滿改排隊。spawnCreateMrNow 是「真正起背景流程」
// 的部分（不含額度檢查），額度與 FIFO 佇列交給 bugQueue 統一管理——排隊、
// 遞補、重啟恢復的完整語意見 pipeline-queue.ts 檔頭註解。
//
// 【plan-db-as-truth-v3.2.md §5.2】runId／retryOfRunId 由 submitCreateMr 在
// 呼叫 bugQueue.submit() 之前鑄好、放進 payload——不管這張單最後是直接 spawn
// 還是先進 FIFO 佇列，同一次 submitCreateMr 呼叫只鑄一個 run_id，兩條路徑
// 用的是同一個值（佇列的 onEnqueued 寫 queued/rank10，這裡的 spawn choke
// point 寫 running/rank30，ODKU 的 GREATEST 語意讓寫入順序不影響最終結果）。
// dispatchId（整合修補批次 item 6）：head 派工經 /jobs 帶來的 dispatch_id
// （§5.3），worker 端鑄 run_id 時一併寫進 runs.dispatch_id（W1 COALESCE 補
// 空欄），讓 dispatch_attempts.dispatch_id = runs.dispatch_id 可以精確 join。
// 本機直接觸發（head 自己跑、CLI、reaper auto-retry）沒有這個值，恆為 null。
export type BugPayload = {
  resume: boolean
  mode: BugMode
  /** 認領當下 Notion「AI分析」的原始值，供 tg-monitor 詳情頁顯示這一輪的
   * 起始狀態（見 monitor-db migration 007）。舊佇列檔恢復出來的 entry 沒有
   * 這欄時為 null，不強行補值。 */
  aiAnalysis: string | null
  runId: string
  retryOfRunId: string | null
  dispatchId: string | null
}

const BUG_RUN_KIND: RunKind = 'bug'

function spawnCreateMrNow(entry: QueueEntry<BugPayload>, onExit: () => void): { ok: true; pid: number | undefined } | { ok: false } {
  const { ticket } = entry
  const { runId, retryOfRunId, dispatchId, aiAnalysis } = entry.payload
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${ticket}.${timestamp}`
    const stdoutPath = join(LOG_DIR, `${base}.stdout.log`)
    const stderrPath = join(LOG_DIR, `${base}.stderr.log`)

    // tg-monitor「發起人」欄位讀這份 sidecar（同 base 名，見該 repo
    // lib/ingest.ts 的 scanPipelineRuns）——記錄的是「當時點擊 Telegram 認領
    // 這張單的人」，不是 Notion 當前指派（那個欄位事後會被改派掉，例如轉測試
    // 給非技術人員，跟「誰觸發了這次分析」是兩件事，2026-08-27 使用者要求
    // 分開）。best-effort：寫檔失敗不阻斷 spawn，只是這次 run 之後顯示不出
    // 發起人。
    if (entry.triggeredBy) {
      try {
        writeFileSync(
          join(LOG_DIR, `${base}.triggered-by.json`),
          JSON.stringify({ name: entry.triggeredBy.name, email: entry.triggeredBy.email, at: new Date().toISOString() }),
        )
      } catch {
        // best-effort，理由同上。
      }
    }

    // T26 review 修正：在真的 spawn 之前標記「這張單是 dispatcher 觸發的」
    // （見 active-pipeline-marker.ts 檔頭註解）——stale-lock-reaper.ts 只會
    // 對有這份標記的 ticket 動手，避免誤殺人工/批次跑的 pipeline 持有的鎖。
    // 【v3.2 §6.4(4) R2】標記內容一併帶上 runId/kind，供 cancel 五段解析與
    // reaper 的自動重試血緣（§5.7）本機讀取，不需要碰監控 DB。
    markPipelineActive(ticket, { runId, kind: BUG_RUN_KIND })

    // 【plan-db-as-truth-v3.2.md §9 Phase2】spawn 是唯一 choke point：拿到
    // pid 才寫 running（W1），拿不到 pid 一律視同 spawn 失敗、寫權威終態
    // spawn_error（tier2，W2）——見下方 onSpawnError（非同步 'error' 事件的
    // 對應分支）與 catch 區塊（同步例外的對應分支）。三個分支共用同一個
    // runId，寫入哪一種終態互斥於「有沒有真的拿到 pid」，不會重複寫。
    const legacyKey = base

    // 位置參數 $3 = mode（BUG_MODES 封閉值域；佇列檔恢復出來的舊 entry 沒有
    // mode 欄 → coerce 成 full）、$4 = 'resume' 或 ''——見 WRAPPER_SCRIPT 尾註解，
    // 不把呼叫端任意字串放進 prompt。
    const mode = coerceBugMode(entry.payload.mode)
    const pid = spawnDetachedProcess('bash', ['-c', WRAPPER_SCRIPT, 'run-create-mr', ticket, stdoutPath, mode, entry.payload.resume ? 'resume' : ''], {
      cwd: '/Users/user/aladdin',
      stdoutPath,
      stderrPath,
      // T16：告訴這條背景流程「我是被 dispatcher 觸發的」，setup-worktree.sh
      // 收到這個訊號後強制全部 repo 真隔離（見該腳本內對應註解），根除多人
      // 同時觸發時共用主 repo symlink 的 bootstrap 碰撞風險。單線 /create-mr、
      // /create-mrs 不會設這個環境變數，行為不受影響。
      // MON_RUN_ID（v3.2 §5.2）：一律顯式覆寫成這次 spawn 鑄好的 run_id——
      // post-run-notify.ts／auto-retry 沿這條 env 繼承鏈讀到的正是這個值。
      // MON_BUG_MODE（2026-09-08）：同一招——EXIT trap 裡的 post-run-notify.ts
      // 觸發 timeout 自動重試時，submitCreateMr 預設從這個 env 繼承模式，讓
      // 「只做問題分析」的票重試後仍是只做問題分析，不會退化成一鍵。
      env: { DISPATCHER_TRIGGERED: '1', MON_RUN_ID: runId, MON_BUG_MODE: mode },
      // 【v3.2 §9 Phase2】非同步 'error' 事件：child 從未真正開始執行，若
      // 上面已經（樂觀地）寫過 running，這裡要把它改寫成 spawn_error（W2 的
      // 守衛允許覆寫 outcome IS NULL 的列，不會跟下面成功路徑衝突——二者
      // 互斥，只有其中一個會真的執行到）。
      onSpawnError: () => {
        dispatchMonitorWrite(
          'writeRunOutcomeAuthoritative',
          { runId, ticket, kind: BUG_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-detached-error', finishedAt: new Date().toISOString() },
          pool =>
            writeRunOutcomeAuthoritative(pool, {
              runId,
              ticket,
              kind: BUG_RUN_KIND,
              outcome: 'spawn_error',
              outcomeSource: 'spawn-detached-error',
              finishedAt: new Date().toISOString(),
            }),
        )
      },
      // T26：不管背景流程最後是成功、失敗、被 timeout 殺、還是中途 crash，
      // 只要真的結束就釋放名額（onExit 由 bugQueue 傳入：release + 遞補下一張
      // 排隊的單）——見 spawnDetachedProcess 的 'exit'/'error' handler，兩者
      // 都保證只呼叫一次。正常結束時一併清掉 active-pipeline 標記（被
      // kill -9/斷電打斷、onExit 沒機會執行時標記會殘留，這是
      // stale-lock-reaper 需要偵測的訊號，不是缺陷，見該檔案註解）。
      // 順序硬約束（對抗性 review 2026-08-28）：clearPipelineActive 必須在
      // onExit() **之前**——onExit 內的 drain 是同步的，若隊頭恰是同一張
      // ticket，遞補的新 run 會先 markPipelineActive，後執行的 clear 會把
      // 新標記誤刪，讓新 run 脫離 stale-lock-reaper 保護。
      onExit: () => {
        // 【pipeline-modes Phase 3】run 結束時把各 stage 的完成狀態與「產物在
        // 這台機器上」寫進 ticket_stages（§3：確定性寫入，不靠 manager LLM 記得
        // 呼叫）。runId/mode 直接取自本 closure，不去讀 marker——順序上更穩
        // （clearPipelineActive 之後 marker 就沒了），值也更權威。非阻斷、
        // 自己吞例外、MON_DB_ENABLED 關閉時整支 no-op，故意不 await：
        // clearPipelineActive → onExit 的既有順序硬約束（見下）一個字不動。
        void snapshotTicketStages(ticket, { runId, mode })
        clearPipelineActive(ticket)
        onExit()
      },
    })

    if (pid === undefined) {
      // 【MJ-C8(a)】拿不到 pid（罕見：fork 本身失敗但沒有走到上面
      // catch/onSpawnError 那兩條路徑）：不寫 running，直接寫 spawn_error。
      dispatchMonitorWrite(
        'writeRunOutcomeAuthoritative',
        { runId, ticket, kind: BUG_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-no-pid', finishedAt: new Date().toISOString() },
        pool =>
          writeRunOutcomeAuthoritative(pool, {
            runId,
            ticket,
            kind: BUG_RUN_KIND,
            outcome: 'spawn_error',
            outcomeSource: 'spawn-no-pid',
            finishedAt: new Date().toISOString(),
          }),
      )
    } else {
      dispatchMonitorWrite(
        'writeRunProgress',
        {
          runId,
          ticket,
          kind: BUG_RUN_KIND,
          initialAiAnalysis: aiAnalysis,
          lifecycleRank: 30 as const,
          startedAt: new Date().toISOString(),
          pid,
          stdoutPath,
          stderrPath,
          triggerSource: entry.triggeredBy ? 'telegram' : 'cli',
          retryOfRunId,
          dispatchId,
          legacyKey,
          triggeredByEmail: entry.triggeredBy?.email ?? null,
          triggeredByName: entry.triggeredBy?.name ?? null,
        },
        pool =>
          writeRunProgress(pool, {
            runId,
            ticket,
            kind: BUG_RUN_KIND,
            initialAiAnalysis: aiAnalysis,
            lifecycleRank: 30,
            startedAt: new Date().toISOString(),
            pid,
            stdoutPath,
            stderrPath,
            triggerSource: entry.triggeredBy ? 'telegram' : 'cli',
            retryOfRunId,
            dispatchId,
            legacyKey,
            triggeredByEmail: entry.triggeredBy?.email ?? null,
            triggeredByName: entry.triggeredBy?.name ?? null,
          }),
      )
    }

    return { ok: true, pid }
  } catch (err) {
    clearPipelineActive(ticket)
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawnCreateMr 失敗（${ticket}）: ${err}\n`)
    // 【MJ-C8(a)】同步例外（mkdirSync/openSync 失敗等）：這張單從未真正 spawn，
    // 寫權威終態 spawn_error（tier2）——markPipelineActive 在更前面已執行過，
    // runId 已鑄定，不會是空值。
    dispatchMonitorWrite(
      'writeRunOutcomeAuthoritative',
      { runId, ticket, kind: BUG_RUN_KIND, outcome: 'spawn_error', outcomeSource: 'spawn-sync-exception', finishedAt: new Date().toISOString() },
      pool =>
        writeRunOutcomeAuthoritative(pool, {
          runId,
          ticket,
          kind: BUG_RUN_KIND,
          outcome: 'spawn_error',
          outcomeSource: 'spawn-sync-exception',
          finishedAt: new Date().toISOString(),
        }),
    )
    return { ok: false }
  }
}

// 出列/恢復時的前提重驗（對抗性 review 2026-08-28 發現的 TOCTOU：submit
// 當下 claim.ts 檢查過 isTicketLocked，但排隊可能把 spawn 延後數小時，期間
// 別的入口——人工終端機、/create-mrs 批次、tg-monitor CLI——可能已把同一張
// 單跑起來；不重驗就 spawn 的重複 run 在 Step 0.1 早退後，EXIT trap 會
// release 存活 run 的鎖並清掉它的 worktree）。時效上限：排隊超過 24 小時的
// 單，工單狀態多半已變（被人工處理/改派），不再自動 spawn，通知發起人
// 重新認領。兩者都是出列當下的一次性檢查，不是輪詢。
export const MAX_QUEUE_WAIT_MS = 24 * 3600 * 1000

// code 語意（onSkipped 據此決定收尾動作，見 SkipReason 型別註解）：
// - locked：別的流程正在跑這張單——它會自行回報結果與收尾狀態，這裡**絕不能**
//   動工單狀態（否則會蓋掉存活 run 正在維護的狀態），只通知發起人不用重複認領。
// - expired：排隊逾時、沒有任何流程在跑——需求側要把 Notion AI分析 改回
//   「需要重跑」讓單子回到可認領池（見 spawn-demand-pipeline.ts 的 onSkipped）。
export function makeQueueSkipReason<P>(opts: { lockDir?: string } = {}): (entry: QueueEntry<P>) => SkipReason | null {
  return entry => {
    if (isTicketLocked(entry.ticket, opts)) return { code: 'locked', text: '偵測到已有另一個流程正在處理這張單（鎖存在），不重複觸發' }
    const enqueuedMs = Date.parse(entry.enqueuedAt)
    if (Number.isFinite(enqueuedMs) && Date.now() - enqueuedMs > MAX_QUEUE_WAIT_MS) return { code: 'expired', text: '排隊已超過 24 小時，工單狀態可能已變更' }
    return null
  }
}

const bugQueue = createPipelineQueue<BugPayload>({
  limiter: concurrencyLimiter,
  stateFile: join(LOG_DIR, 'pipeline-queue.bug.json'),
  ticketRe: TICKET_RE,
  spawnNow: spawnCreateMrNow,
  skipReason: makeQueueSkipReason<BugPayload>(),
  // §5.6（BL-C5）：供 recoverFromDisk() 回傳 run_id 陣列。
  getRunId: p => p.runId,
  // 【plan-db-as-truth-v3.2.md §9 Phase2】enqueue/dequeue-skip 寫入點：
  // 額滿真的進入 FIFO 佇列 → queued（W1 rank10）；出列/恢復前提重驗判定要
  // skip → 對應的權威終態（tier2）。onEnqueued/onSkipped 是 pipeline-queue.ts
  // 的通用 hook（純注入，2B 的 demand 佇列可直接複用同一組欄位），DB 寫入
  // 邏輯全部留在這裡（bug 專屬），不寫進 pipeline-queue.ts 本身。
  onEnqueued: entry =>
    dispatchMonitorWrite(
      'writeRunProgress',
      {
        runId: entry.payload.runId,
        ticket: entry.ticket,
        kind: BUG_RUN_KIND,
        lifecycleRank: 10 as const,
        retryOfRunId: entry.payload.retryOfRunId,
        dispatchId: entry.payload.dispatchId,
      },
      pool =>
        writeRunProgress(pool, {
          runId: entry.payload.runId,
          ticket: entry.ticket,
          kind: BUG_RUN_KIND,
          lifecycleRank: 10,
          retryOfRunId: entry.payload.retryOfRunId,
          dispatchId: entry.payload.dispatchId,
        }),
    ),
  // 【MA-3】backlog-dispatcher 成功把排隊中的單派給 worker：head 這邊
  // onEnqueued 寫的 queued（rank10）列到此收尾——寫 dispatched_to_worker
  // （tier 2，KNOWN_OUTCOME_TIER 早已定義、reviewer 查明從未有人寫入）。之後
  // 這張單由 worker 自己鑄的 run_id 追蹤；head 列不收尾的話就是幽靈 queued，
  // 下次重啟被 restart sweep 錯標 lost_on_restart。
  onDispatchedRemote: entry => {
    const finishedAt = new Date().toISOString()
    dispatchMonitorWrite(
      'writeRunOutcomeAuthoritative',
      { runId: entry.payload.runId, ticket: entry.ticket, kind: BUG_RUN_KIND, outcome: 'dispatched_to_worker', outcomeSource: 'backlog-dispatch', finishedAt },
      pool =>
        writeRunOutcomeAuthoritative(pool, {
          runId: entry.payload.runId,
          ticket: entry.ticket,
          kind: BUG_RUN_KIND,
          outcome: 'dispatched_to_worker',
          outcomeSource: 'backlog-dispatch',
          finishedAt,
        }),
    )
  },
  // Bug 單被 skip 沒有死路問題：tracker 仍是 pending、Notion 指派未動，隨時
  // 可重新認領（locked 情況則根本不需要重新認領，執行中的流程會自行回報）。
  onSkipped: (entry, reason) => {
    // code 值域見 makeQueueSkipReason：'locked' → 別的流程正在跑，這裡完全
    // 不動它的狀態（W2 的守衛只覆寫 outcome IS NULL 或 tier<2 的列，若那個
    // 存活 run 已經寫過權威終態，這條 skipped_locked 也不會覆寫掉它）；
    // 'expired' → 排隊逾時、沒有任何流程在跑，寫 skipped_expired。
    const outcome = reason.code === 'locked' ? 'skipped_locked' : reason.code === 'expired' ? 'skipped_expired' : null
    if (outcome) {
      const finishedAt = new Date().toISOString()
      dispatchMonitorWrite(
        'writeRunOutcomeAuthoritative',
        { runId: entry.payload.runId, ticket: entry.ticket, kind: BUG_RUN_KIND, outcome, outcomeSource: 'pipeline-queue-skip', finishedAt },
        pool =>
          writeRunOutcomeAuthoritative(pool, {
            runId: entry.payload.runId,
            ticket: entry.ticket,
            kind: BUG_RUN_KIND,
            outcome,
            outcomeSource: 'pipeline-queue-skip',
            finishedAt,
          }),
      )
    }
    notifyQueueEvent(
      entry.triggeredBy,
      reason.code === 'locked'
        ? `ℹ️ ${entry.ticket} 已從等待佇列移除：${reason.text}。該流程會自行回報結果，不需要重新認領。`
        : `ℹ️ ${entry.ticket} 已從等待佇列移除：${reason.text}。若仍需要分析，請重新認領一次。`,
    )
  },
  onDequeueStarted: entry =>
    notifyQueueEvent(entry.triggeredBy, `▶️ ${entry.ticket} 排隊結束，背景流程已自動開始處理，完成後會再通知你。`),
  onDequeueFailed: entry =>
    notifyQueueEvent(entry.triggeredBy, `⚠️ ${entry.ticket} 輪到執行時背景流程啟動失敗，請重新認領一次或聯絡維運人員檢查 spawn-errors.log。`),
  onExited: ticket => {
    for (const cb of bugExitListeners) {
      try {
        cb(ticket)
      } catch (err) {
        console.error(`spawn-create-mr: exit listener 失敗（${ticket}）: ${err}`)
      }
    }
  },
})

// 多機派工（lib/cluster/）用的旁路出口。三者都只讀本 process 的 in-memory
// 狀態，跟 limiter/queue 同壽命，不新增任何檔案狀態。
const bugExitListeners: Array<(ticket: string) => void> = []

/** 註冊「任一 Bug 背景流程真的結束」的旁聽 callback（worker-agent.ts 用來
 * 回報 head 完成事件）。呼叫時點在名額釋放與遞補之後，見 pipeline-queue.ts
 * 的 onExited 註解。 */
export function registerBugPipelineExitListener(cb: (ticket: string) => void): void {
  bugExitListeners.push(cb)
}

/** 本 process 的 Bug pipeline 名額實況（/capacity 回報與派工選擇用）。 */
export function getBugQueueStats(): { limit: number; running: number; queued: number } {
  return { limit: GLOBAL_CONCURRENCY_LIMIT, running: bugQueue.runningCount(), queued: bugQueue.size() }
}

/** 這張 Bug 單在本 process 是否執行中/排隊中（多機派工的重複防護用）。 */
export function hasBugTicketActive(ticket: string): 'running' | 'queued' | null {
  return bugQueue.has(ticket)
}

/** running 集合快照（見 pipeline-queue.ts runningTickets 註解）。 */
export function getBugRunningTickets(): string[] {
  return bugQueue.runningTickets()
}

/** 多機派工（lib/cluster/backlog-dispatcher.ts）用的旁路出口：把 head 本機
 * Bug 佇列的隊頭遞補去某台剛釋放名額的 worker，見 pipeline-queue.ts
 * tryDispatchFront 註解。 */
export function tryDispatchBugQueueFront(attempt: (entry: QueueEntry<BugPayload>) => Promise<boolean>): Promise<'empty' | 'dispatched' | 'declined'> {
  return bugQueue.tryDispatchFront(attempt)
}

/**
 * 提交一張 Bug 單：有名額直接 spawn（started）、額滿排入 FIFO 佇列（queued，
 * 回覆順位讓認領人知道要等幾張）、已在排隊中則回 already_queued 不重複排。
 *
 * 【plan-db-as-truth-v3.2.md §5.2】run_id 鑄造機＝執行機，鑄造時機是「這次
 * submitCreateMr 呼叫本身」（不管最後走 started 還是 queued，同一次呼叫只
 * 鑄一個 run_id，見 BugPayload 型別註解）。
 *
 * retry 血緣（§5.2 的「繼承值改作血緣」）：`opts.retryOf` 顯式指定時優先
 * （stale-lock-reaper.ts 的常駐行程用這條——它的 `process.env.MON_RUN_ID`
 * 恆空，見該檔案對應註解）；否則讀 `process.env.MON_RUN_ID`——這正是
 * post-run-notify.ts 觸發 auto-retry 時的機制：post-run-notify.ts 是
 * WRAPPER_SCRIPT 的 EXIT trap 子行程，繼承了「這一輪 run」spawn 時被顯式
 * 覆寫的 `MON_RUN_ID`（見 spawnCreateMrNow 的 env），此處讀到的正是「上一輪
 * run 的 id」，天然成為新 run 的 `retry_of_run_id`，不需要額外傳遞。
 */
export function submitCreateMr(
  ticket: string,
  opts: { resume?: boolean; mode?: BugMode; aiAnalysis?: string; triggeredBy?: TechUser; retryOf?: string; dispatchId?: string } = {},
): SubmitResult {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }
  if (opts.mode !== undefined && !isBugMode(opts.mode)) {
    throw new Error(`拒絕 spawn：mode 不在值域內（${String(opts.mode)}），可能是注入嘗試`)
  }
  const triggeredBy: QueueTriggeredBy = opts.triggeredBy
    ? { name: opts.triggeredBy.notion_user_name, email: opts.triggeredBy.email }
    : null
  const runId = randomUUID()
  const retryOfRunId = opts.retryOf ?? ((process.env.MON_RUN_ID ?? '').trim() || null)
  // mode 解析順序：呼叫端顯式指定 > 上一輪 run 的 MON_BUG_MODE（EXIT trap 子行程
  // 自動重試繼承，與 retryOfRunId 同一條 env 鏈）> full。常駐 server/worker
  // 行程沒有 MON_BUG_MODE，顯式未給就是 full——跟加 mode 之前的行為相同。
  const mode: BugMode = opts.mode ?? coerceBugMode(process.env.MON_BUG_MODE)
  // aiAnalysis：純顯示用途，不像 mode 需要跨行程 env 繼承鏈——auto-retry
  // 沒有顯式帶的話就是 null（這一輪並非源自一次新的 Notion 認領，留白比
  // 硬套一個不準確的值更誠實）。
  const aiAnalysis = opts.aiAnalysis ?? null
  const result = bugQueue.submit(ticket, triggeredBy, { resume: !!opts.resume, mode, aiAnalysis, runId, retryOfRunId, dispatchId: opts.dispatchId ?? null })
  if (result.ok && (result.status === 'started' || result.status === 'queued')) {
    return { ...result, runId }
  }
  return result
}

/** 只給 server.ts 啟動時呼叫一次（CLI 短命行程絕不能呼叫，見 pipeline-queue.ts
 * recoverFromDisk 註解）。 */
export function recoverBugQueue(): RecoverFromDiskResult {
  return bugQueue.recoverFromDisk()
}

/**
 * CLI 進入點（`bun spawn-create-mr.ts <ticket>`）：給非本 repo 的外部呼叫端
 * （2026-08-25 起：tg-monitor 的 /api/pipelines/retry）用行程邊界呼叫本模組，
 * 不要用跨 repo 相對路徑 import——那樣會把呼叫端耦合到這個模組的內部型別、
 * 傳遞依賴（concurrency-limiter.ts 等）與模組級 singleton 狀態（見上面
 * `concurrencyLimiter` 的檔頭註解：這個計數器故意 in-memory、只代表「這個
 * process 自己記得的名額」，被 tg-monitor 那種獨立 process import 進去只會
 * 得到一份從 0 開始、永遠不知道真正 webhook server 佔用了多少名額的假副本），
 * 而且兩個 repo 各自獨立的 git 生命週期下，import 端完全無法在自己的 CI/
 * 測試裡發現這裡簽名或路徑跑掉——用 CLI 呼叫，介面就是「進程 + argv + exit
 * code」，天然不會有這些問題。並發上限請呼叫端自己用 ps 現場計數把關（tg-monitor
 * 的 listRunningPipelineProcs() 就是這樣做的），不要依賴這裡的 in-memory
 * 限流當作真正上限。
 */
if (import.meta.main) {
  const ticket = process.argv[2] ?? ''
  // `--resume`（2026-08-26）：tg-monitor 重試按鈕帶入，讓 /create-mr 走 Step 0.2
  // 續跑盤點（從上一輪最後完成的階段接續）。只認這個字面 flag，其餘一律當
  // 沒帶（不把任意 argv 轉發進 claude prompt）。
  //
  // 排隊機制（2026-08-28）對這條 CLI 路徑無感：CLI 是短命行程，limiter 從 0
  // 起算，submit 永遠拿得到名額、只會走 started / spawn_error 兩種結果，絕不
  // 會把單留在一個馬上就要結束的 process 的 in-memory 佇列裡。真正的併發上限
  // 由呼叫端（tg-monitor）自己用 ps 現場計數把關，跟以前一樣。
  const resume = process.argv.includes('--resume')
  // `--mode <full|analysis|fix|reanalyze>`（2026-09-08）：值域外直接拒絕 spawn
  // （exit 1），比照 --triggered-by-email 的紀律——寧可讓呼叫端重來，不要靜默
  // 跑成一鍵。省略時交給 submitCreateMr 的預設（MON_BUG_MODE 繼承 → full）。
  let mode: BugMode | undefined
  const modeFlagIdx = process.argv.indexOf('--mode')
  if (modeFlagIdx !== -1) {
    const raw = process.argv[modeFlagIdx + 1] ?? ''
    if (!isBugMode(raw)) {
      console.log(JSON.stringify({ ok: false, reason: `--mode 值不合法：${raw || '(空)'}（允許：${BUG_MODES.join('|')}）` }))
      process.exit(1)
    }
    mode = raw
  }
  // `--triggered-by-email <email>`（2026-09-01）：非 Telegram 觸發的重跑（人工
  // CLI、tg-monitor 重試）預設不會寫 triggered-by sidecar，tg-monitor「發起人」
  // 欄會空白。呼叫端可帶原認領人的 email，這裡查 tech_users 名冊換成 TechUser
  // 後走與 Telegram 認領完全相同的 submit 路徑（sidecar 由 spawnCreateMrNow 寫）。
  // 查不到就直接拒絕 spawn（exit 1）而不是靜默丟掉發起人——寧可讓呼叫端拿掉
  // 這個旗標重來，也不要打錯字後產出一筆看起來正常、實際發起人為空的 run。
  let triggeredBy: TechUser | undefined
  const emailFlagIdx = process.argv.indexOf('--triggered-by-email')
  if (emailFlagIdx !== -1) {
    const email = process.argv[emailFlagIdx + 1] ?? ''
    const user = /^[^\s@]+@[^\s@]+$/.test(email) ? await resolveTechUserByEmail(email) : null
    if (!user) {
      console.log(JSON.stringify({ ok: false, reason: `--triggered-by-email 在 tech_users 名冊查無此 email：${email || '(空)'}` }))
      process.exit(1)
    }
    triggeredBy = user
  }
  const result = submitCreateMr(ticket, { resume, mode, triggeredBy })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}
