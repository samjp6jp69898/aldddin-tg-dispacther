import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const ACTIVE_MARKER_DIR = '/Users/user/aladdin/telegram-dispatcher/logs/active-pipelines'

/**
 * T26 review 發現的阻斷性問題修正（2026-08-23）：stale-lock-reaper.ts 掃的是
 * /tmp/bug-analysis-locks，這是 scripts/bug-lock.sh 管理的**全域共用**鎖
 * 目錄——人工在終端機互動跑 `/create-mr`、`/create-mrs` 批次、back-testing
 * pipeline 都會呼叫同一支 `bug-lock.sh claim`，鎖檔（`info`）完全沒有欄位
 * 記錄「這個鎖是不是 dispatcher 觸發的」。若 stale-lock-reaper 對這些鎖也
 * 套用 130 分鐘門檻，會誤殺正在被人工/其他 pipeline 合法使用的鎖——review
 * 迴圈被打回重做、人工暫停查證等情境跑超過 130 分鐘是真實可能發生的
 * （pipeline 本身文件寫「單張 20–40 分鐘」，130 分鐘不是安全餘裕），只有
 * dispatcher 自己 spawn 的流程才有 `timeout 7200` 這個結構性上限（見
 * spawn-create-mr.ts 的 WRAPPER_SCRIPT）。
 *
 * 解法：dispatcher 自己 spawn 背景流程時（spawnCreateMr／
 * spawnDemandPipeline）額外寫一份「這張單是我 spawn 的、幾點 spawn 的」標記
 * 檔，跟 bug-lock.sh 完全分開、不共用同一份狀態，不需要修改 bug-lock.sh 或
 * create-mr.md（那是維護協定紅區的共用檔案）。stale-lock-reaper 只對「有這
 * 份標記」的 ticket 套用 130 分鐘門檻，且用標記自己記的 spawn 時間（比
 * bug-lock.sh 的 `time=` 更早、更保守——create-mr 內部 Step 0.1.3 的
 * re-claim 一定發生在 dispatcher spawn 之後）當基準；沒有標記的鎖完全不碰，
 * 留給人工用既有的 `bug-lock.sh release` 手動處理（見 README.md「工單鎖卡
 * 住時如何手動排除」）。
 *
 * 標記檔生命週期：spawn 時建立，process 正常結束（onExit）時清除——比照
 * concurrency-limiter 的 release 時機。若 process 被 kill -9 或機器斷電導致
 * onExit 沒機會執行，標記檔會殘留，這是刻意的：殘留的標記正是 stale-lock-
 * reaper 需要偵測的訊號（不是缺陷，是 T26 要處理的情境本身）。
 */
export function markPipelineActive(ticket: string, dir: string = ACTIVE_MARKER_DIR): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ticket), new Date().toISOString())
  } catch {
    // best-effort：標記失敗不阻斷 spawn，只是這張單之後不會被 stale-lock-
    // reaper 辨識成「dispatcher 觸發」，等同不受自動回收保護——寧可少保護
    // 也不要因為標記失敗擋住原本要做的 spawn。
  }
}

export function clearPipelineActive(ticket: string, dir: string = ACTIVE_MARKER_DIR): void {
  try {
    rmSync(join(dir, ticket), { force: true })
  } catch {
    // best-effort，理由同上。
  }
}

/**
 * 回傳這張 ticket 被 dispatcher 標記為「正在跑」的時間戳（epoch ms）。沒有
 * 標記（不是 dispatcher 觸發，或標記已被清除/從沒建立過）回傳 null——呼叫端
 * （stale-lock-reaper.ts）用這個當「要不要碰這個鎖」的前提判斷，null 代表
 * 完全不碰。標記檔內容壞掉（人為誤刪重建、內容非法時間字串等極端情況）也
 * 回傳 null，不是拋例外——寧可少保護，不要因為標記檔本身壞掉反而誤判成
 * 「現在才 spawn」（Date.parse 失敗不會意外變成 NaN 卻被當成 0 或當下）。
 */
export function getPipelineActiveSince(ticket: string, dir: string = ACTIVE_MARKER_DIR): number | null {
  const path = join(dir, ticket)
  if (!existsSync(path)) return null
  try {
    const parsed = Date.parse(readFileSync(path, 'utf8').trim())
    return Number.isNaN(parsed) ? null : parsed
  } catch {
    return null
  }
}
