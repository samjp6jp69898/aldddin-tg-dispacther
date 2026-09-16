/**
 * T36（2026-08-18 第二次重新設計，見 tasks.json T36 changelog）：需求 plan
 * pipeline 的 prompt 組裝，純邏輯、不打真實 API，方便測試。
 *
 * 背景：第一版重新設計（產 plan.md、本機啟動 agrabah/abu 全服務驗證）真的
 * 跑了兩次 ALDREQ-746 之後，使用者定案再改一次架構——原因：
 * 1. 本機服務啟動要跑完整 bootstrap（含 DB migrate），實測撞過
 *    agrabah migrate ECONNREFUSED；而且是固定 port＋共用同一份本機 DB，不是
 *    每個 worktree 各自獨立一份基礎設施，跟需求 pipeline 既有的併發上限
 *    （N=2）放在一起會有沒驗證過的 port/DB 衝突風險。
 * 2. 大多數需求單（含 ALDREQ-746 這個真實案例）根本不需要真的啟動服務——
 *    讀原始碼＋查真實 i18n JSON／DB schema 就能百分之百確認答案。
 * 3. 單一 agent 自己審自己，實測抓到一次「結尾格式沒有確實遵守」的真實
 *    問題（RESULT_STATUS 被包進一句話裡，regex 解析失敗，見 changelog）。
 *
 * 改成：不建全服務 worktree，只用輕量 git worktree（純 checkout，跳過
 * bootstrap/migrate）給目標 repo 當唯讀分析起點；2 個 draft agent 各自獨立
 * 產出調查與變更建議 → 3 個 review agent 各自獨立角度審查（coding
 * convention／安全性／可行性-對衝性）→ 1 個 synthesize agent 彙整成最終
 * plan.md → 1 個 classify agent 用 T34/T36 既有的「零工具、只回嚴格 JSON」
 * 模式（不是靠自由文字結尾格式）分類最終結果，避免重蹈同一個解析失敗。
 *
 * 2026-08-21 使用者定案：跨 repo 需求單不再直接被 repo-scope-gate 擋下，
 * 一樣走這條 pipeline——差別只是「目標 repo」從單一個變成一份清單，每個
 * repo 各自一份輕量 worktree，全部放在同一個 worktrees/{ticket}/ 目錄下，
 * draft/review/synthesize agent 的 cwd 指到這個共同目錄，範圍涵蓋每個目標
 * repo 的子目錄。
 */

export type ReviewLens = 'convention' | 'security' | 'conflict'

export const REVIEW_LENSES: { lens: ReviewLens; label: string; focus: string }[] = [
  {
    lens: 'convention',
    label: 'Coding Convention',
    focus: '對照對應 repo 的 CLAUDE.md／既有命名慣例／既有程式碼風格，檢查兩份 draft 建議的變更寫法會不會違反既有慣例（例如 i18n key 命名不符既有家族慣例、model 欄位命名風格不一致、犯了 CLAUDE.md 明文寫的硬規則如「不得直接寫 localizations/*.json 的值」）。',
  },
  {
    lens: 'security',
    label: '安全性',
    focus: '檢查兩份 draft 建議的變更有沒有安全疑慮（例如：建議的查詢邏輯有沒有注入風險、有沒有把不該外洩的內部資訊寫進 plan、有沒有建議繞過既有權限檢查、有沒有建議寫入生產環境或觸碰不該碰的資料）。這次調查全程唯讀，這裡的重點是「plan 裡建議的做法」本身有沒有安全疑慮，不是這次調查過程有沒有安全疑慮。',
  },
  {
    lens: 'conflict',
    label: '可行性／對衝性',
    focus: '兩份 draft 是不是各自獨立找到不同的範圍或做法（這是預期中的正常情況，不是錯誤）？逐項比對：有沒有互相矛盾的建議（同一個地方兩份 draft 給了不同答案，只能有一個是對的）？合併起來的範圍是不是比任一份單獨的範圍更完整（例如一份找到 A 沒找到 B，另一份找到 B 沒找到 A，合併才是真正完整範圍）？有沒有任一份自己說了「範圍窮盡信心較低」但另一份剛好補上那個缺口？最後給出「應該採用哪份/怎麼合併」的具體結論，不要只列差異不下結論。',
  },
]

