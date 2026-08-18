import { execClaudeWithStdin } from './claude-exec.ts'

const CLAUDE_EXEC_TIMEOUT_MS = 120_000
const MAIN_REPOS = ['agrabah', 'abu', 'lago', 'rajah'] as const

/**
 * T36：使用者 2026-08-17 定案的範圍偵測關卡——T35 回溯測試證實跨 ≥2 個
 * repo 的需求範圍窮盡性不可靠（複雜樣本漏了 2 個獨立呼叫點，見 tasks.json
 * T35 changelog），現有證據不足以信任這種需求直接全自動完成。這個函式只
 * 判斷「這張需求單看起來會動到哪些 repo」，不判斷規格充不充足（T34 已經
 * 判斷過）、不判斷程式碼實際範圍多大（那是 T35 實作 agent 自己的事）。
 *
 * 跟 T34 checkSpecSufficiency 一樣呼叫 claude -p 做語意判斷（純文字分類，
 * 不需要任何工具），但刻意分開成獨立函式、獨立呼叫，不是塞進 T34 的
 * schema 裡——T34 已經走完 review 定案，不重新開它的 scope；這裡的判準
 * （repo 範圍）跟規格充足度是兩個獨立關注點，混在一起會讓 T34 的既有測試
 * 語意變得不清楚。
 *
 * 安全設計比照 T34 的 askClaude：--tools "" --strict-mcp-config（結構性
 * 清空工具，含 MCP，防這裡同樣會嵌入外部 Notion 內容的 prompt injection
 * 風險）、unset CLAUDE_EFFORT、timeout。
 */
export async function detectRepoScope(ticket: string, specText: string, comments: string[]): Promise<string[]> {
  const env = { ...process.env }
  delete env.CLAUDE_EFFORT

  const prompt = `你是在幫忙判斷一張 Notion 需求單的改動範圍會涉及 aladdin 專案裡哪幾個 repo。這四個 repo 分別是：
- agrabah：後端服務（TypeScript，業務邏輯、API、快取等）
- abu：前端管理後台（Vue）
- rajah：service/model 定義層（.rajah 檔案，agrabah 的後端邏輯與 abu 前端顯示的欄位都源自這裡的定義）
- lago：另一個後端/管理系統，跟 agrabah 是不同的服務體系

判斷原則：
- 只要牽涉到「新增或修改欄位定義」，通常代表 rajah 也會動到（agrabah/abu 要讀寫這個欄位的話）。
- 純前端 UI 調整（文案、按鈕、互動邏輯）且不需要新資料，通常只動 abu。
- 純後端邏輯調整（例如快取策略、計算規則）且不影響前端顯示的資料結構，可能只動 agrabah。
- 不確定的話，寧可多列一個可能的 repo，不要漏列——這是為了判斷是否需要人工複核，漏判會讓真正跨 repo 的需求被誤判成單一 repo 可全自動處理。

以下是需求單 ${ticket} 的內容：

【頁面內文】
${specText.trim() || '（頁面內文是空的）'}

【留言】
${comments.length > 0 ? comments.join('\n') : '（沒有留言）'}

你的回答只能是一段 JSON，不能有任何其他文字：不要有開場白、不要有自我修正或過程敘述、不要用 markdown code fence 包住。格式：
{"repos": ["agrabah", "abu"]}
陣列內容只能是 agrabah/abu/rajah/lago 這四個字串的子集，至少要有一個。`

  // T36 review 發現：prompt 走 stdin 而非 argv（比照 spec-sufficiency-gate.ts
  // 的 askClaude 同步修正，見 claude-exec.ts 檔頭註解——避免 ARG_MAX 風險與
  // 執行失敗時 err.message 洩漏 prompt 內容）。
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

  const raw = resultEvent.result.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`claude -p 輸出的 result 不是合法 JSON: ${raw.slice(0, 500)}`)
  }

  const repos = (parsed as any)?.repos
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error(`claude -p 輸出的 JSON 缺少合法的 repos 欄位: ${raw.slice(0, 500)}`)
  }
  const invalid = repos.filter((r: unknown) => typeof r !== 'string' || !MAIN_REPOS.includes(r as any))
  if (invalid.length > 0) {
    throw new Error(`claude -p 輸出的 repos 含未知值: ${JSON.stringify(invalid)}`)
  }
  return [...new Set(repos as string[])]
}
