import { readdirSync, readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { cleanupWorktreesForTicket } from './cleanup-worktree.ts'
import { submitCreateMr, dispatchMonitorWrite } from './spawn-create-mr.ts'
import { notifyOperator } from '../notify/operator.ts'
import { getPipelineActiveSince, clearPipelineActive, readRunIdFromActiveMarker, ACTIVE_MARKER_DIR } from './active-pipeline-marker.ts'
import { writeRunOutcomeProvisional } from '../monitor-db/writes.ts'
import type { RunKind } from '../monitor-db/types.ts'

const LOCK_DIR = '/tmp/bug-analysis-locks'
const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const LOG_FILE = join(LOG_DIR, 'stale-lock-reaper.log')
const RETRY_STATE_FILE = join(LOG_DIR, 'stale-lock-retries.json')

// 已知風險（2026-08-23 對抗性 review 發現，記錄不阻斷，跟外部 watchdog
// 是否上線有關聯，見 README.md「已知操作風險」對應條目）：
// (1) reapStaleLocks() 全程同步（execFileSync），跟 webhook server 共用
//     同一條主 event loop、同一個 setInterval 排程。真的抓到逾時鎖時
//     （release/cleanup/notify 加總，cleanupWorktreesForTicket 最壞情況
//     單一 repo 就要跑到 4 次各 30 秒上限的 exec）理論上限可以讓 event
//     loop 卡住到數分鐘，同一段時間內 webhook 完全無回應。日常沒有逾時鎖
//     時無感，只在真的觸發回收（T26 要處理的情境本身）才會發生。若之後
//     T19 的外部 watchdog（health-watchdog.sh）也上線，這個窗口內 /health
//     答不出來可能被 watchdog 誤判成「掛了」進而觸發不必要的
//     `launchctl kickstart -k`，中斷正在進行的回收流程本身。
// (2) RETRY_STATE_FILE 是直接 writeFileSync 覆蓋（非 tmp+rename 的原子寫），
//     若剛好在寫入當下 process 被強制終止（例如 (1) 導致的誤重啟），有機
//     率留下半寫壞檔；readRetryState 對 parse 失敗會回傳 {}，讓
//     MAX_AUTO_RETRIES 的計數静默歸零。
// 兩者都是「watchdog 正式上線後才會被放大」的風險，此刻 watchdog 尚未
// bootstrap（見 README），暫不阻斷；之後要啟用 watchdog 前建議一併處理
// （例如把 reapStaleLocks 的回收動作改非同步，或原子寫 RETRY_STATE_FILE）。
const EXEC_TIMEOUT_MS = 30_000

// T26 已知操作風險（見 tasks.json T26 changelog）：手動用 `kill -9
// -<bash wrapper 的 PGID>` 整組砍掉背景流程時，GNU coreutils 的 `timeout`
// 會替自己與底下的 claude 建立獨立的 process group（不繼承 bash wrapper 的
// PGID），只殺得到 bash wrapper——EXIT trap（release 鎖／cleanup
// worktree／補發通知，見 spawn-create-mr.ts／spawn-demand-pipeline.ts 的
// WRAPPER_SCRIPT）因為 SIGKILL 不可攔截而完全不會執行，`timeout`/`claude`
// 兩個 process 變成孤兒，鎖永遠卡在 LOCKED，只能手動 `bug-lock.sh release`
// 補救。另一種真實會發生、比手動 kill 更難預期的情況：整台機器在 pipeline
// 跑到一半時斷電/重開機——trap 同樣完全沒機會執行，且 `/tmp` 不保證每次
// 重開機都被清空。
//
// 這支模組週期性掃描 /tmp/bug-analysis-locks，但**只處理 dispatcher 自己
// spawn 的 pipeline**（見 active-pipeline-marker.ts 檔頭註解——2026-08-23
// review 發現的阻斷性問題修正：bug-lock.sh 是全 aladdin 共用的鎖，人工互動
// 跑 /create-mr、/create-mrs 批次、back-testing pipeline 都會 claim 同一個
// 鎖目錄，鎖檔本身無法分辨來源，若不分來源一律套用時間門檻，會誤殺人工/
// 其他 pipeline 正在合法使用的鎖）。用哪個時間戳判斷「持有多久」也因此改成
// active-pipeline-marker 記的「dispatcher 自己 spawn 的時間」，不是
// bug-lock.sh info 檔裡的 `time=`（那是 create-mr 內部 Step 0.1.3 re-claim
// 的時間，一定晚於 dispatcher 的 spawn 時間，用 spawn 時間當基準更保守）。
// 不嘗試用 pid 判斷 process 是否還活著：無論是鎖檔案的 pid 還是我們自己
// spawn 的 pid，都只是短命子行程/detached 行程的 pid，直接檢查存活與否沒有
// 意義。時間門檻本身就是結構性保證：即使 EXIT trap 完全沒機會執行（手動
// kill -9 整組砍掉、機器斷電重開機這兩種已知情境），`timeout 10800` 這個
// 指令本身仍會對它自己的直接子行程（claude）在 10800 秒時送
// SIGTERM/SIGKILL，不受父行程（bash wrapper）是否存活影響——所以只要是
// dispatcher 自己 spawn 的 pipeline，真正的行程最晚在 spawn 之後 10800 秒
// 左右就會結束。195 分鐘（11700 秒）在此之上留了 15 分鐘 margin
// 【plan-db-as-truth-v3.2.md §9.0(G) 裁定：180×(130/120)≈195,同時 ≥「絕對
// margin 讀法」190 分,取 195 分——比例 margin 與絕對 margin 兩種讀法都滿足，
// 多出的 5 分鐘是對『180 分鐘的單本身變異更大』的合理保守】，足以
// 涵蓋兩種收尾方式（正常結束、被 timeout 強制結束），不會誤殺一個貨真價實
// 還在跑的 pipeline。
const STALE_THRESHOLD_MS = 195 * 60 * 1000

// 只有 Bug pipeline（FAQ-*）自動重試：這條 pipeline 穩定、有多輪真實 E2E
// 驗證（見 tasks.json T21/T22），重試風險可控。需求 pipeline（ALDREQ-*）刻意
// 不自動重試——沿用 T36 既有的保守立場（範圍完整性尚未充分驗證，T35 回溯
// 測試已證實跨 repo 需求有真實遺漏風險，demand-claim.ts 對併發滿載/spawn
// 失敗這兩種既有失敗情境本來就是「請人工重新認領」而非自動重試，這裡延續
// 同一套政策，不單獨對「鎖卡住」開特例）。每張 FAQ ticket 最多自動重試 1 次
// （狀態存在 RETRY_STATE_FILE，跨 server 重啟仍記得，避免重啟後又能重試一輪
// 造成無限重試）；超過上限只回收鎖與 worktree、通知 Landon，不再自動重試。
const MAX_AUTO_RETRIES = 1
const BUG_TICKET_RE = /^FAQ-\d+$/

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // 連寫 log 都失敗不該讓回收流程本身掛掉。
  }
}

