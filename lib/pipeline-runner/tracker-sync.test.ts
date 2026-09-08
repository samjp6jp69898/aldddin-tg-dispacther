import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyRemoteTrackerRow,
  parseTrackerRow,
  readTrackerFile,
  readTrackerRow,
  trackerPath,
  writeTrackerFile,
} from './tracker-sync.ts'

// 全程用暫存目錄：TRACKER_FILE 同時被本模組與 tracker.sh 讀（兩邊共用同一個
// 環境變數名，見 tracker-sync.ts trackerPath()），所以連真跑 tracker.sh 的
// 測試也不會碰到 /Users/user/.claude/... 那份真的 tracker。
// TRACKER_SET_LOCK 也改指暫存，避免測 busy 分支時擋到正在跑的 pipeline。

const HEADER = `# Bug 分析追蹤表

| 單號 | Notion 連結 | 嚴重性 | 狀態 | 加入時間 | 完成時間 |
|---|---|---|---|---|---|
`

function fixture(rows: string[]): string {
  return HEADER + rows.join('\n') + '\n'
}

const ROW_PENDING = '| FAQ-4844 | https://notion.so/x | P2較高 | pending | 2026-09-03 |  |'
const ROW_DONE = '| FAQ-3098 | https://notion.so/y | P3一般 | done | 2026-05-19 | 2026-09-03 1130 |'

let dir: string
let prevTracker: string | undefined
let prevLock: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracker-sync-test-'))
  prevTracker = process.env.TRACKER_FILE
  prevLock = process.env.TRACKER_SET_LOCK
  process.env.TRACKER_FILE = join(dir, 'bug_analysis_tracker.md')
  process.env.TRACKER_SET_LOCK = join(dir, 'locks', '.tracker-set-lock')
})

afterEach(() => {
  if (prevTracker === undefined) delete process.env.TRACKER_FILE
  else process.env.TRACKER_FILE = prevTracker
  if (prevLock === undefined) delete process.env.TRACKER_SET_LOCK
  else process.env.TRACKER_SET_LOCK = prevLock
  rmSync(dir, { recursive: true, force: true })
})

describe('parseTrackerRow — 遠端字串進 shell 之前的白名單', () => {
  test('合法行：取出狀態與完成時間', () => {
    expect(parseTrackerRow(ROW_DONE)).toEqual({ status: 'done', doneAt: '2026-09-03 1130' })
  })

  test('完成時間為空：doneAt 回空字串（tracker.sh set 第三參數省略）', () => {
    expect(parseTrackerRow(ROW_PENDING)).toEqual({ status: 'pending', doneAt: '' })
  })

  test('舊格式完成時間（20260519 1105）也接受——tracker 裡有這種歷史資料', () => {
    const row = '| FAQ-2122 | https://n/z | P3一般 | done | 2026-04-05 | 20260405 2036 |'
    expect(parseTrackerRow(row)).toEqual({ status: 'done', doneAt: '20260405 2036' })
  })

  test('狀態不在白名單：整行拒絕（不猜、不放行未知字串）', () => {
    const row = '| FAQ-1 | https://n/a | P3一般 | $(rm -rf /) | 2026-01-01 |  |'
    expect(parseTrackerRow(row)).toBeNull()
  })

  test('完成時間是垃圾：狀態照收、時間丟棄（不讓它成為 shell 參數）', () => {
    const row = '| FAQ-1 | https://n/a | P3一般 | done | 2026-01-01 | ; touch /tmp/pwned |'
    expect(parseTrackerRow(row)).toEqual({ status: 'done', doneAt: '' })
  })

  test('欄位數不足：回 null', () => {
    expect(parseTrackerRow('| FAQ-1 | done |')).toBeNull()
    expect(parseTrackerRow('')).toBeNull()
  })

  // 2026-09-08 新增（pipeline-modes Phase 2）：analysis_done 是「只做問題
  // 分析」模式跑完後的暫停態，見 aladdin_ai/scripts/tracker.sh 第 18 行合法
  // 狀態清單。
  test('analysis_done：白名單已放行，跟其餘既有狀態一樣正常解析', () => {
    const row = '| FAQ-5001 | https://notion.so/a | P2較高 | analysis_done | 2026-09-08 |  |'
    expect(parseTrackerRow(row)).toEqual({ status: 'analysis_done', doneAt: '' })
  })
})

