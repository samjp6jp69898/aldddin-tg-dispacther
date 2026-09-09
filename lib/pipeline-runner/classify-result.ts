// 解析 T11 產生的 stdout log 檔（timeout 10800 claude -p "/create-mr:create-mr
// {ticket}" 的**純 stdout**——T11 把 stdout/stderr 分開寫成兩個檔案，不會混進
// stderr 雜訊），依 headless-pipeline 調查的判斷規則分類，供 T13 決定是否補發
// 通知。格式：2026-08-26 前是 --output-format json 的單一 JSON 陣列（結束才
// flush）；2026-08-26 起改 --output-format stream-json 的 JSONL（逐行即時落盤，
// timeout 被砍也保得住已輸出部分）。extractResultEvent 雙格式都支援。
//
// 判斷順序（見 tasks.json T12 description）：
//   1. 外層 exit code 非 0：124（GNU timeout 逾時被殺）獨立分類成 timeout；
//      其餘非 0 值 → infra_failure
//   2. claude -p 的 JSON 輸出中 is_error/subtype 顯示 CLI 層級失敗 → cli_failure
//   3. jq -r .result 解開後判斷：create-mr.md Step 9 完成報告固定有一行
//      「- Pipeline status: {pipeline_status}」，用錨定 regex 抓這一行的值
//      直接對應 success（含 already_fixed / i18n_manual_handoff）/
//      needs_qa_clarification / analysis_done（2026-09-08 新增，見
//      pipeline-modes-project-docs/plan-pipeline-modes-v1.md §2.4）/ failed；
//      抓不到這行時才看是不是真正的早退 SKIPPED（見下方判斷順序註解）；
//      都不是 → unknown_failure
//
// ============================================================================
// 2026-09-04 研究補充：能不能可靠偵測「Claude session/usage limit 用盡」
// ============================================================================
// 背景：worker/head 共用的 wrapper 呼叫 `claude -p` 跑 /create-mr，若剛好在
// 額度用盡時中斷，目前的分類完全無法跟其他「CLI 非正常結束」區分開來，人工
// 要花時間才能判斷是不是額度問題。以下是這次研究的結論（含來源），供之後
// 維護者判斷要不要調整/加強這個偵測。
//
// 【結論】沒有官方文件化、穩定的程式化管道能可靠區分「額度用盡」跟其他
// CLI 非正常結束，但**有**已知會出現的 stdout 文字特徵，可以做成低信心度的
// 字串比對 heuristic——比完全不分類好，但不能當成 100% 準確的事實。
//
// 逐項調查結果：
//
// 1. exit code / stderr：官方文件明確說 `claude -p` 目前對「所有」失敗類型
//    （含額度用盡、429、認證失敗、參數錯誤）都只回傳 exit code 1、stderr
//    永遠是空的，失敗訊息是印在 stdout 的 result 欄位裡（不是獨立 exit code
//    或獨立 stderr JSON）。這點在 headless 文件與一個尚未實作的 issue 都有
//    印證：
//    - https://code.claude.com/docs/en/headless
//      ＂When a failure happens inside the run, such as missing
//      authentication, Claude Code prints the failure as the result on
//      stdout.＂
//    - https://github.com/anthropics/claude-code/issues/35540（feature
//      request：希望 rc=1/rc=2 區分本地錯誤跟可重試的 API 錯誤、stderr 印
//      structured JSON——這個 issue 存在本身就證明「目前沒有」，截至查證時
//      仍是 open/未實作）。
//    - 同一份 headless 文件裡 `system/api_retry` event 有文件化的
//      `error` 分類 enum：`authentication_failed` / `oauth_org_not_allowed`
//      / `billing_error` / `rate_limit` / `overloaded` / `invalid_request` /
//      `model_not_found` / `server_error` / `max_output_tokens` / `unknown`
//      ——但這是「會自動重試」的錯誤分類，額度用盡（5hr/週）不屬於這個
//      retry 機制（用盡了不會重試，是直接讓這輪失敗/停住），所以這個 enum
//      裡沒有、也不會有專門對應「usage limit reached」的值。
//
// 2. statusline 讀用量的資料來源：statusline 的 `rate_limits.five_hour` /
//    `rate_limits.seven_day`（`used_percentage` + `resets_at`）是 Claude Code
//    在**互動中的 session**每次要重繪 statusline 時，透過 stdin 把 JSON 直接
//    餵給 statusline 腳本——只在該次呼叫的 stdin 內存在，並不是寫進
//    `~/.claude/` 底下某個檔案讓外部腳本事後讀取，且只在 Pro/Max 訂閱、
//    收到過至少一次 API 回應之後才會出現（需要 Claude Code ≥2.1.251）。
//    來源：https://code.claude.com/docs/en/statusline
//    （見 `rate_limits` 欄位表格與＂appears only for Claude.ai Pro and Max
//    subscribers...and only after the first API response＂）。
//    也沒有 `claude usage --json` 這類子指令可以獨立呼叫拿到同樣資料——
//    這是一個目前仍是 open 的 feature request：
//    https://github.com/anthropics/claude-code/issues/40793
//    結論：這條路徑對「批次呼叫 claude -p 之後，事後解析 log 判斷這輪是否
//    因額度用盡而中斷」完全不適用——沒有 stdin JSON 可讀（沒有互動 session
//    在跑），也沒有檔案或子指令可以查。
//
// 3. Hook：`Notification` hook 的 `notification_type` 列舉裡有
//    `quota_auto_resume_fired` / `quota_auto_resume_stale` /
//    `quota_auto_resume_disabled` 三個值，暗示 Claude Code 有一套「額度用盡
//    時自動等到重置後恢復」的機制，但官方文件對這三個值的 payload 細節、
//    以及是否會在 `-p`／headless 模式下觸發（不是只有互動式 TUI session）
//    都沒有寫清楚。來源：https://code.claude.com/docs/en/hooks
//    要用這條路徑得額外架設 hook 腳本 + `.claude/settings.json` 設定（目前
//    這個 repo 沒有這套基礎設施），且無法確認涵蓋 headless 呼叫，這次先不
//    採用；如果之後要做，順序上這會是比字串比對更可靠的訊號，值得優先
//    研究驗證 headless 模式下是否真的會觸發。
//
// 4. 已知會出現的 stdout 文字特徵：官方 error reference 文件列出使用者會
//    看到的字面錯誤文字：
//    ＂You've hit your session limit＂／＂You've hit your weekly limit＂／
//    ＂You've hit your Opus limit＂／＂You've hit your Sonnet limit＂／
//    ＂Credit balance is too low＂／＂spend limit reached＂／
//    ＂spend limit unavailable＂
//    來源：https://code.claude.com/docs/en/errors
//    第三方社群工具 claude-auto-retry（專門做「偵測到額度用盡就自動等待重
//    試」）也是靠比對這一類終端文字字串來偵測，而非任何官方結構化欄位，
//    印證這是目前業界唯一可行、但非官方保證的做法。它實際觀察到的字串包含
//    （含 reset 時間的變化寫法）：
//    ＂5-hour limit reached - resets 3pm (UTC)＂／
//    ＂Claude usage limit reached. Resets at 2pm＂／
//    ＂You're out of extra usage · resets 3pm＂
//    來源：https://github.com/cheapestinference/claude-auto-retry
//
//    已知偽陰性風險（會漏判）：
//    - 這些文字**不是**官方保證穩定的 API 契約，版本更新可能改寫措辭而不
//      通知，字串比對會隨時失準。
//    - 有真實回報案例是額度用盡時**完全沒有任何錯誤訊息**、session 直接
//      靜默結束（互動模式，Windows，v2.1.49）：
//      https://github.com/anthropics/claude-code/issues/27236
//      這種情況下字串比對注定抓不到，會落回 cli_failure/infra_failure。
//    - 若 CLI 觸發「額度用盡→自動等到重置」而卡住，最終是被本專案外層
//      `timeout 10800` 秒殺掉（exitCode 124），會落入既有的 `timeout`
//      分類（有自己的升級+自動重試機制），不會走到這裡的字串比對——這是
//      刻意的設計選擇，不在這次改動範圍內去拆分 timeout 底下還有沒有額度
//      用盡的子原因。
//    已知偽陽性風險：低——上面採用的字串都是官方文件/社群工具驗證過的
//    具體片語，不是「rate limit」這種通用詞（通用的 429/暫時限流訊息，如
//    ＂Server is temporarily limiting requests＂／＂Request rejected
//    (429)＂，屬於暫時性、非額度用盡，故意不放進偵測清單，避免把單純網路
//    抖動誤判成額度用盡）。
//
// 【設計決定】採用最保守可行的做法：只做 stdout 內容的字串特徵比對
// （`SESSION_LIMIT_PATTERNS`），新增 `session_limit` 分類，明確標示為低信心
// 度 heuristic；不採用 statusline 資料來源（拿不到）、不新架設 hook 基礎
// 設施（這次範圍之外，且無法確認 headless 適用性）。通知文字必須用「疑似」
// 字樣，不能斷言為事實，且已知會有漏判（見上）——漏判時仍會照舊落入
// infra_failure/cli_failure/unknown_failure，不影響既有補發通知的保底機制。
// ============================================================================