const EXHAUSTIVENESS_LESSONS = `
在你判定「已經找到全部相關的實作範圍」之後，**強制換一個不同的搜尋角度重新驗證一次**，不能只重跑同一種比對方式就結束：
- 如果是「共用函式/共用元件」類需求：先用既有的 method-call-graph 找出這個函式/元件的全部 caller；不要就此打住，額外用「同語意特徵」反向搜尋一次（例如同一個 magic number/cache 時長數值、同一個 table 的其他讀寫點），確認有沒有邏輯相同但不經過這個共用函式的獨立呼叫點。
- 如果是「頁面/選單」類需求：範圍邊界一律以實際選單樹結構（menu.ts 或等價設定）為準，遞迴納入該節點底下所有子頁面，不要只憑頁面命名/檔名跟需求文字做字面比對就決定要不要納入。
- 產出時列出「候選清單＋每一項的納入/排除理由」，排除項要註明用了什麼搜尋方式確認排除合理，不能只憑「字面不符」就排除。

在建議新增任何 i18n key、model 欄位名、或其他新識別字之前，**先搜尋鄰近既有慣例**（i18n-lookup 找語意相近的既有 key、db-schema-lookup/rajah-query 找同一個 model 家族既有的欄位命名習慣），找不到才可以建議新建。如果受硬規則限制沒辦法自己補上理想的值（例如 i18n JSON 值只能由開發者從 Google Sheets 匯入），在 plan 裡明確列出「建議新增/變更 key = 建議顯示文字，因為硬規則沒辦法自己寫入，需要人工處理」。

需求文字沒有明講粒度問題時，預設走**最小、最集中**的實作建議，並在 plan 裡明確標註「這是一個我做了判斷的設計決策，理由是 XXX」。

除了整體信心評分，**另外針對你的『排除清單』本身做一次獨立檢查**：每一項排除理由是不是真的站得住腳，不要因為整體信心高就跳過這一步。
`.trim()

/**
 * Draft agent prompt。2 個 draft agent 各自拿到完全相同的這份 prompt、
 * 各自獨立執行（不共享彼此的中間過程）——回溯測試與這次真實 ALDREQ-746
 * 兩次重跑都證實：就算 prompt 完全相同，獨立執行兩次的探索路徑與發現範圍
 * 仍會有真實差異（見 tasks.json T36 changelog 的 A/B 兩份 draft 對照），
 * 這正是後面 conflict review 要合併互補的價值所在。
 */
