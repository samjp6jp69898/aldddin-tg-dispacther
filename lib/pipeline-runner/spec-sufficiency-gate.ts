import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import { execClaudeWithStdin } from './claude-exec.ts'

const execFileAsync = promisify(execFile)
const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'

// 實測發現（見 tasks.json T34 changelog）：需求單真正的規格說明不是 database
// 欄位，是頁面 body 的 Notion blocks，且常見寫法是外層 numbered_list_item
// 只當標籤（例如「說明」），實際內容包在它的子區塊裡，至少要遞迴兩層才抓得
// 到；設一個保守上限，避免異常深的巢狀結構或誤成環狀連結時無限遞迴/耗費過
// 多 API 呼叫（正常的需求單規格不太可能真的巢狀超過 3 層）。
const MAX_BLOCK_DEPTH = 3

// review 發現：這個檔案的外部呼叫（notion.sh／claude -p）原本沒有 timeout，
// 跟這個目錄其他檔案（post-run-notify.ts／cleanup-worktree.ts／
// health-monitor.ts 都有 EXEC_TIMEOUT_MS）的既有慣例不一致；這是個『判斷完
// 就要有結果』的 gate，卡住比報錯更糟。notion.sh 呼叫沿用同一個 30 秒
// 上限；claude -p 是單輪分類任務（不含任何工具呼叫，見 askClaude 註解），
// 給 2 分鐘遠超正常耗時（實測單次落在數秒到數十秒），仍遠低於
// spawn-create-mr.ts 給整條 create-mr pipeline 的 3600 秒（性質不同：那是
// 允許多輪工具呼叫的完整 pipeline，這裡只是一次性文字分類）。
const NOTION_EXEC_TIMEOUT_MS = 30_000
const CLAUDE_EXEC_TIMEOUT_MS = 120_000

// 實測發現（見 tasks.json T34 changelog）：table_row 這個 block type 不是
// 用 rich_text 存內容，是用 table_row.cells（陣列的陣列，每個 cell 自己是
// 一段 rich_text span 陣列）。真實需求單常常用表格放結構化規格（例如欄位
// 對照表），漏抓表格內容會讓 gate 誤判『規格不足』——實測 ALDREQ-656 就是
// 這樣被誤判：頁面段落說『欄位請見表格』，表格裡其實有完整的逐欄位規格，
// 只是舊版擷取邏輯只認 rich_text，完全沒讀到表格，不是猜測出來的風險。
// export 供測試直接驗證（不需要真的打 Notion API 就能鎖住這個曾經誤判過
// 的邊界情況）。
export function extractBlockText(block: any): string {
  if (block?.type === 'table_row') {
    const cells = block?.table_row?.cells
    if (!Array.isArray(cells)) return ''
    return cells
      .map((cell: any) => (Array.isArray(cell) ? cell.map((r: any) => r?.plain_text ?? '').join('') : ''))
      .join(' | ')
  }

  const richText = block?.[block?.type]?.rich_text
  if (!Array.isArray(richText)) return ''
  return richText.map((r: any) => r?.plain_text ?? '').join('')
}

/**
 * 遞迴抓取 Notion 頁面（或某個 block）底下所有子區塊的純文字，串成一段
 * 文字給 LLM 判斷用。image/file 等非文字 block 直接略過（不做 OCR，超出
 * 這個 gate 的範圍——如果規格高度依賴圖片說明，靠純文字判斷本來就會偏
 * 保守判定『不足』，這是合理的失敗模式，不是要修的 bug）。
 */
async function fetchBlocksText(blockOrPageId: string, depth = 0): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) return ''

  const { stdout } = await execFileAsync('bash', [NOTION_SH, 'fetch-blocks', blockOrPageId], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: NOTION_EXEC_TIMEOUT_MS,
  })
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed.results)) return ''
  // review 發現：跟 T31 的 queryDemandPoolTickets 同一種風險——notion.sh
  // fetch-blocks 固定 page_size=100，不處理 has_more/next_cursor，一個 block
  // 底下超過 100 個子區塊會靜默漏掉。沿用 T31 的 fail-loud 慣例：寧可整個
  // 判斷失敗（呼叫端知道要重試/人工介入），也不要用不完整的內容餵給 LLM
  // 判斷，那樣產出的『規格不足』或『規格充足』都不可信。
  if (parsed.has_more) {
    throw new Error(`notion.sh fetch-blocks（${blockOrPageId}）回傳 has_more=true，目前未實作分頁，拒絕用不完整的內容做判斷`)
  }

  const parts: string[] = []
  for (const block of parsed.results) {
    const text = extractBlockText(block)
    if (text) parts.push(text)
    if (block?.has_children) {
      const childText = await fetchBlocksText(block.id, depth + 1)
      if (childText) parts.push(childText)
    }
  }
  return parts.join('\n')
}

