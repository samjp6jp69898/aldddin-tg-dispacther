import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { getTicketNotionUrl } from '../notion-integration/candidate-tickets.ts'

const TRACKER_SH = '/Users/user/aladdin/scripts/tracker.sh'
/** tracker.sh 的 TRACKER 預設值與同一個 `TRACKER_FILE` 覆寫入口（該腳本第
 * 20 行）。共用同一個環境變數名，本模組直接碰檔案、tracker.sh 走 shell 時
 * 才不會各指一份。tracker.sh 是唯一的讀寫入口（CLAUDE.md 硬規則），這裡只
 * 在「整檔同步」這一件事上直接碰檔案。 */
export function trackerPath(): string {
  return process.env.TRACKER_FILE || '/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md'
}
/** 與 tracker.sh 的 set/ensure-pending 共用同一把檔級自旋鎖目錄（該腳本硬編
 * 這個路徑）。整檔覆寫跟行級覆寫一樣會重寫整個檔案，必須互斥。
 * `TRACKER_SET_LOCK` 只給測試改指向暫存目錄用——production 兩邊都用預設值，
 * 測到的 busy 分支不需要 tracker.sh 參與。 */
function setLockPath(): string {
  return process.env.TRACKER_SET_LOCK || '/tmp/bug-analysis-locks/.tracker-set-lock'
}
/** tracker.sh set 的合法狀態集合（該腳本第 47 行 case 分支）。head 回寫
 * worker 終態前照這個白名單驗，不讓遠端字串直接流進 shell 參數。 */
const TRACKER_STATUSES = ['pending', 'rerun', 'in_progress', 'done', 'failed', 'needs_qa'] as const
export type TrackerStatus = (typeof TRACKER_STATUSES)[number]
/** 完成時間欄：tracker.sh set 的第三參數，格式見該腳本用法（`2026-07-03 1530`）。
 * 歷史資料另有 `20260519 1105` 這種舊格式，兩種都放行、其餘一律丟棄。 */
const DONE_AT_RE = /^\d{4}-?\d{2}-?\d{2}( \d{4})?$/
/** 整檔內容的形狀檢查：至少要有一行 tracker 資料列，才准覆蓋本機那份。
 * 防的是「head 端讀檔失敗回傳空字串/錯誤頁」被當成正常內容寫進來。 */
const TRACKER_ROW_RE = /^\| FAQ-\d+ \|/m

/**
 * /create-mr 觸發前的純技術同步（見 tasks.json T7）：確保 tracker.md 有這張
 * 單、且狀態是 pending，滿足 /create-mr 既有 Step 0 的 tracker 存在性檢查
 * （該檢查是共用 create-mr.md 的既有邏輯，不能改也不該改）。
 *
 * dispatcher 自己完全不讀 tracker 狀態、不用它做任何認領判斷——唯一判準永遠
 * 是 T6 的 Notion 查詢。這裡失敗（拿不到 Notion URL 或 tracker.sh 本身出錯）
 * 不拋出：這只是滿足既有 pipeline 內部依賴的技術前提，不該讓認領本身的成功
 * 回覆卡住；失敗時 /create-mr Step 0 頂多 SKIPPED，屬已知風險（見 risk_notes）。
 */
export function ensureTrackerPending(ticket: string): void {
  const url = getTicketNotionUrl(ticket)
  if (!url) return

  try {
    execFileSync('bash', [TRACKER_SH, 'ensure-pending', ticket, url], { encoding: 'utf8' })
  } catch {
    // 同上：純技術同步失敗不阻斷認領流程。
  }
}

// ── 整檔同步（多機：head 是唯一權威，worker 那份是每次接單前重新取得的副本）──
//
// 為什麼需要（2026-09-03 事故）：tracker 是 git 之外的資料檔，worker 機上
// 那份從 2026-08-31 的 repo 拆分之後就整個不存在，`ensure-pending` 因
// tracker.sh 第 25 行的存在性檢查直接 exit 1、被上面的 catch 靜默吞掉，
// 於是每一張派到 worker 的單都在 /create-mr Step 0.1 判成 not claimable、
// 幾十秒就 SKIPPED 退出——head 看到的只有「派出去、幾秒後 job-done」。
// 兩天內 7 張單全部白跑（FAQ-4821/3098/2122/4628/1828/4844）。
//
// 方向：head 那份是唯一權威。worker 接單當下向 head 抓一份完整覆蓋本機
// （pullTracker，見 worker-agent.ts），pipeline 跑完把該單的終態行隨
// job-done 回報給 head 寫回（applyRemoteTrackerRow，見 cluster-head.ts）。
// 這樣 worker 本機那份純粹是「這一輪執行用的副本」，不再是會分岔的第二份
// 事實——README 舊有的「每台各一份會分岔、靠 /sync-bug-tracker 事後補正」
// 只剩下「head 與 Notion 之間」這一層需要補正。