export function buildDraftPrompt(ticket: string, specText: string, comments: string[], repos: string[], worktreeRoot: string): string {
  const repoLines = repos.map(r => `- ${r}：${worktreeRoot}/${r}`).join('\n')
  return `你正在調查一張需求單（${ticket}），目標是產出一份**調查草稿**，供後續彙整成正式 plan.md，不是最終文件，不需要顧慮格式美觀，重點是內容真實、有 file:line 實證。

**這是唯讀分析任務，不要用 Edit/Write 類工具改動任何檔案**（這次執行環境本來就沒有提供這類工具）。

**目標 repo**（判斷這張單會動到以下 ${repos.length} 個 repo，各自都有唯讀 git worktree，內容跟 origin/main 一致）：
${repoLines}

實際範圍仍可能延伸到列表外的其他 repo（agrabah/abu/lago/rajah 都在 /Users/user/aladdin/ 底下，是開發者的真實工作目錄，唯讀讀取沒問題，但**絕對不要對這些路徑執行任何寫入/修改指令**）。

**需求單內容（已由前一道 gate 判斷過規格充足）**：
${specText.trim() || '（頁面內文是空的——這不應該發生，若你看到這行代表上游 gate 有問題，停下來回報而不是憑空腦補）'}

**留言**：
${comments.length > 0 ? comments.join('\n') : '（沒有留言）'}

**驗證要求**：不能只靠讀原始碼推論，要用真實資料驗證（i18n-lookup 查真實翻譯 JSON 現值、db-schema-lookup 查真實 DB schema、method-call-graph 查真實呼叫鏈、rajah-query 查真實 model/enum 定義——這些 skill 對應的腳本可以直接用 Bash 執行）。查不到/驗證不了的地方要誠實寫「這一點沒有驗證，原因是 XXX，信心較低」，不要假裝驗證過。

**範圍窮盡紀律**（來自對真實歷史需求單做回溯測試歸納出的具體教訓）：

${EXHAUSTIVENESS_LESSONS}

**產出**（直接在回答裡寫，不要輸出成檔案）：
1. 需求摘要
2. 逐項變更清單：檔案:行號、現況、建議、理由
3. 驗證過程：你實際查了什麼、查到什麼真實結果
4. 候選範圍清單＋納入/排除理由
5. 有沒有新增/變更 i18n key／model 欄位名，有沒有先查過既有慣例
6. 判斷決策記錄（粒度模糊的地方怎麼決定的）
7. 整體信心評分＋針對排除清單的獨立檢查`
}

/**
 * Review agent prompt：3 個角度各自獨立看兩份 draft，見 REVIEW_LENSES。
 *
 * 2026-09-16 起也帶入留言（含 notion.sh comments-resolved 下載回來的附件
 * 全文）。實證動機：ALDREQ-865 的技術人員把整份規格設計寫在留言附件裡，
 * 修好 fetchComments 之後 draft 讀得到、review/synthesize 卻讀不到，該次
 * 產出的 plan.md 裡 synthesize 自己就寫了「在原始草稿的外部附件中如何具體
 * 實作，本次彙整環境無法交叉核對」——審查階段只能靠 draft 轉述，等於放棄
 * 對最權威那份規格的獨立查證。代價是 prompt 變長（附件上限 60000 字元），
 * 換到的是 reviewer 能直接拿附件原文打臉 draft 的誤讀。
 */
export function buildReviewPrompt(lens: ReviewLens, ticket: string, specText: string, comments: string[], drafts: { label: string; text: string }[]): string {
  const lensInfo = REVIEW_LENSES.find(l => l.lens === lens)
  if (!lensInfo) throw new Error(`未知的 review lens: ${lens}`)

  const draftsText = drafts.map(d => `### ${d.label}\n${d.text}`).join('\n\n')

  return `你正在審查針對需求單 ${ticket} 的兩份獨立調查草稿，只從「${lensInfo.label}」這個角度審查，不需要重複做全面 review。

**審查重點**：${lensInfo.focus}

**這是唯讀審查任務，不要用 Edit/Write 類工具改動任何檔案**（這次執行環境本來就沒有提供這類工具）。可以用 Bash/Read/Grep 之類的工具去驗證 draft 裡的說法是否真的站得住腳，不要只憑 draft 文字本身照單全收。

**需求單內容**：
${specText.trim() || '（頁面內文是空的）'}

**留言**（可能含技術人員貼的附件全文，那往往是比需求單本文更具體的規格來源；draft 對它的轉述若與原文不符，以原文為準）：
${comments.length > 0 ? comments.join('\n') : '（沒有留言）'}

**兩份獨立草稿**：
${draftsText}

**產出**：從你的角度給出結論，明確列出發現的問題（如果有）與具體建議；如果兩份草稿在這個角度上都沒有問題，明確寫「PASS，未發現問題」，不要為了寫而硬找問題。`
}

