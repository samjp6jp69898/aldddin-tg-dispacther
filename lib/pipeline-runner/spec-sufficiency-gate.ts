import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDemandTicketNotionUrl } from '../notion-integration/demand-pool-tickets.ts'
import { execClaudeWithStdin } from './claude-exec.ts'
import { extractLastJsonObject } from './extract-json-object.ts'

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
// 上限。claude -p 原本是零工具的單輪分類任務，2 分鐘遠超正常耗時；2026-08-21
// 改成會呼叫 Read/Grep/Glob 探索 codebase（見 askClaude 註解），拉長到 5
// 分鐘給工具呼叫輪次留空間，仍遠低於 spawn-create-mr.ts 給整條 create-mr
// pipeline 的 7200 秒（性質不同：那是允許多輪工具呼叫＋改檔的完整 pipeline，
// 這裡只是唯讀探索後的一次性文字分類）。
const NOTION_EXEC_TIMEOUT_MS = 30_000
// comments-resolved 除了打 Notion comments API，還要逐份下載留言附件（每份
// 自己有 20 秒上限），一則留言掛好幾份文件時 30 秒會不夠，給它獨立的寬鬆上限。
const NOTION_COMMENTS_TIMEOUT_MS = 90_000
const CLAUDE_EXEC_TIMEOUT_MS = 300_000
// 2026-08-21 使用者定案新增：codebase 根目錄，讓 askClaude 的 explorer agent
// 能讀到 agrabah／abu／rajah／lago 全部 repo（哪個 repo 都可能跟需求單有關，
// 判斷階段還沒走到 T36 repo-scope-gate，不能只給單一 repo 的路徑）。
const CODEBASE_ROOT = '/Users/user/aladdin'
// 唯讀探索工具白名單：只給 Read/Grep/Glob，刻意不給 Bash（跟
// demand-plan-pipeline.ts 的 READONLY_TOOLS 不同）——這裡只需要『找到相關
// 程式碼、看懂既有模式』，不需要執行任何指令；範圍縮到最小，prompt injection
// 的可攻擊面也跟著降到最低（見 askClaude 註解的完整風險說明）。
const EXPLORE_TOOLS = 'Read,Grep,Glob'

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
  // review 當時發現：跟 T31 的 queryDemandPoolTickets 同一種風險——notion.sh
  // fetch-blocks 固定 page_size=100，不處理 has_more/next_cursor，一個 block
  // 底下超過 100 個子區塊會靜默漏掉。2026-08-23 已在 notion.sh 本身修好
  // （自動追完所有分頁再合併，見 scripts/notion.sh fetch-blocks 註解），
  // has_more 現在保證恆為 false。這裡的檢查改留著當防禦性斷言（成本趨近於
  // 零）：萬一之後 notion.sh 的分頁邏輯有 regression，仍會 fail-loud（呼叫端
  // 知道要重試/人工介入），不會用不完整的內容餵給 LLM 判斷。
  if (parsed.has_more) {
    throw new Error(`notion.sh fetch-blocks（${blockOrPageId}）回傳 has_more=true（預期不會發生，notion.sh 應已內部追完分頁），拒絕用不完整的內容做判斷`)
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

export type ResolvedAttachment = { name?: string; kind?: string; content?: string; note?: string }
export type ResolvedComment = { author?: string; created_time?: string; text?: string; attachments?: ResolvedAttachment[] }

/**
 * 把 notion.sh comments-resolved 的一則留言攤平成一段文字給 LLM 讀。
 *
 * 2026-09-16 實測回報的缺口（ALDREQ-865）：Notion 留言可以完全沒有文字、只
 * 有附件（rich_text 空陣列，檔案在 attachments）。舊版只讀 rich_text，再用
 * 「結尾是『：』就丟掉」濾掉空留言，結果同事貼的整份規格文件連『存在』都
 * 沒進到 gate／repo-scope／draft 三段 prompt。現在：有文字或有附件就保留，
 * 文字類附件內容直接內嵌（notion.sh 已下載好），讀不到的附件至少留檔名 +
 * 原因，讓判斷者知道有這份文件而不是以為沒有。
 *
 * 回傳 null 代表這則留言真的完全沒有資訊量（沒文字也沒附件），照舊濾掉。
 */
function formatResolvedComment(c: ResolvedComment): string | null {
  const author = c.author ?? '未知使用者'
  const text = c.text ?? ''
  const attachments = Array.isArray(c.attachments) ? c.attachments : []
  if (text.trim() === '' && attachments.length === 0) return null

  const parts = [`${author}：${text}`]
  for (const a of attachments) {
    const name = a.name ?? '（檔名不明）'
    if (typeof a.content === 'string' && a.content !== '') {
      parts.push(`[附件 ${name}${a.note ? `（${a.note}）` : ''}]`, a.content, `[附件結束 ${name}]`)
    } else {
      parts.push(`[附件 ${name}（${a.note ?? '未載入內容'}）]`)
    }
  }
  return parts.join('\n')
}

/** export 供測試直接驗證解析行為，不需要真的打 Notion API。 */
export function formatResolvedComments(results: ResolvedComment[]): string[] {
  return results.map(formatResolvedComment).filter((s): s is string => s !== null)
}

/**
 * 留言內容（含附件）一律走 notion.sh comments-resolved：附件下載與文字/二進位
 * 判定都在該子命令內完成，這裡只負責排版。注意附件內容是外部文件，跟留言文字
 * 一樣屬於不可信輸入——餵給的 agent 工具集刻意維持最小（見 askClaude 註解）。
 * comments-resolved 抓不到留言時會 exit 1（execFileAsync 直接 reject），不會
 * 靜默回空陣列讓下游以為這張單沒人留言。
 */
async function fetchComments(pageUrl: string): Promise<string[]> {
  const { stdout } = await execFileAsync('bash', [NOTION_SH, 'comments-resolved', pageUrl], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: NOTION_COMMENTS_TIMEOUT_MS,
  })
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed.results)) return []

  return formatResolvedComments(parsed.results)
}

