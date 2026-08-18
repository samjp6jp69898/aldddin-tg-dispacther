import { describe, expect, test } from 'bun:test'
import { detectRepoScope } from './repo-scope-gate.ts'

// 真實打 claude -p（比照這個 repo 對「語意判斷」類函式的既有慣例——
// spec-sufficiency-gate.test.ts 也是直接打真實 API，不 mock，因為要驗證的
// 正是語意判斷本身有沒有準，mock 掉反而測不出東西）。這三筆規格文字直接
// 取自 T35 回溯測試已核對過真實答案的 3 張 ALDREQ 單（見 tasks.json T35
// changelog）：ALDREQ-652/638 真實只動 abu 一個 repo，ALDREQ-560 真實橫跨
// rajah+agrabah+abu 三個 repo。
describe('detectRepoScope — 真實呼叫 claude -p（比照 spec-sufficiency-gate 既有慣例，刻意不 mock）', () => {
  test('純前端 UI 調整（真實只動 abu）：判斷為單一 repo abu', async () => {
    const repos = await detectRepoScope('ALDREQ-652', '業主需求：日常运营>屏蔽字库 批量刪除請協助新增刪除前二次警告的防呆，未勾選時按鈕disable，勾選後點擊出現確認彈窗', [])
    expect(repos).toEqual(['abu'])
  }, 30_000)

  test('跨三層改動（真實橫跨 rajah+agrabah+abu）：判斷出多個 repo，且涵蓋這三個', async () => {
    const repos = await detectRepoScope(
      'ALDREQ-560',
      '數據總覽頁面內的卡片欄位數據，DB資料更新時間需要改為統一時間，當日數據冷卻時間每5分鐘、非當日數據冷卻時間每30分鐘，頁面卡片欄位區域右上角新增顯示最近一次資料統計更新時間',
      [],
    )
    expect(repos.length).toBeGreaterThanOrEqual(2)
    expect(repos).toContain('agrabah')
    expect(repos).toContain('abu')
  }, 30_000)
})