function readRetryState(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(RETRY_STATE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeRetryState(state: Record<string, number>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(RETRY_STATE_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    log(`寫入 retry state 失敗（不影響本次回收判斷，但下次重啟後計數可能不準）: ${err}`)
  }
}

function releaseLock(ticket: string): void {
  try {
    execFileSync('bash', [BUG_LOCK_SH, 'release', ticket], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
  } catch (err) {
    log(`${ticket} 釋放鎖失敗: ${err}`)
  }
}

/**
 * 掃描 LOCK_DIR 底下每個 ticket，只對「有 active-pipeline 標記」（見
 * active-pipeline-marker.ts）的 ticket 判斷是否逾時——沒有標記代表這個鎖不
 * 是 dispatcher 自己 spawn 的（人工互動跑 /create-mr、/create-mrs 批次等），
 * 完全跳過、不碰。lockDir/markerDir/now 可覆寫（測試用，不依賴真的 /tmp 與
 * 真的時間流逝）。
 */
export function findStaleLocks(opts: { lockDir?: string; markerDir?: string; now?: number } = {}): Array<{ ticket: string; ageMs: number }> {
  const lockDir = opts.lockDir ?? LOCK_DIR
  const now = opts.now ?? Date.now()
  if (!existsSync(lockDir)) return []

  const stale: Array<{ ticket: string; ageMs: number }> = []
  for (const ticket of readdirSync(lockDir)) {
    // 基本健檢：確認這是真的 bug-lock.sh 建的鎖目錄（有 info 檔），不是雜訊。
    if (!existsSync(join(lockDir, ticket, 'info'))) continue

    const activeSince = getPipelineActiveSince(ticket, opts.markerDir)
    if (activeSince === null) continue // 不是 dispatcher 觸發的鎖，完全不碰

    const ageMs = now - activeSince
    if (ageMs >= STALE_THRESHOLD_MS) stale.push({ ticket, ageMs })
  }
  return stale
}

function formatMinutes(ms: number): number {
  return Math.round(ms / 60_000)
}

/**
 * T26：對每個逾時鎖做「釋放鎖 → 清 worktree → 清 active-pipeline 標記 →
 * （視情況）自動重試一次 → 通知 Landon」。deps 可覆寫（測試用）：
 * release/cleanup/clearMarker/retry/notify 全部可注入假實作，不必真的碰
 * /tmp、真的 git worktree、真的 spawn claude -p、真的打 Telegram。
 */
export function reapStaleLocks(
  opts: { lockDir?: string; markerDir?: string; now?: number } = {},
  deps: {
    release?: (ticket: string) => void
    cleanup?: (ticket: string) => void
    clearMarker?: (ticket: string) => void
    /**
     * 【plan-db-as-truth-v3.2.md §5.7 / G9】retry 血緣改為顯式參數（不靠
     * `process.env.MON_RUN_ID` 繼承——reaper 跑在常駐行程，那個 env 恆空）：
     * `retryOfRunId` 是被回收的那個 run 的 run_id（由 active-pipeline marker
     * 讀出，讀不到就是 null，見下方呼叫點）。回傳值也不再吞掉新 run 的
     * run_id（MJ-E6 指出的原型別缺口），供呼叫端記錄/測試斷言。
     */
    retry?: (ticket: string, retryOfRunId: string | null) => { ok: boolean; reason?: string; runId?: string }
    notify?: (text: string) => boolean
    readRetryState?: () => Record<string, number>
    writeRetryState?: (state: Record<string, number>) => void
  } = {},
): Array<{ ticket: string; ageMs: number; retried: boolean }> {
  const stale = findStaleLocks(opts)
  if (stale.length === 0) return []

  const release = deps.release ?? releaseLock
  const cleanup = deps.cleanup ?? ((ticket: string) => cleanupWorktreesForTicket(ticket))
  const clearMarker = deps.clearMarker ?? ((ticket: string) => clearPipelineActive(ticket, opts.markerDir ?? ACTIVE_MARKER_DIR))
  // 2026-08-28 起 submitCreateMr 額滿改排隊：result.ok=true 也可能是 queued
  // （排入佇列、輪到自動跑）——對這裡的語意仍算「重試已成功交付」，照舊計入
  // 重試額度。
  const retry = deps.retry ?? ((ticket: string, retryOfRunId: string | null) => submitCreateMr(ticket, { retryOf: retryOfRunId ?? undefined }))
  const notify = deps.notify ?? notifyOperator
  const getRetryState = deps.readRetryState ?? readRetryState
  const setRetryState = deps.writeRetryState ?? writeRetryState

  const retryState = getRetryState()
  const results: Array<{ ticket: string; ageMs: number; retried: boolean }> = []

  for (const { ticket, ageMs } of stale) {
    const minutes = formatMinutes(ageMs)
    log(`發現逾時鎖：${ticket}（已持有 ${minutes} 分鐘，門檻 ${formatMinutes(STALE_THRESHOLD_MS)} 分鐘），開始回收`)

    const isBugTicket = BUG_TICKET_RE.test(ticket)
    const kind: RunKind = isBugTicket ? 'bug' : 'demand'
    // 【plan-db-as-truth-v3.2.md §5.7】reaper 回收終態：在 clearMarker 把標記
    // 檔清掉之前，先讀出它記的 run_id（本機檔案，不碰監控 DB）——這是
    // 「reaper 不直接下 SQL、但要能顯式攜帶血緣」的前提，也是自動重試
    // retryOfRunId 的唯一來源（reaper 跑在常駐行程，process.env.MON_RUN_ID
    // 恆空，見上方 retry deps 註解）。讀不到（marker 寫入失敗、或這張單從
    // 監控 DB 上線前就卡住）就是 null——不寫終態、不帶血緣，降級但不阻斷
    // 既有的回收流程。
    const reapedRunId = readRunIdFromActiveMarker(kind, ticket, opts.markerDir ?? ACTIVE_MARKER_DIR)

    release(ticket)
    try {
      cleanup(ticket)
    } catch (err) {
      log(`${ticket} 清理 worktree 時發生例外（不阻斷後續通知）: ${err}`)
    }

    if (reapedRunId) {
      const finishedAt = new Date().toISOString()
      dispatchMonitorWrite(
        'writeRunOutcomeProvisional',
        { runId: reapedRunId, ticket, kind, outcome: 'unknown_reaped', outcomeSource: 'stale-lock-reaper', finishedAt },
        pool => writeRunOutcomeProvisional(pool, { runId: reapedRunId, ticket, kind, outcome: 'unknown_reaped', outcomeSource: 'stale-lock-reaper', finishedAt }),
      )
    }

    // 標記先清掉（代表 dispatcher 不再認為自己對這張單的舊 pipeline 負責）；
    // 如果下面真的自動重試，retry() 內部的 submitCreateMr 會在 spawn 時用
    // 新的 spawn 時間重新標記，兩者不衝突。
    try {
      clearMarker(ticket)
    } catch (err) {
      log(`${ticket} 清除 active-pipeline 標記時發生例外（不阻斷後續通知）: ${err}`)
    }

    const priorRetries = retryState[ticket] ?? 0
    let retried = false

    if (isBugTicket && priorRetries < MAX_AUTO_RETRIES) {
      // review 發現並修正：只有 retry 真的成功（result.ok）才把額度算掉——
      // 之前的版本在呼叫 retry() 之前就先 +1 寫回 retryState，若這次 retry
      // 剛好因為併發上限/spawn 失敗而沒有任何 pipeline 真的跑起來，這張單
      // 會被永久誤記成「已經用掉一次自動重試機會」，下次卡住時直接被判定
      // 「已達上限」，但實際上它從沒真正拿到過一次自動重試。
      const result = retry(ticket, reapedRunId)
      if (result.ok) {
        retried = true
        retryState[ticket] = priorRetries + 1
        setRetryState(retryState)
        log(`${ticket} 已自動重試第 ${priorRetries + 1}/${MAX_AUTO_RETRIES} 次`)
        notify(
          `🔁 [自動回收] ${ticket} 的鎖逾時（已持有 ${minutes} 分鐘）已自動釋放並清理 worktree，已自動重新觸發一次 /create-mr（第 ${priorRetries + 1}/${MAX_AUTO_RETRIES} 次）。`,
        )
      } else {
        log(`${ticket} 自動重試 spawn 失敗（${result.reason ?? 'unknown'}），不計入重試額度`)
        notify(
          `⚠️ [自動回收] ${ticket} 的鎖逾時（已持有 ${minutes} 分鐘）已自動釋放並清理 worktree，但自動重試 spawn 失敗（${result.reason ?? 'unknown'}，不計入重試額度），請人工檢查後重新認領。`,
        )
      }
    } else {
      const reason = isBugTicket ? `已達自動重試上限（${MAX_AUTO_RETRIES} 次）` : '需求單不自動重試（沿用 T36 既有政策，鎖卡住需人工重新認領）'
      log(`${ticket} 不自動重試：${reason}`)
      notify(`⚠️ [自動回收] ${ticket} 的鎖逾時（已持有 ${minutes} 分鐘）已自動釋放並清理 worktree，${reason}，請人工檢查後視情況重新認領。`)
    }

    results.push({ ticket, ageMs, retried })
  }

  return results
}

/**
 * 週期排程（硬規則明文允許的合法用途：週期性排程器，不是拿 sleep/輪詢規避
 * 競態）。10 分鐘一次，遠低於 195 分鐘的門檻，逾時鎖最慢在門檻後 10 分鐘內
 * 會被抓到並回收。
 */
export function startStaleLockReaper(intervalMs = 10 * 60 * 1000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      reapStaleLocks()
    } catch (err) {
      log(`reapStaleLocks 例外: ${err}`)
    }
  }, intervalMs)
}