// export 供測試驗證 prompt 有沒有正確帶進內文/留言，不需要真的呼叫
// claude -p。
export function buildPrompt(ticket: string, bodyText: string, comments: string[]): string {
  return `你是在幫忙判斷一張 Notion 需求單的規格描述夠不夠完整，讓工程師（或 AI）能據此直接開始實作，不需要再回頭問清楚需求是什麼。

你有 Read/Grep/Glob 這三個唯讀工具，可以直接查看 /Users/user/aladdin 底下 agrabah／abu／rajah／lago 這幾個 repo 的原始碼。下判斷之前，先去 codebase 找找需求單提到的 service／method／欄位／既有邏輯（例如同一個訊息結構是否已經有類似欄位、同一個 service 是否已經有相同模式的既有寫法）。很多小需求單的 Notion 文字本身只寫了「要做什麼」加一兩個關鍵字，但只要 codebase 裡的既有慣例足以補齊實作細節（資料來源、命名、格式都能參照既有同類欄位），就要判定為足夠，不要只因為 Notion 文字本身簡短就直接判不足。

判斷標準：
- 有沒有具體描述「要做什麼」（不是空白、不是佔位/測試用的無關內容、不是只有標題或章節名稱本身）
- 有沒有大致的範圍或驗收標準；這個範圍不強制寫在 Notion 文字裡，能從 codebase 既有同類邏輯合理推得也算數
- 需求單提到的 service／method／欄位在 codebase 裡找不到對應位置、或找到後仍有多種互斥的實作方式而需求單完全沒講清楚要選哪一種，才視為不充分
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
 * 歷史演進（T34 review，已被 2026-08-21 那則新註解取代成目前實際行為，
 * 留著只為了說明『為什麼不是一開始就用 bypassPermissions』）：第一版用
 * --permission-mode bypassPermissions（沿用 spawn-create-mr.ts 的既有理由
 * ——headless 環境下若模型嘗試呼叫工具卻沒人能回應權限對話框會直接卡死），
 * 但這只是『不問就准』，沒有真正限制能呼叫哪些工具；spawn-create-mr.ts 的
 * prompt 只有一個經過驗證格式的 ticket 編號（T26 review 已確認的低風險），
 * 這裡的 prompt 帶著外部可編輯內容，同一套理由不能直接套用，故 T34 當時
 * 改成 --tools "" --strict-mcp-config 把工具清單清空、一併移除
 * --permission-mode bypassPermissions。這個『零工具』狀態已在 2026-08-21
 * 改掉（見下方新註解）——目前是 EXPLORE_TOOLS＋重新加回
 * --permission-mode bypassPermissions，不是這裡描述的狀態。
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
 *
 * 2026-08-21 使用者定案（實測 ALDREQ-765 誤判）：這張需求單的 Notion 內文
 * 只列出欄位變更項目，沒寫資料來源／計算邏輯，零工具版本因為完全看不到
 * codebase，只能照文字表面判『規格不足』；但需求其實是替既有訊息結構加一
 * 個欄位，codebase 裡同一個 service 已經有同模式的既有欄位可以直接參照，
 * 人看一眼就懂。改成給 EXPLORE_TOOLS（Read/Grep/Glob）＋cwd=CODEBASE_ROOT，
 * 讓判斷前先探索 codebase。刻意不給 Bash（跟 demand-plan-pipeline.ts 的
 * READONLY_TOOLS 不同）：這裡只需要『找得到相關程式碼、看得懂既有模式』，
 * 不需要執行任何指令，能攻擊面縮到最小。--strict-mcp-config 保留不變且更
 * 重要了——cwd 換成 aladdin 根目錄後會讀到那裡的 .mcp.json，若不擋，外部可
 * 編輯的 Notion 內容理論上就能誘導呼叫 telegram/google drive 等 MCP 工具，
 * 這是這個檔案最初的 injection 防線核心，不能因為從零工具改成唯讀工具就
 * 跟著鬆動。--permission-mode bypassPermissions 重新加回來（工具非空，
 * headless 環境沒人能回應權限對話框，理由同最上面移除它之前的舊版）。
 */
async function askClaude(prompt: string, ticket: string): Promise<{ sufficient: boolean; missing?: string }> {
  const env = { ...process.env }
  delete env.CLAUDE_EFFORT

  const stdout = await execClaudeWithStdin(
    ['-p', '--model', 'sonnet', '--tools', EXPLORE_TOOLS, '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--output-format', 'json'],
    prompt,
    {
      cwd: CODEBASE_ROOT,
      maxBuffer: 10 * 1024 * 1024,
      timeout: CLAUDE_EXEC_TIMEOUT_MS,
      env,
      trace: { ticket, stage: 'spec-gate' },
    },
  )

  const events = JSON.parse(stdout)
  if (!Array.isArray(events)) {
    throw new Error(`claude -p 回傳非預期格式（不是事件陣列）: ${stdout.slice(0, 500)}`)
  }
  const resultEvent = events.find((e: any) => e && typeof e === 'object' && e.type === 'result')
  if (!resultEvent || typeof resultEvent.result !== 'string') {
    throw new Error(`claude -p 輸出找不到 type=result 事件: ${stdout.slice(0, 500)}`)
  }

  // 防禦性處理：模型偶爾還是會不小心包一層 markdown code fence，先剝掉再解析。
  const raw = resultEvent.result.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim()
  let verdict: unknown
  try {
    verdict = JSON.parse(raw)
  } catch {
    // 2026-09-04 新增（ALDREQ-835 真實案例）：模型偶爾會在真正的 JSON 前多寫
    // 一段推理文字才收尾（判斷本身是對的，純粹格式沒完全照『只回 JSON』的
    // 指令）。跟 classify-result.ts extractResultEvent() 拒絕的「正則猜邊界」
    // 不是同一件事——那裡解析的是 claude -p CLI 自己印出的 event envelope
    // （機器產生、理論上永遠乾淨，過去真的因為 stdout/stderr 混流出過 bug，
    // 已用「檔案分離」從結構上根治，不該在那層加解析端救援）；這裡解析的是
    // 模型自由文字，且救援步驟只接受完整合法的 JSON 物件（extractLastJsonObject
    // 找不到就回 undefined，不修補、不猜測破損內容），找不到時走跟以前完全
    // 一樣的 fail-loud 錯誤，不會改變既有行為。見 extract-json-object.ts 檔頭。
    const rescued = extractLastJsonObject(raw)
    if (rescued === undefined) {
      throw new Error(`claude -p 輸出的 result 不是合法 JSON: ${raw.slice(0, 500)}`)
    }
    verdict = rescued
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
  return await askClaude(prompt, ticket)
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