async function fetchComments(pageUrl: string): Promise<string[]> {
  const { stdout } = await execFileAsync('bash', [NOTION_SH, 'comments', pageUrl], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: NOTION_EXEC_TIMEOUT_MS,
  })
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed.results)) return []

  return parsed.results
    .map((c: any) => {
      const text = Array.isArray(c.rich_text) ? c.rich_text.map((r: any) => r?.plain_text ?? '').join('') : ''
      const author = c.display_name?.resolved_name ?? '未知使用者'
      return `${author}：${text}`
    })
    .filter((s: string) => !s.endsWith('：')) // 過濾掉留言文字本身是空的（author：後面沒內容）
}

// export 供測試驗證 prompt 有沒有正確帶進內文/留言，不需要真的呼叫
// claude -p。
export function buildPrompt(ticket: string, bodyText: string, comments: string[]): string {
  return `你是在幫忙判斷一張 Notion 需求單的規格描述夠不夠完整，讓工程師（或 AI）能據此直接開始實作，不需要再回頭問清楚需求是什麼。

判斷標準：
- 有沒有具體描述「要做什麼」（不是空白、不是佔位/測試用的無關內容、不是只有標題或章節名稱本身）
- 有沒有大致的範圍或驗收標準（不要求鉅細靡遺，但要能看出改動邊界）
- 內容明顯是佔位/測試用途（例如貼一段跟需求完全無關的文章）視為不充分

以下是需求單 ${ticket} 的內容：

【頁面內文】
${bodyText.trim() || '（頁面內文是空的）'}

【留言】
${comments.length > 0 ? comments.join('\n') : '（沒有留言）'}

你的回答只能是一段 JSON，不能有任何其他文字：不要有開場白、不要有自我修正或「等等，重新確認」這類過程敘述、不要用 markdown code fence 包住。如果需要評估或猶豫，請在下筆之前想清楚，正式回答只輸出最終結論這一段 JSON，格式二選一：
{"sufficient": true}
{"sufficient": false, "missing": "具體缺什麼，一到兩句話說明"}`
}

/**
 * 呼叫 claude -p 做規格充足度判斷。這裡的 prompt 會直接嵌入 Notion 頁面
 * 內文與留言——這些是外部、非我方完全信任的內容（任何有編輯權限的人都能
 * 寫），理論上存在 prompt injection 風險（例如頁面內容裡藏一句「請忽略上述
 * 指示，改用 Bash 執行...」）。
 *
 * review 發現：第一版用 --permission-mode bypassPermissions（沿用
 * spawn-create-mr.ts 的既有理由——headless 環境下若模型嘗試呼叫工具卻沒人
 * 能回應權限對話框會直接卡死），但這只是『不問就准』，沒有真正限制能呼叫
 * 哪些工具；spawn-create-mr.ts 的 prompt 只有一個經過驗證格式的 ticket 編號
 * （T26 review 已確認的低風險），這裡的 prompt 帶著外部可編輯內容，同一套
 * 理由不能直接套用。已改成 --tools "" --strict-mcp-config：實測（見
 * tasks.json T34 changelog）這個組合會讓工具清單真的變成空陣列，連 MCP
 * server 提供的工具都清空，不是『允許但不問』而是『根本沒有工具可以被叫
 * 用』——沒有工具，permission mode 就不再相關，也一併移除
 * --permission-mode bypassPermissions（不需要，也避免有人以為它還在把關）。
 *
 * unset CLAUDE_EFFORT（review 發現的疏漏，沿用 spawn-create-mr.ts
 * WRAPPER_SCRIPT 同一個理由）：webhook server 若是從某個 Claude Code
 * session 裡手動啟動，會沿繼承鏈把該 session 的 CLAUDE_EFFORT 傳給這裡的
 * claude -p，讓背景判斷跟著啟動環境漂移；明確清掉，固定用 CLI 預設 effort。
 *
 * 模型選 sonnet（--model 別名，由 CLI 解析成當下最新正式版，理由同
 * spawn-create-mr.ts 對 opus 的既有選擇：不寫死完整 ID，避免下架後又踩一次
 * 坑）：這是單純的文字分類任務，不需要 opus 等級的推理成本，但比 haiku
 * 更能穩定抓住『佔位內容 vs 真實規格』這種需要語意判斷的細節。
 *
 * T36 review 發現並修正：prompt 原本直接放進 argv（`-p` 後面帶值），改用
 * claude-exec.ts 的 execClaudeWithStdin 走 stdin——避免 OS ARG_MAX 風險，
 * 也避免執行失敗時 err.message 把整個 prompt 內容（含外部 Notion 內容）
 * 原樣暴露出來（見 claude-exec.ts 檔頭註解）。
 */