// 給 T13 的提醒（review 發現，不是 classify-result.ts 自己的責任範圍，但會
// 影響 T13 怎麼用這個分類結果）：
//   - 'success' 這個標籤底下的 already_fixed / i18n_manual_handoff 兩種子
//     情況，create-mr.md 內部只留 Notion 留言、**不會**主動發 TG 通知（只有
//     真正的 success 才會，見 create-mr.md Step 7 出口表）。T13 若打算用
//     「classify 結果 = success 就代表 create-mr 已經通知過使用者、不用
//     補發」來判斷，不能只看這個粗標籤，還要另外辨別這兩種子情況。
//   - infra_failure 與 cli_failure 這兩類，create-mr 根本沒機會執行到任何
//     通知邏輯（連 CLI 都沒正常跑完/沒吐出合法 JSON），邏輯上應該也要落入
//     「需要補發通知」那組——但 T12 只負責分類，T13 目前的 description 只
//     明確提到 unknown_failure 與 skipped 兩類需要補發，這兩類要不要一併
//     補發、以什麼內容補發，留給 T13 實作時跟使用者確認。

export type Classification =
  // 對應 create-mr.md 自己吐出的 pipeline_status（連同真正的早退 SKIPPED），
  // 表示 CLI 有跑完、有拿到合法結果，只是結果內容分這幾種。
  | 'skipped'
  | 'success'
  | 'needs_qa_clarification'
  // 2026-09-08 新增，pipeline-modes Phase 2：「只做問題分析」模式的暫停
  // 出口，create-mr 自己會在 7c 發 TG，不是失敗（見
  // pipeline-modes-project-docs/plan-pipeline-modes-v1.md §2.4）。
  | 'analysis_done'
  | 'failed'
  // dispatcher 自己合成的分類，create-mr 完全沒機會回報這幾種——代表 CLI
  // 這層本身就有問題（跑不完、跑完但沒吐出可辨識的合法結果）。
  | 'timeout' // exitCode === 124：GNU timeout 把 claude -p 中途砍掉
  | 'infra_failure'
  | 'cli_failure'
  | 'unknown_failure'
  // 2026-09-04 新增，見上方研究補充：exitCode!=0 或拿不到合法成功結果時，
  // stdout 內容命中已知的 Claude session/usage limit 錯誤文字特徵——低信心
  // 度 heuristic，不是官方保證的訊號，會有漏判（見上方偽陰性風險）。
  | 'session_limit'

