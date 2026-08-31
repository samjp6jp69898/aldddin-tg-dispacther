// 2026-08-28（使用者定案）：背景 pipeline 併發額滿時不再直接拒絕、要求使用者
// 稍後重試，改成 FIFO 排隊——額滿的請求依先進先出排入佇列，任一執行中的
// pipeline 結束（onExit 事件）就自動遞補下一張。事件驅動，不是 sleep/輪詢
// （硬規則：禁止用等待解決正確性問題；遞補時機完全由 spawnDetachedProcess
// 的 'exit'/'error' 事件觸發）。
//
// 佇列跟 concurrency-limiter 一樣是 in-memory（活在 webhook server process
// 記憶體裡），但每次變動都會把快照原子性地寫進 stateFile（tmp+rename）：
// (1) 給 tg-monitor 顯示「排隊中的單」（唯讀，跨 process 只能靠檔案）；
// (2) webhook server 重啟時由 server.ts 呼叫 recoverFromDisk() 把還沒輪到的
//     單撿回來繼續排（counters 歸零的既有 trade-off 不變——重啟後舊背景流程
//     不在計數內，恢復當下可能短暫超出名額上限，跟 concurrency-limiter.ts
//     檔頭記載的重啟語意一致，屬已接受的取捨）。
// 對抗性 review（2026-08-28）發現的結構保證補強：persist 只在 recoverFromDisk
// 被呼叫過之後才真的寫檔——recoverFromDisk 只有 server.ts 啟動時會呼叫，
// 所以短命 CLI 行程（`bun spawn-create-mr.ts <ticket>` 等）即使未來有人讓它
// 走進 queued 分支，也不可能拿自己那份空佇列覆蓋掉 server 的共用快照檔。
//
// 佇列本身不持有 bug-lock：認領流程在 enqueue 前就已把 per-ticket 鎖釋放
// （見 claim.ts / demand-claim.ts 的 releaseLock 註解——鎖的擁有權交給之後
// spawn 出來的 pipeline 自己），排隊期間靠 submit() 的同票去重擋「同一張單
// 被排兩次」。去重擋不住「執行中的單被排進佇列」（執行中的單不在佇列裡）、
// 也擋不住排隊期間別的入口（人工終端機、/create-mrs 批次、tg-monitor CLI）
// 把同一張單跑起來——submit 當下的檢查（claim.ts 的 isTicketLocked）跟真正
// spawn 之間可能相隔數小時，所以出列/恢復時必須用 cfg.skipReason 重驗前提
// （對抗性 review 2026-08-28 發現：若不重驗，延遲 spawn 的重複 run 在
// Step 0.1 早退後，EXIT trap 會無條件 release 存活 run 的鎖並清掉它正在用的
// worktree）。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConcurrencyLimiter } from './concurrency-limiter.ts'

/** 排隊當下的觸發者（tg-monitor 顯示 + 輪到時 tg-notify 通知用）。CLI 觸發
 * （tg-monitor 重試按鈕）沒有這份資訊，為 null。 */
export type QueueTriggeredBy = { name: string; email: string } | null

export type QueueEntry<P> = {
  ticket: string
  enqueuedAt: string
  triggeredBy: QueueTriggeredBy
  payload: P
}

export type SubmitResult =
  | { ok: true; status: 'started'; pid: number | undefined }
  /** position = 1-based 排隊順位；ahead = 前面還有幾張單在排隊（= position - 1）。 */
  | { ok: true; status: 'queued'; position: number; ahead: number }
  | { ok: true; status: 'already_queued'; position: number; ahead: number }
  /** 這張單有一條本 process spawn 的背景流程還在跑（2026-08-28 實測踩到的
   * 洞：TG 連點兩次同一張單，第二次落在「run#1 已 spawn、但 claude 冷啟動
   * 1–3 分鐘內尚未跑到 Step 0.1.3 拿鎖」的視窗——isTicketLocked 看不到、
   * 佇列去重也掃不到（執行中的單不在佇列裡），結果 spawn 出的 run#2 在
   * Step 0.1 早退後，EXIT trap 無條件 release 掉 run#1 剛拿到的鎖並清標記。
   * 佇列自己維護的 running 集合不依賴鎖檔，spawn 成功當下就記錄，結構性
   * 封住這個視窗）。 */
  | { ok: true; status: 'already_running' }
  | { ok: false; reason: 'spawn_error' }

/** skipReason 的結構化回傳：code 讓 onSkipped 能分辨「該做什麼收尾」（例：
 * locked＝別的流程正在跑、不要動它的狀態；expired＝逾時、要把工單狀態改回
 * 可認領），text 是給發起人看的人話。 */
export type SkipReason = { code: string; text: string }

export type PipelineQueue<P> = {
  submit: (ticket: string, triggeredBy: QueueTriggeredBy, payload: P) => SubmitResult
  /** 從 stateFile 撿回上次 process 結束前還在排隊的單，並啟用 persist（只在
   * server 啟動時呼叫一次；CLI 短命行程絕不能呼叫——會把別的 process 的
   * 排隊單搶來 spawn）。回傳 { started, requeued, skipped } 供啟動 log。 */
  recoverFromDisk: () => { started: number; requeued: number; skipped: number }
  size: () => number
}

