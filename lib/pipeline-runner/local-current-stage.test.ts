// lib/pipeline-runner/local-current-stage.test.ts — task 2（2026-09-04）。
//
// TRANSCRIPT_DIR 是真實的 `~/.claude/projects/-Users-user-aladdin`（本機
// Claude Code 的 session transcript 目錄，可能存在大量真實檔案）——比照
// tg-monitor 對等邏輯（inferCurrentBugStage）的既有紀律，不在測試裡對這個
// 目錄寫入/偽造檔案（會汙染真實 session 資料，且路徑是寫死的絕對路徑，無法
// 注入假目錄）。這裡只驗證「找不到匹配 transcript 時的安全回退」——用一個
// 不可能存在的假票號 + 極遙遠的未來時間戳，確保不會誤配到任何真實 transcript
// （findPipelineTranscript 只認 mtime >= runStartedAt 的檔案，未來時間戳保證
// 這個條件對所有現存檔案恆為 false）。
import { describe, expect, test } from 'bun:test'
import { inferCurrentBugStage } from './local-current-stage.ts'

describe('inferCurrentBugStage', () => {
  test('查無匹配 transcript（假票號 + 未來時間戳）：回 null，不丟例外', () => {
    const result = inferCurrentBugStage('FAQ-__no-such-ticket-999999__', '2099-01-01T00:00:00.000Z')
    expect(result).toBeNull()
  })

  test('runStartedAt 是不合法日期字串：Date.parse 得到 NaN，仍不丟例外（安全回退為 null）', () => {
    const result = inferCurrentBugStage('FAQ-__no-such-ticket-999999__', 'not-a-real-date')
    expect(result).toBeNull()
  })
})
