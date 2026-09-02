import { describe, test } from 'bun:test'

// Phase 1.4 關門測試索引（v3.2 §9 Phase 1.4 修訂清單，BL-E1 / BLOCKER-F1 的
// 關門條件；任一失敗即 Phase 1 不通過，見 plan-db-as-truth-v3.2.md 【G】§9）。
// 六條測試的實作**不集中在本檔**——它們就近放在各自驗證的模組測試裡（更貼近
// 被測邏輯，减少「測試檔與實作檔脫節」的風險），本檔只是逐條列出對照，方便
// review 時核對「六條都真的寫了、不是文件宣稱替代」（impl-errata-g2.md：
// 「Phase 1.4 定位：G2 接受『Phase 1.4 作為可證偽關卡』但不作為判定——測試
// 紅=擋住合入，不以文件宣稱替代」）。
//
//   1. 並行不丟失                → replayer.test.ts:「【Phase 1.4 測試 1】並行不丟失」
//   2. 游標續讀                  → replayer.test.ts:「【Phase 1.4 測試 2】重放者重啟後從游標續讀」
//   3. 回收器不誤刪（pid 存活）  → reaper.test.ts:「【Phase 1.4 測試 3】回收器不誤刪（pid 存活）」
//   4. 回收器不誤刪（lstart 解析失敗，三案例）→ reaper.test.ts:「【Phase 1.4 測試 4】…」× 3
//   4b. 求值順序（MN-G5 的關門）→ reaper.test.ts:「【Phase 1.4 測試 4b】求值順序」
//   5. 重放者互斥                → replayer-lock.test.ts:「【Phase 1.4 測試 5】重放者互斥」
//   6. 鎖檔接管也 fail-closed    → replayer-lock.test.ts:「【Phase 1.4 測試 6】鎖檔接管也 fail-closed」
describe('Phase 1.4 關門測試索引（見上方註解，逐條對照到各模組測試檔）', () => {
  test('六條全部已在對應模組測試檔內實作，本測試只是存在性佔位，不重複邏輯', () => {
    // 見上方註解的對照表；真正的斷言在 replayer.test.ts / reaper.test.ts /
    // replayer-lock.test.ts。
  })
})

// impl-errata-g2.md MJ-H1（cancel run_id 解析次序）：
// 「Phase 1.4 測試清單必須補『同票 auto-retry 交疊 + R1 失效』情境（G2 明言
// 現行清單只列良性方向，擔不起關卡之責）」。
//
// 這個情境屬於 **cancel run_id 解析**（R2 marker 對位 vs R3 legacy_key 確定性
// 對位的優先序判定，見 impl-errata-g2.md 的裁定：「確定性來源優先——R3 排在
// R2 之前；R2 命中時仍須通過『marker.runId 對應列的 ticket/kind 與請求一致』
// 的無 DB 自我驗證」），不是 spool/重放者/回收器的職責——spool 模組完全不知道
// 「cancel」對應的是哪一種語意解析，它只負責把已經帶著確定 run_id 的條目
// （見 types.ts 的硬規則：run_id 不得為空、不得留給重放時再解析）append 進
// 磁碟、原封不動重放。cancel run_id 的解析次序本身屬於 Phase 2（寫入點落地：
// markCancelled 以 run_id 定位，§6.4(4)）與 DB client（lib/monitor-db/writes.ts）
// 的所有權範圍，兩者在本次派工都不屬於本檔負責人。
//
// 依派工指示「若屬 cancel 解析範圍（Phase 2）就在測試檔留 TODO 標記與情境
// 描述，不硬湊」——這裡只留描述性佔位，不在 spool 模組內假造一個不對題的
// cancel-resolution 測試。
test.todo(
  'MJ-H1（cancel run_id 解析）：同票 auto-retry 交疊時 R2 marker 被覆寫 + R1（host 不符）失效 → ' +
    '確定性 R3（legacy_key/stdout_path 對位）優先於 R2；R2 命中時需通過 marker.runId 對應列的 ' +
    'ticket/kind 一致性自我驗證，不一致則降級並計 cancel_marker_mismatch。' +
    '這是 cancel 解析（Phase 2 / lib/monitor-db/writes.ts 所有權範圍）的測試，不在 spool 模組職責內，此處僅佔位。',
  // bun-types 的 test.todo 簽名要求帶 fn（執行期單參數其實合法）；空 fn 讓嚴格 tsc 過。
  () => {},
)
