import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunKind } from '../monitor-db/types.ts'

export const ACTIVE_MARKER_DIR = '/Users/user/aladdin/telegram-dispatcher/logs/active-pipelines'

/**
 * T26 review 發現的阻斷性問題修正（2026-08-23）：stale-lock-reaper.ts 掃的是
 * /tmp/bug-analysis-locks，這是 scripts/bug-lock.sh 管理的**全域共用**鎖
 * 目錄——人工在終端機互動跑 `/create-mr`、`/create-mrs` 批次、back-testing
 * pipeline 都會呼叫同一支 `bug-lock.sh claim`，鎖檔（`info`）完全沒有欄位
 * 記錄「這個鎖是不是 dispatcher 觸發的」。若 stale-lock-reaper 對這些鎖也
 * 套用門檻，會誤殺正在被人工/其他 pipeline 合法使用的鎖——review
 * 迴圈被打回重做、人工暫停查證等情境跑超過門檻是真實可能發生的
 * （pipeline 本身文件寫「單張 20–40 分鐘」，門檻不是安全餘裕），只有
 * dispatcher 自己 spawn 的流程才有 `timeout` 這個結構性上限（見
 * spawn-create-mr.ts 的 WRAPPER_SCRIPT）。
 *
 * 解法：dispatcher 自己 spawn 背景流程時（spawnCreateMr／
 * spawnDemandPipeline）額外寫一份「這張單是我 spawn 的、幾點 spawn 的」標記
 * 檔，跟 bug-lock.sh 完全分開、不共用同一份狀態，不需要修改 bug-lock.sh 或
 * create-mr.md（那是維護協定紅區的共用檔案）。stale-lock-reaper 只對「有這
 * 份標記」的 ticket 套用門檻，且用標記自己記的 spawn 時間（比
 * bug-lock.sh 的 `time=` 更早、更保守——create-mr 內部 Step 0.1.3 的
 * re-claim 一定發生在 dispatcher spawn 之後）當基準；沒有標記的鎖完全不碰，
 * 留給人工用既有的 `bug-lock.sh release` 手動處理（見 README.md「工單鎖卡
 * 住時如何手動排除」）。
 *
 * 標記檔生命週期：spawn 時建立，process 正常結束（onExit）時清除——比照
 * concurrency-limiter 的 release 時機。若 process 被 kill -9 或機器斷電導致
 * onExit 沒機會執行，標記檔會殘留，這是刻意的：殘留的標記正是 stale-lock-
 * reaper 需要偵測的訊號（不是缺陷，是 T26 要處理的情境本身）。
 *
 * 【v3.2 §6.4(4) R2 修訂】內容格式擴為 JSON `{startedAt, runId, kind}`：
 * `runId` 是這次 spawn 時鑄好的監控 DB run_id（§5.2），供 cancel 五段解析的
 * R2（本機、零 DB 成本）與 stale-lock-reaper 的自動重試血緣（§5.7）共用讀取
 * ——兩者都不需要碰監控 DB 就能拿到「這個標記對應哪一個 run」。呼叫端沒帶
 * `runId`/`kind`（例如監控 DB 尚未接線、或呼叫端尚未升級）時退回舊格式純
 * ISO 字串，`getPipelineActiveSince` 兩種格式都相容（先試 JSON 取
 * `startedAt`，失敗才退回 `Date.parse(整檔內容)`），壞檔仍回 `null` 不拋，
 * 既有語意一個字不變。
 */
export function markPipelineActive(ticket: string, opts: { runId?: string; kind?: RunKind; dir?: string } = {}): void {
  const dir = opts.dir ?? ACTIVE_MARKER_DIR
  try {
    mkdirSync(dir, { recursive: true })
    const startedAt = new Date().toISOString()
    const content = opts.runId && opts.kind ? JSON.stringify({ startedAt, runId: opts.runId, kind: opts.kind }) : startedAt
    writeFileSync(join(dir, ticket), content)
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

function readMarkerRaw(ticket: string, dir: string): string | null {
  const path = join(dir, ticket)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * 回傳這張 ticket 被 dispatcher 標記為「正在跑」的時間戳（epoch ms）。沒有
 * 標記（不是 dispatcher 觸發，或標記已被清除/從沒建立過）回傳 null——呼叫端
 * （stale-lock-reaper.ts）用這個當「要不要碰這個鎖」的前提判斷，null 代表
 * 完全不碰。標記檔內容壞掉（人為誤刪重建、內容非法時間字串等極端情況）也
 * 回傳 null，不是拋例外——寧可少保護，不要因為標記檔本身壞掉反而誤判成
 * 「現在才 spawn」（Date.parse 失敗不會意外變成 NaN 卻被當成 0 或當下）。
 *
 * 相容兩種格式：先試 JSON.parse 取 `startedAt`（v3.2 新格式），不是合法 JSON
 * 或沒有 `startedAt` 才退回 `Date.parse(整檔內容)`（舊格式純 ISO 字串）。
 */
export function getPipelineActiveSince(ticket: string, dir: string = ACTIVE_MARKER_DIR): number | null {
  const raw = readMarkerRaw(ticket, dir)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { startedAt?: unknown }
    if (typeof parsed?.startedAt === 'string') {
      const t = Date.parse(parsed.startedAt)
      return Number.isNaN(t) ? null : t
    }
  } catch {
    // 不是合法 JSON，走舊格式解析。
  }
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 【v3.2 §6.4(4) R2】從 active-pipeline marker 讀出本機記得的 run_id，純本機
 * 檔案讀取、不需要監控 DB。`kind` 必須與呼叫端宣稱的一致、`runId` 必須是
 * 合法 UUID 才回值，否則一律回 null（呼叫端據此降級到下一段解析——見
 * plan-db-as-truth-v3.2.md §6.4(4) 與 impl-errata-g2.md MJ-H1：呼叫端在採用
 * 這個值之前，還必須另外確認它對應的那一列 ticket/kind 與請求一致，那道
 * 「無 DB 自我驗證」是呼叫端的職責，本函式只負責忠實回報標記檔內容，不做
 * 那一層跨 DB 的驗證）。只認 v3.2 新格式（JSON）；舊格式（純 ISO 字串）沒有
 * runId，天然回 null，不需要特別分支。
 */
export function readRunIdFromActiveMarker(kind: RunKind, ticket: string, dir: string = ACTIVE_MARKER_DIR): string | null {
  const raw = readMarkerRaw(ticket, dir)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { runId?: unknown; kind?: unknown }
    if (parsed?.kind !== kind) return null
    if (typeof parsed?.runId !== 'string' || !UUID_RE.test(parsed.runId)) return null
    return parsed.runId
  } catch {
    return null
  }
}