/**
 * Synthesize agent prompt：彙整兩份 draft ＋ 三個角度的 review 結論，產出
 * 最終 plan.md 內容（純文字，由呼叫端寫入檔案，這個 agent 本身不需要
 * Write 權限）。
 */
export function buildSynthesizePrompt(
  ticket: string,
  specText: string,
  comments: string[],
  drafts: { label: string; text: string }[],
  reviews: { label: string; text: string }[],
): string {
  const draftsText = drafts.map(d => `### ${d.label}\n${d.text}`).join('\n\n')
  const reviewsText = reviews.map(r => `### ${r.label}\n${r.text}`).join('\n\n')

  return `你正在把兩份獨立調查草稿與三個角度的 review 結論，彙整成一份最終的實作計畫文件（${ticket}-plan.md），供同事直接照著改到自己的分支。

**這是唯讀彙整任務，不要用 Edit/Write 類工具改動任何檔案**（這次執行環境本來就沒有提供這類工具，你的完整回答文字本身就是最終文件內容，不需要另外輸出成檔案）。

**需求單內容**：
${specText.trim() || '（頁面內文是空的）'}

**留言**（可能含技術人員貼的附件全文；彙整時以附件原文為準，不要只依賴 draft 對它的轉述）：
${comments.length > 0 ? comments.join('\n') : '（沒有留言）'}

**兩份獨立草稿**：
${draftsText}

**三個角度的 review 結論**：
${reviewsText}

**彙整原則**：
- 兩份草稿若有互補（各自找到對方沒找到的部分），合併成更完整的範圍，不要只選一份丟掉另一份的發現。
- 兩份草稿若有矛盾，以 conflict review 的結論為準，並在文件裡註明「這裡曾經有兩種不同判斷，採用 XXX 的理由是 YYY」。
- 三個角度 review 若有發現問題，要真的採納修正，不能列出來又不處理。
- 不要重複貼兩份草稿的原文，用你自己的話重新整理成一份連貫的文件。

**輸出格式**（直接輸出這份 markdown 全文，不要有任何開場白或收尾客套話）：

\`\`\`
# ${ticket} 實作計畫

## 需求摘要
...

## 逐項變更清單
| # | 檔案:行號 | 現況 | 建議 | 理由 | 信心 |
|---|---|---|---|---|---|
...

## 驗證依據
...

## 候選範圍清單（納入/排除）
...

## 新增/變更識別字與既有慣例比對
...

## 判斷決策記錄
...

## Review 結果
| 角度 | 結論 | 採納的發現 |
|---|---|---|
| Coding Convention | ... | ... |
| 安全性 | ... | ... |
| 可行性／對衝性 | ... | ... |

## 待人工處理事項
...

## 整體信心評分
...
\`\`\`
`
}

/**
 * Classify agent prompt：吃 synthesize 產出的最終 plan.md 全文，只回嚴格
 * JSON——比照 T34 spec-sufficiency-gate／T36 repo-scope-gate 既有的「零
 * 工具、只回一段 JSON」模式，不再像上一版靠自由文字結尾格式（那一版真實
 * 跑壞過一次，RESULT_STATUS 被包進一句話裡 regex 解析失敗，見 changelog）。
 */
export function buildClassifyPrompt(ticket: string, planContent: string): string {
  return `以下是需求單 ${ticket} 的最終實作計畫文件全文。請判斷這份計畫屬於哪一種結果：

- "success"：找到具體可行動的變更建議（不管有沒有受硬規則限制只能建議、不能自己動手，只要有明確的檔案/key/建議值就算）
- "already-satisfied"：調查後判定這個需求其實已經被現有程式碼滿足，不需要再改
- "needs-clarification"：調查過程中發現規格或範圍有無法自行判定的實質落差，任何合理判斷都可能是錯的

【計畫文件全文】
${planContent}

你的回答只能是一段 JSON，不能有任何其他文字：不要有開場白、不要有自我修正或過程敘述、不要用 markdown code fence 包住。格式：
{"status": "success"}`
}