export function createPipelineQueue<P>(cfg: {
  limiter: ConcurrencyLimiter
  stateFile: string
  /** ticket 合法格式。submit 端呼叫者（submitCreateMr 等）已各自驗過；這裡
   * 主要守 recoverFromDisk 讀回的檔案內容——stateFile 在 logs/ 下、非特權
   * 路徑，被竄改或半寫壞時不能讓任意字串流進 bash wrapper 位置參數與
   * claude prompt（對抗性 review 2026-08-28 發現的缺口）。 */
  ticketRe: RegExp
  /** 真正起背景流程（不含額度檢查——額度由本佇列管理）。onExit 必須在背景
   * 流程真的結束時被呼叫恰好一次（spawnDetachedProcess 已保證），佇列靠它
   * 釋放名額並遞補下一張。回 ok:false 代表 spawn 當下就失敗（例外已由
   * spawnNow 自己記 log），佇列會歸還名額。 */
  spawnNow: (entry: QueueEntry<P>, onExit: () => void) => { ok: true; pid: number | undefined } | { ok: false }
  /** 出列/恢復（＝檢查與 spawn 之間隔了不定時間的路徑）spawn 前的前提重驗：
   * 回傳非 null＝這張單不該再跑（例：鎖已被別的流程持有、排隊逾時），
   * 佇列會把它移除、呼叫 onSkipped、不佔名額、繼續遞補下一張。submit 當下
   * 不套用（呼叫端在 submit 前一刻已自行檢查過同樣的前提）。 */
  skipReason?: (entry: QueueEntry<P>) => SkipReason | null
  /** 排隊中的單被 skipReason 移除時呼叫（TG 通知發起人＋依 reason.code 做
   * 對應收尾，例如把 Notion 狀態改回可認領）。 */
  onSkipped?: (entry: QueueEntry<P>, reason: SkipReason) => void
  /** 排隊中的單輪到並成功啟動時呼叫（用來 TG 通知發起人）。 */
  onDequeueStarted?: (entry: QueueEntry<P>) => void
  /** 排隊中的單輪到但 spawn 失敗時呼叫（通知發起人需重新認領）；佇列會跳過
   * 這張、繼續遞補下一張，不會讓一張壞單卡死整條佇列。 */
  onDequeueFailed?: (entry: QueueEntry<P>) => void
}): PipelineQueue<P> {
  const queue: QueueEntry<P>[] = []
  // 本 process 經由這個佇列 spawn、還沒收到 onExit 的 ticket 集合——見
  // SubmitResult 的 already_running 註解。in-memory（跟 limiter 同壽命）：
  // server 重啟後集合歸零，重啟前的舊流程改由鎖檔（skipReason 的
  // isTicketLocked）接手防護，兩層互補。
  const running = new Set<string>()
  // persist 啟用旗標：見檔頭「結構保證補強」段。server.ts 啟動時的
  // recoverFromDisk() 會把它打開；短命 CLI 行程從不呼叫 recover，永遠不寫檔。
  let persistEnabled = false

  function persist(): void {
    if (!persistEnabled) return
    // tmp+rename 原子性替換：tg-monitor 隨時可能在讀，不能讓它讀到寫一半的
    // JSON。rename 同目錄下是單一 syscall，讀端要嘛看到舊檔要嘛看到新檔。
    try {
      mkdirSync(dirname(cfg.stateFile), { recursive: true })
      const tmp = `${cfg.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), entries: queue }, null, 2))
      renameSync(tmp, cfg.stateFile)
    } catch (err) {
      // 持久化失敗只影響監控顯示與重啟恢復，不影響 in-memory 佇列本身的
      // 正確性——記 stderr 但不拋出，不讓監控面的問題擋住主流程。
      console.error(`pipeline-queue: 寫入 ${cfg.stateFile} 失敗: ${err}`)
    }
  }

  function handleExitFor(ticket: string): () => void {
    return () => {
      running.delete(ticket)
      cfg.limiter.release()
      drain()
    }
  }

  /** 通知類 hook 一律包 try/catch：hook（TG 通知、Notion 回寫等 best-effort
   * 收尾）丟例外不准破壞佇列/名額不變式——drain 是在 child 'exit' 事件
   * handler 裡同步跑的，例外一路往上沒人接，會直接炸掉常駐 server。 */
  function safeHook(label: string, fn: (() => void) | undefined): void {
    try {
      fn?.()
    } catch (err) {
      console.error(`pipeline-queue: ${label} hook 失敗（不影響佇列運作）: ${err}`)
    }
  }

  /** skipReason 自身丟例外時視為「不跳過」（維持與沒有 skipReason 時相同的
   * 行為），只記 log——重驗是防護網，防護網壞掉不該讓佇列停擺。 */
  function evalSkipReason(entry: QueueEntry<P>): SkipReason | null {
    try {
      return cfg.skipReason?.(entry) ?? null
    } catch (err) {
      console.error(`pipeline-queue: skipReason 執行失敗（視為不跳過）: ${err}`)
      return null
    }
  }

  /** 出列一張並嘗試啟動。共用於 drain（遞補）與 recoverFromDisk（恢復）。
   * 回傳這張單的下場，讓兩個呼叫端各自統計。 */
  function startEntry(entry: QueueEntry<P>): 'started' | 'failed' {
    const r = cfg.spawnNow(entry, handleExitFor(entry.ticket))
    if (r.ok) {
      running.add(entry.ticket)
      safeHook('onDequeueStarted', () => cfg.onDequeueStarted?.(entry))
      return 'started'
    }
    // spawn 失敗：名額由呼叫端歸還後繼續試下一張，這張單通知發起人自行重新
    // 認領——不重新排回佇列，避免一張永遠 spawn 不起來的單無限循環佔住隊頭。
    safeHook('onDequeueFailed', () => cfg.onDequeueFailed?.(entry))
    return 'failed'
  }

  /** 出列/恢復共用的前提重驗：先看本 process 自己的 running 集合（不依賴
   * 鎖檔、無視窗），再跑呼叫端注入的 skipReason（鎖檔＋時效，涵蓋跨 process
   * 的情況）。 */
  function evalDequeueSkip(entry: QueueEntry<P>): SkipReason | null {
    if (running.has(entry.ticket)) return { code: 'locked', text: '偵測到本 dispatcher 已有另一個背景流程正在執行這張單，不重複觸發' }
    return evalSkipReason(entry)
  }

  function drain(): void {
    while (queue.length > 0) {
      // 前提重驗（不佔名額）：先看隊頭該不該跑，再決定要不要 tryAcquire。
      const head = queue[0]!
      const reason = evalDequeueSkip(head)
      if (reason !== null) {
        queue.shift()
        persist()
        safeHook('onSkipped', () => cfg.onSkipped?.(head, reason))
        continue
      }
      if (!cfg.limiter.tryAcquire()) return
      queue.shift()
      persist()
      if (startEntry(head) === 'failed') cfg.limiter.release()
    }
  }

  function submit(ticket: string, triggeredBy: QueueTriggeredBy, payload: P): SubmitResult {
    // 執行中集合優先於一切：這張單已有本 process spawn 的流程在跑（含「剛
    // spawn、尚未拿到鎖」的冷啟動視窗），直接擋下，不 spawn、不入列——見
    // SubmitResult 的 already_running 註解（2026-08-28 使用者實測踩到）。
    if (running.has(ticket)) {
      return { ok: true, status: 'already_running' }
    }
    const existingIdx = queue.findIndex(e => e.ticket === ticket)
    if (existingIdx >= 0) {
      return { ok: true, status: 'already_queued', position: existingIdx + 1, ahead: existingIdx }
    }
    const entry: QueueEntry<P> = { ticket, enqueuedAt: new Date().toISOString(), triggeredBy, payload }
    if (cfg.limiter.tryAcquire()) {
      const r = cfg.spawnNow(entry, handleExitFor(ticket))
      if (!r.ok) {
        cfg.limiter.release()
        return { ok: false, reason: 'spawn_error' }
      }
      running.add(ticket)
      return { ok: true, status: 'started', pid: r.pid }
    }
    queue.push(entry)
    persist()
    return { ok: true, status: 'queued', position: queue.length, ahead: queue.length - 1 }
  }

  function recoverFromDisk(): { started: number; requeued: number; skipped: number } {
    persistEnabled = true
    let entries: QueueEntry<P>[] = []
    try {
      const parsed = JSON.parse(readFileSync(cfg.stateFile, 'utf8')) as { entries?: QueueEntry<P>[] }
      if (Array.isArray(parsed.entries)) {
        // ticket 格式不合法的條目（檔案被竄改/半寫壞）直接丟棄，不進任何
        // 後續路徑——見 cfg.ticketRe 註解。
        entries = parsed.entries.filter(e => typeof e?.ticket === 'string' && cfg.ticketRe.test(e.ticket))
      }
    } catch {
      // 檔案不存在或壞掉都當空佇列；下面 persist 會把檔案重寫成目前實況。
    }
    let started = 0
    let skipped = 0
    for (const entry of entries) {
      if (queue.some(e => e.ticket === entry.ticket)) continue
      const reason = evalDequeueSkip(entry)
      if (reason !== null) {
        skipped++
        safeHook('onSkipped', () => cfg.onSkipped?.(entry, reason))
        continue
      }
      if (cfg.limiter.tryAcquire()) {
        if (startEntry(entry) === 'failed') cfg.limiter.release()
        else started++
      } else {
        queue.push(entry) // 保留原始 enqueuedAt，維持先進先出
      }
    }
    persist()
    return { started, requeued: queue.length, skipped }
  }

  return { submit, recoverFromDisk, size: () => queue.length }
}