/** 讀整份 tracker（head 端回應 worker 拉取用）。檔案不存在/讀不到回 null。 */
export function readTrackerFile(): string | null {
  try {
    const content = readFileSync(trackerPath(), 'utf8')
    return TRACKER_ROW_RE.test(content) ? content : null
  } catch {
    return null
  }
}

/**
 * 用 head 送來的全文覆蓋本機 tracker（worker 端）。
 *
 * 互斥：先搶 tracker.sh 用的同一把 mkdir 檔級鎖，搶不到就**直接放棄**——
 * 有人正在寫的當下整檔覆蓋本來就是錯的，放棄後沿用本機既有那份（呼叫端只
 * 記 log、不阻斷接單）。這是結構性的讓路，不是「等一下再試」（CLAUDE.md
 * 硬規則禁止用等待解決正確性問題）。
 * 原子性：寫 tmp 再 rename，與 tracker.sh 的 `mv "$tmp" "$TRACKER"` 同款，
 * 任何時刻讀到的都是完整檔。
 */
export function writeTrackerFile(content: string): 'ok' | 'busy' | 'invalid' | 'failed' {
  if (!TRACKER_ROW_RE.test(content)) return 'invalid'
  const lock = setLockPath()
  const target = trackerPath()
  try {
    mkdirSync(lock.slice(0, lock.lastIndexOf('/')), { recursive: true })
  } catch {
    return 'failed'
  }
  try {
    mkdirSync(lock) // 已存在會拋 EEXIST＝有人正在寫
  } catch {
    return 'busy'
  }
  try {
    mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    const tmp = `${target}.sync.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, target)
    return 'ok'
  } catch {
    return 'failed'
  } finally {
    try {
      rmdirSync(lock)
    } catch {
      // 鎖已被移走：不是這裡該處理的狀況，留給 tracker.sh 既有的殘留說明。
    }
  }
}

/** 讀某張單在本機 tracker 的整行（worker 端 job-done 回報前取終態用）。
 * 查無此單或 tracker.sh 出錯回 null。 */
export function readTrackerRow(ticket: string): string | null {
  try {
    const out = execFileSync('bash', [TRACKER_SH, 'row', ticket], { encoding: 'utf8' }).trim()
    return out.startsWith('|') ? out : null
  } catch {
    return null
  }
}

/**
 * 從 tracker 行解析出「狀態 + 完成時間」。行格式（tracker.sh 檔頭）：
 *   `| FAQ-3757 | https://... | P2較高 | pending | 2026-07-03 |  |`
 * 以 `|` 切開後：[0]='' [1]=單號 [2]=連結 [3]=嚴重性 [4]=狀態 [5]=加入時間 [6]=完成時間
 * 狀態不在白名單內一律回 null（不猜、不放行未知字串）。
 */
export function parseTrackerRow(row: string): { status: TrackerStatus; doneAt: string } | null {
  const cols = row.split('|').map(s => s.trim())
  if (cols.length < 7) return null
  const status = cols[4]
  if (!TRACKER_STATUSES.includes(status as TrackerStatus)) return null
  const doneAt = cols[6]
  return { status: status as TrackerStatus, doneAt: DONE_AT_RE.test(doneAt) ? doneAt : '' }
}

/**
 * head 端：把 worker 回報的終態寫回自己那份 tracker。
 *
 * 只吃已通過 parseTrackerRow 白名單的值——status 與 doneAt 會成為
 * `tracker.sh set` 的參數，來源是遠端機器，一律先驗格式再放行。
 * 寫入本身走 tracker.sh（唯一入口，含它自己的檔級鎖），不繞過。
 * 回傳是否寫成功（NOT_FOUND 也算失敗：head 的 tracker 沒有這張單，代表
 * 兩邊已經不同步，交給呼叫端記 log）。
 */
export function applyRemoteTrackerRow(ticket: string, status: TrackerStatus, doneAt: string): boolean {
  if (!TRACKER_STATUSES.includes(status)) return false
  if (doneAt !== '' && !DONE_AT_RE.test(doneAt)) return false
  try {
    const args = [TRACKER_SH, 'set', ticket, status]
    if (doneAt !== '') args.push(doneAt)
    execFileSync('bash', args, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}