// 2026-09-04：見上方研究補充第 4 點——這些是官方 error reference 文件與
// 第三方社群工具實際觀察到的 Claude session/usage limit 錯誤文字。刻意不含
// 通用的「rate limit」/429 暫時限流字樣（那是另一種暫時性問題，不是額度
// 用盡，混進來會製造偽陽性）。大小寫不拘（`i` flag），因為 CLI 版本/情境
// 不保證固定大小寫。
const SESSION_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve hit your (session|weekly|opus|sonnet) limit/i,
  /5-hour limit reached/i,
  /claude(?:\s+ai)? usage limit reached/i,
  /usage limit reached/i,
  /you'?re out of extra usage/i,
  /credit balance is too low/i,
  /spend limit reached/i,
]

/** 低信心度 heuristic：見檔頭「2026-09-04 研究補充」，不是官方保證的訊號。 */
function looksLikeSessionLimitExhausted(text: string): boolean {
  return SESSION_LIMIT_PATTERNS.some(re => re.test(text))
}

type ResultEvent = { subtype?: unknown; is_error?: unknown; result?: unknown }

// --output-format json 印出的是一個 event 陣列（system/init、assistant
// message、…），type=result 的那筆才有 subtype/is_error/result（兩次實跑
// 含一次夾帶工具呼叫都確認它穩定在陣列最後一位，但用 find 定位比依賴位置
// 更穩固，成本一樣低）。stdout 保證是單一乾淨的 JSON（見上方檔頭說明），
// 直接 JSON.parse 即可，不需要（也不該用）正則去猜 JSON 邊界——曾經用
// 「貪婪抓第一個 [ 到最後一個 ]」的 fallback 因為 stdout/stderr 共用同一
// log 檔，只要 stderr 有任何輸出夾雜在中間就會誤判，已經改成 T11 把
// stdout/stderr 分開寫成兩個檔案從根本解掉，這裡不再需要 fallback。
function extractResultEvent(stdoutContent: string): ResultEvent | null {
  let events: unknown
  try {
    events = JSON.parse(stdoutContent)
  } catch {
    // 2026-08-26 起 WRAPPER_SCRIPT 改用 --output-format stream-json：stdout 是
    // JSONL（每行一個 event 物件，最後一行 type=result），整檔 JSON.parse 必
    // 失敗——改逐行解析，容忍被 timeout 砍斷時最後一行不完整（單行 parse
    // 失敗就跳過該行，不是整檔放棄）。上面的整檔 parse 保留給歷史 log
    // （舊格式單一 JSON 陣列）繼續可分類。空字串/整段非 JSON → 空陣列 →
    // 下面 find 不到 result event → 照舊回 null（cli_failure 路徑不變）。
    const lineEvents: unknown[] = []
    for (const line of stdoutContent.split('\n')) {
      if (!line.trim()) continue
      try {
        lineEvents.push(JSON.parse(line))
      } catch {}
    }
    if (!lineEvents.length) return null
    events = lineEvents
  }

  if (!Array.isArray(events)) return null
  const resultEvent = events.find(e => e && typeof e === 'object' && (e as Record<string, unknown>).type === 'result')
  return (resultEvent as ResultEvent | undefined) ?? null
}

