/**
 * T35：需求實作 agent 的 prompt 組裝。不拆解法設計/implementer/review 標準
 * 三階段（使用者 2026-08-17 定案，見 tasks.json T23 changelog）——這裡只是
 * 組出一段完整指示，實際執行仍是單一 agent 一次做完理解→實作→測試→review。
 *
 * 這份 prompt 的具體內容不是憑空設計：先用 3 張難度分級的真實歷史 ALDREQ
 * 單（簡單/中等/複雜跨 repo）做回溯測試，讓一個 agent 在 checkout 於真實
 * 修正之前的 worktree 裡獨立實作，事後跟真實歷史 commit 比對，再派一個
 * 唯讀 review agent 綜合三次結果做方法論層級分析，才歸納出下面
 * IMPLEMENTER_PROMPT_LESSONS 這幾條具體教訓（完整比對紀錄見 tasks.json T35
 * changelog）。核心發現：邏輯/設計正確性不太隨複雜度衰退（複雜案例裡最難
 * 的『cache miss/hit 該不該重寫時間戳』這種設計洞察完全對上真實修正），
 * 但『範圍窮盡性』會——遺漏不是隨機噪音，是固定形狀重複出現（只找到第一個
 * /最明顯的實作點就停止搜尋、新命名前沒查既有慣例），這代表可以用流程
 * 檢查點在單一 agent 內部堵住，不需要因此拆多階段 agent。
 */

export type DemandImplementerRepoScope = {
  /** 這張需求單牽涉到的 repo（agrabah/abu/lago/rajah 的子集） */
  repos: string[]
  /** 每個 repo 對應的 worktree 絕對路徑 */
  worktreePaths: Record<string, string>
}

/**
 * 回溯測試歸納出的具體教訓，直接寫進 prompt 要求 agent 遵守（不是通用開發
 * 建議，是這次測試真實抓到、且能明確對應到某個真實遺漏案例的具體規則）。
 */
const IMPLEMENTER_PROMPT_LESSONS = `
在你判定「已經找到全部相關的實作範圍」之後，**強制換一個不同的搜尋角度重新驗證一次**，不能只重跑同一種比對方式就結束：
- 如果是「共用函式/共用元件」類需求：先用既有的 method-call-graph 找出這個函式/元件的全部 caller；不要就此打住，額外用「同語意特徵」反向搜尋一次（例如同一個 magic number/cache 時長數值、同一個 table 的其他讀寫點），確認有沒有邏輯相同但不經過這個共用函式的獨立呼叫點（回溯測試裡真實漏掉的案例就是這種：共用函式改對了，但另外兩處各自獨立呼叫同一個快取 API 的地方完全沒被搜尋到）。
- 如果是「頁面/選單」類需求：範圍邊界一律以實際選單樹結構（menu.ts 或等價設定）為準，遞迴納入該節點底下所有子頁面，不要只憑頁面命名/檔名跟需求文字做字面比對就決定要不要納入（回溯測試裡真實漏掉的案例：需求文字寫「信息系統」，agent 只挑了字面完全對上的那個頁面，但真實範圍是整個「信息系統」選單群組底下所有子頁面）。
- 產出時列出「候選清單＋每一項的納入/排除理由」，排除項要註明用了什麼搜尋方式確認排除合理，不能只憑「字面不符」就排除。

在新增任何 i18n key、model 欄位名、或其他新識別字之前，**先搜尋鄰近既有慣例**（i18n-lookup 找語意相近的既有 key、db-schema-lookup/rajah-query 找同一個 model 家族既有的欄位命名習慣），找不到才可以新建。如果受硬規則限制沒辦法自己補上理想的值（例如 i18n JSON 值只能由開發者從 Google Sheets 匯入，你只能在程式碼裡寫 key），**不要靜默沿用一個不夠精確的既有 key 就算完成**——在回報裡明確列出「建議新增 key = 建議顯示文字，因為硬規則沒辦法自己寫入，需要人工新增後把程式碼裡的暫用 key 換掉」，把這個落差變成人工看得到、能行動的待辦，而不是藏在程式碼細節裡。

需求文字沒有明講「每個實例各自處理」還是「只需要呈現一次」這種粒度問題時，預設走**最小、最集中**的實作（不要因為技術上更完整就自動做成分散式/每實例各自處理的版本），並在回報裡明確標註「這是一個我做了判斷的設計決策，理由是 XXX」，方便之後的人一眼看出這裡有主觀判斷、需要的話能改。

**你自己對整體實作的信心評分，只對『已經納入範圍內的內容』有意義，對『範圍本身有沒有窮盡』沒有意義**——回溯測試證實：一旦某個項目在你判斷過程早期就被排除，它永遠不會出現在你的信心評分對象裡，不管排除得多草率。所以除了整體信心評分，**另外針對你的『排除清單』本身做一次獨立檢查**：每一項排除理由是不是真的站得住腳，不要因為整體信心高就跳過這一步。
`.trim()

/**
 * 組出完整的需求實作 agent prompt。ticket/specText/comments 是 T34（gate）
 * 已經判斷過『規格充足』的內容，這裡不重新判斷充足度。repoScope 由呼叫端
 * （T36）決定——通常是先分析需求描述涉及哪些 repo，若橫跨 ≥2 個 repo 或
 * 偵測到同語意邏輯有多處獨立呼叫點，T36 應該依 harness review 的結論標記
 * 『需人工複核』而非直接視為全自動完成，這個判斷不在這個函式的職責內。
 */
export function buildDemandImplementerPrompt(ticket: string, specText: string, comments: string[], repoScope: DemandImplementerRepoScope): string {
  const worktreeLines = repoScope.repos.map(repo => `- ${repo}：${repoScope.worktreePaths[repo] ?? '（未提供 worktree 路徑）'}`).join('\n')

  return `你現在的任務是實作一張需求單（${ticket}），單一 agent 直接完成：理解需求 → 找到相關程式碼 → 實作 → 寫 L0 測試（若這類改動在這個 repo 有既有測試慣例可循）→ 跑 lint。不需要先過一個獨立的「解法設計」階段，也不需要另外一個 agent 幫你 review——你自己就是那個 review。

**工作範圍限制**：只能在以下 worktree 裡工作，不要動主 repo 或其他 worktree：
${worktreeLines}

**需求單內容（Notion，已由前一道 gate 判斷過規格充足，可直接動工）**：
${specText.trim() || '（頁面內文是空的——這不應該發生，若你看到這行代表上游 gate 有問題，停下來回報而不是憑空腦補）'}

**留言**：
${comments.length > 0 ? comments.join('\n') : '（沒有留言）'}

**實作紀律**（本節內容來自對真實歷史需求單做回溯測試、比對真實歷史修正後歸納出的具體教訓，不是泛用建議，請確實遵守）：

${IMPLEMENTER_PROMPT_LESSONS}

**完成後回報**：
- 改了哪些檔案（跨哪些 repo），每個檔案的改動摘要
- 候選範圍清單與納入/排除理由（見上方紀律）
- 有沒有新增 i18n key／model 欄位名，有沒有先查過既有慣例
- 有沒有遇到粒度模糊需要自己判斷的地方，怎麼決定的
- lint／測試有沒有跑、結果如何
- 整體信心評分 + 針對排除清單的獨立檢查結果
- 不要 commit、不要 push，把改動留在 working tree`
}