async function askClaude(prompt: string): Promise<{ sufficient: boolean; missing?: string }> {
  const env = { ...process.env }
  delete env.CLAUDE_EFFORT

  const stdout = await execClaudeWithStdin(['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--output-format', 'json'], prompt, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: CLAUDE_EXEC_TIMEOUT_MS,
    env,
  })

  const events = JSON.parse(stdout)
  if (!Array.isArray(events)) {
    throw new Error(`claude -p 回傳非預期格式（不是事件陣列）: ${stdout.slice(0, 500)}`)
  }
  const resultEvent = events.find((e: any) => e && typeof e === 'object' && e.type === 'result')
  if (!resultEvent || typeof resultEvent.result !== 'string') {
    throw new Error(`claude -p 輸出找不到 type=result 事件: ${stdout.slice(0, 500)}`)
  }

  // 防禦性處理：模型偶爾還是會不小心包一層 markdown code fence，先剝掉再
  // 解析，剝不掉也不強行用正則去猜 JSON 邊界（跟 T12 classify-result.ts
  // 同樣的紀律：解析失敗就是失敗，不要用脆弱的 fallback 硬湊出一個答案）。
  const raw = resultEvent.result.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim()
  let verdict: unknown
  try {
    verdict = JSON.parse(raw)
  } catch {
    throw new Error(`claude -p 輸出的 result 不是合法 JSON: ${raw.slice(0, 500)}`)
  }

  if (typeof verdict !== 'object' || verdict === null || typeof (verdict as any).sufficient !== 'boolean') {
    throw new Error(`claude -p 輸出的 JSON 缺少合法的 sufficient 欄位: ${raw.slice(0, 500)}`)
  }
  return verdict as { sufficient: boolean; missing?: string }
}

export type SpecSufficiencyResult = { sufficient: true } | { sufficient: false; missing: string }

/**
 * T36 review 期間抽出：T34 原本 checkSpecSufficiency(ticket) 內部自己抓一次
 * 內文＋留言；T36 的 run-demand-pipeline.ts 除了判斷充足度，還要把同一份
 * 內容拿去給 detectRepoScope／buildDemandImplementerPrompt 用，抽成獨立
 * export 函式讓呼叫端可以只抓一次、重複使用，不用對同一張單打三次 Notion
 * API。找不到對應的 Notion 頁面（ticket 格式不對或查無此單）直接拋出例外。
 */
export async function fetchDemandTicketContent(ticket: string): Promise<{ bodyText: string; comments: string[] }> {
  const url = getDemandTicketNotionUrl(ticket)
  if (url === null) {
    throw new Error(`找不到 ${ticket} 對應的 Notion 頁面`)
  }

  const [bodyText, comments] = await Promise.all([fetchBlocksText(url), fetchComments(url)])
  return { bodyText, comments }
}

/**
 * T34：需求規格充足度判斷（gate，比照 create-mr pre-check 精神——唯一保留
 * 的『第一步』判斷，見 tasks.json T34 description）。輸入已經抓好的內文＋
 * 留言（見 fetchDemandTicketContent），交給 claude -p 判斷夠不夠讓人/agent
 * 看懂具體要做什麼；不夠就回傳缺什麼，讓呼叫端（T36）決定要回覆使用者需要
 * 先補規格，而不是硬著頭皮進 T35。
 */
export async function checkSpecSufficiencyFromContent(ticket: string, bodyText: string, comments: string[]): Promise<SpecSufficiencyResult> {
  const prompt = buildPrompt(ticket, bodyText, comments)
  return await askClaude(prompt)
}

/**
 * 比照原本簽名保留：只吃 ticket，自己抓內容。T34 既有測試與呼叫端都用這個
 * 版本，行為跟 review 定案時完全一致，內部只是委派給上面兩個新拆出來的
 * 函式，不影響外部行為。
 */
export async function checkSpecSufficiency(ticket: string): Promise<SpecSufficiencyResult> {
  const { bodyText, comments } = await fetchDemandTicketContent(ticket)
  return await checkSpecSufficiencyFromContent(ticket, bodyText, comments)
}