export function classifyPipelineResult(exitCode: number, stdoutContent: string): Classification {
  if (exitCode === 124) return 'timeout' // GNU timeout 逾時把 claude -p 中途砍掉，stdout 通常是空的（來不及 flush）
  if (exitCode !== 0) {
    // 見檔頭研究補充：官方文件證實非 0 exit code 的失敗（含額度用盡）一律
    // stderr 空、失敗文字印在 stdout——這裡在歸類 infra_failure 前先比對
    // 已知特徵字串。
    if (looksLikeSessionLimitExhausted(stdoutContent)) return 'session_limit'
    return 'infra_failure'
  }

  const resultEvent = extractResultEvent(stdoutContent)
  if (!resultEvent) {
    if (looksLikeSessionLimitExhausted(stdoutContent)) return 'session_limit'
    return 'cli_failure' // 拿不到合法的 JSON 結果，視為 CLI 層級失敗
  }

  // is_error 依 Claude Code CLI 契約應恆為 boolean；subtype 只有 'success'
  // 或幾個固定的 error_* 字串（無第三態）。這裡用嚴格比對（不做寬鬆型別
  // 轉換），CLI 契約若改變導致這兩個欄位型別跑掉，寧可落到下面的字串比對
  // 階段（結果頂多是 unknown_failure），也不要用寬鬆轉換製造新的誤判。
  if (resultEvent.is_error === true || (resultEvent.subtype !== undefined && resultEvent.subtype !== 'success')) {
    // 見檔頭研究補充：官方文件說「額度用盡」這類 in-run 失敗是印在 stdout
    // 的 result 欄位裡（不是獨立 exit code/欄位），所以在歸類 cli_failure
    // 前先比對這裡的 result 文字（拿不到字串就退回比對整段 stdoutContent，
    // 涵蓋 result 欄位不是字串或訊息落在其他 event 的極端情況）。
    const failureText = typeof resultEvent.result === 'string' ? resultEvent.result : stdoutContent
    if (looksLikeSessionLimitExhausted(failureText)) return 'session_limit'
    return 'cli_failure'
  }

  const result = typeof resultEvent.result === 'string' ? resultEvent.result : ''

  // create-mr.md Step 9 完成報告模板固定有一行「- Pipeline status: {值}」，
  // 用錨定 regex（行首 + 冒號後第一個非空白 token）直接抓這個值，不用五次
  // 依序 .includes() 子字串比對——後者兩個獨立 review 都證實會被 Step 9
  // 模板裡另一行「chat_id 同步: {tg_chatid_sync_result}」（best-effort
  // 中繼變數，沒新資料時字面就是 "SKIPPED"，跟真正的早退 SKIPPED 是兩件事）
  // 誤判成 skipped；錨定抓值從根本避開這整類「子字串剛好出現在別的地方」
  // 的風險，不只是調順序。
  //
  // 必須容忍 markdown 裝飾（FAQ-4616 2026-08-16 真實誤判案例）：模板寫的是
  // 純文字，但 manager（LLM）實際吐出的是「- **Pipeline status**:
  // `already_fixed`」——標籤被加粗、值被包反引號，嚴格比對直接漏接、成功
  // 被誤判成 unknown_failure 補發了假警報。regex 對 `**` 與 backtick 做
  // 選配容忍（星號在冒號前後都可能出現，如「status:**」的寫法），值本身
  // 收斂到 \w（i18n_manual_handoff 含數字，不能用純字母類），行首錨定不變。
  const statusMatch = /^-\s*\*{0,2}Pipeline status\*{0,2}\s*:\s*\*{0,2}\s*`?(\w+)/m.exec(result)
  if (statusMatch) {
    const status = statusMatch[1]
    if (status === 'success' || status === 'already_fixed' || status === 'i18n_manual_handoff') return 'success'
    if (status === 'needs_qa_clarification') return 'needs_qa_clarification'
    if (status === 'analysis_done') return 'analysis_done'
    if (status === 'failed') return 'failed'
    return 'unknown_failure' // 抓到這一行但值不是已知的五種，視為未知
  }

  // 沒有 Pipeline status 那一行——create-mr.md 保證這只會發生在真正的早退
  // 分支（Step 0.1/0.5 這幾種「輸出 SKIPPED: ... 後結束」，不會跑到印報告
  // 的 Step 9），.result 就是那一整行文字本身，用 startsWith 錨定，不用裸
  // includes（避免任何情境下巧合含有 "SKIPPED" 子字串卻不是早退訊息）。
  if (result.trim().startsWith('SKIPPED:')) return 'skipped'

  return 'unknown_failure'
}

/**
 * 從完成報告抓「- Failure reason: {值}」那一行（create-mr.md Step 9 模板，
 * 2026-09-09 新增，使用者核准：tracker.md 退役後，原本 tracker.sh log-fail
 * 寫進本機 pipeline-failures.md 的失敗原因改保留進監控 DB 的 runs.failure_reason）。
 * 跟 pipeline_status 用同一份 result 文字、同一套 markdown 裝飾容忍規則
 * （粗體或反引號包住的值），行首錨定；沒有這一行、或值是模板保留字 `N/A`
 * （非 failed 出口）都回 null，不硬填假值。post-run-notify.ts 的
 * writeAuthoritativeOutcome() 呼叫本函式取得 failureReason 傳給 W2 寫入。
 */
export function extractFailureReason(stdoutContent: string): string | null {
  const resultEvent = extractResultEvent(stdoutContent)
  const result = typeof resultEvent?.result === 'string' ? resultEvent.result : stdoutContent
  const match = /^-\s*\*{0,2}Failure reason\*{0,2}\s*:\s*(.+)$/m.exec(result)
  if (!match) return null
  // 值本身是自由文字（不像 pipeline_status 只有 \w token 好界定），這裡只
  // 剝除「整個值」外層包一層的 markdown 裝飾（**粗體**／`反引號`），不動
  // 值內部可能出現的星號/反引號。
  const value = match[1]!.trim().replace(/^\*{1,2}(.*)\*{1,2}$/, '$1').replace(/^`(.*)`$/, '$1').trim()
  if (!value || value === 'N/A') return null
  // runs.failure_reason 是 VARCHAR(500)（migration 006）：截斷但保留可讀性，
  // 不讓過長訊息讓寫入失敗。
  return value.length > 500 ? `${value.slice(0, 497)}...` : value
}