describe('readTrackerFile — head 端提供整檔', () => {
  test('正常讀出全文', () => {
    const content = fixture([ROW_PENDING, ROW_DONE])
    writeFileSync(trackerPath(), content)
    expect(readTrackerFile()).toBe(content)
  })

  test('檔案不存在：回 null（worker 端據此保留本機那份）', () => {
    expect(readTrackerFile()).toBeNull()
  })

  test('內容沒有任何資料列：當作讀不到（防空檔/錯誤頁被當正常內容傳出去）', () => {
    writeFileSync(trackerPath(), HEADER)
    expect(readTrackerFile()).toBeNull()
  })
})

describe('writeTrackerFile — worker 端整檔覆蓋', () => {
  test('ok：完整取代舊內容', () => {
    writeFileSync(trackerPath(), fixture([ROW_DONE]))
    const next = fixture([ROW_PENDING])
    expect(writeTrackerFile(next)).toBe('ok')
    expect(readFileSync(trackerPath(), 'utf8')).toBe(next)
  })

  test('目標目錄不存在也能建起來（worker 首次同步，memory/ 是空的）', () => {
    process.env.TRACKER_FILE = join(dir, 'deep', 'memory', 'bug_analysis_tracker.md')
    expect(writeTrackerFile(fixture([ROW_PENDING]))).toBe('ok')
    expect(readFileSync(trackerPath(), 'utf8')).toContain('FAQ-4844')
  })

  test('invalid：沒有資料列的內容一律不寫（本機那份維持原狀）', () => {
    const before = fixture([ROW_DONE])
    writeFileSync(trackerPath(), before)
    expect(writeTrackerFile(HEADER)).toBe('invalid')
    expect(readFileSync(trackerPath(), 'utf8')).toBe(before)
  })

  test('busy：檔級鎖已被別人持有就放棄，不覆蓋（結構性讓路，不等待重試）', () => {
    const before = fixture([ROW_DONE])
    writeFileSync(trackerPath(), before)
    mkdirSync(process.env.TRACKER_SET_LOCK!, { recursive: true })
    expect(writeTrackerFile(fixture([ROW_PENDING]))).toBe('busy')
    expect(readFileSync(trackerPath(), 'utf8')).toBe(before)
  })

  test('寫完會把鎖還回去（下一次同步不會被自己卡住）', () => {
    writeFileSync(trackerPath(), fixture([ROW_DONE]))
    expect(writeTrackerFile(fixture([ROW_PENDING]))).toBe('ok')
    expect(writeTrackerFile(fixture([ROW_DONE]))).toBe('ok')
  })
})

describe('readTrackerRow / applyRemoteTrackerRow — 真的跑 tracker.sh', () => {
  test('讀得到既有單的整行，查無此單回 null', () => {
    writeFileSync(trackerPath(), fixture([ROW_PENDING, ROW_DONE]))
    expect(readTrackerRow('FAQ-4844')).toBe(ROW_PENDING)
    expect(readTrackerRow('FAQ-9999')).toBeNull()
  })

  test('head 端回寫：狀態與完成時間真的落進檔案', () => {
    writeFileSync(trackerPath(), fixture([ROW_PENDING]))
    expect(applyRemoteTrackerRow('FAQ-4844', 'done', '2026-09-03 1130')).toBe(true)
    const after = readFileSync(trackerPath(), 'utf8')
    expect(after).toContain('| done |')
    expect(after).toContain('2026-09-03 1130')
  })

  test('head 那份沒有這張單：回 false（兩邊已不同步，呼叫端記 log）', () => {
    writeFileSync(trackerPath(), fixture([ROW_DONE]))
    expect(applyRemoteTrackerRow('FAQ-4844', 'done', '')).toBe(false)
  })

  test('非法狀態/非法完成時間：直接擋下，不呼叫 tracker.sh', () => {
    const before = fixture([ROW_PENDING])
    writeFileSync(trackerPath(), before)
    expect(applyRemoteTrackerRow('FAQ-4844', 'deleted' as never, '')).toBe(false)
    expect(applyRemoteTrackerRow('FAQ-4844', 'done', '; touch /tmp/pwned')).toBe(false)
    expect(readFileSync(trackerPath(), 'utf8')).toBe(before)
  })

  // 2026-09-08 新增（pipeline-modes Phase 2）：analysis_done 不能被白名單擋
  // 下——tracker.sh 第 49 行 case 分支已放行，這裡驗證真的能寫進檔案。
  test('analysis_done：白名單放行，真的寫進檔案', () => {
    writeFileSync(trackerPath(), fixture([ROW_PENDING]))
    expect(applyRemoteTrackerRow('FAQ-4844', 'analysis_done', '')).toBe(true)
    expect(readFileSync(trackerPath(), 'utf8')).toContain('| analysis_done |')
  })
})
