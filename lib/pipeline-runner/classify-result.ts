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
//      needs_qa_clarification / failed；抓不到這行時才看是不是真正的早退
//      SKIPPED（見下方判斷順序註解）；都不是 → unknown_failure
//
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
  | 'failed'
  // dispatcher 自己合成的分類，create-mr 完全沒機會回報這幾種——代表 CLI
  // 這層本身就有問題（跑不完、跑完但沒吐出可辨識的合法結果）。
  | 'timeout' // exitCode === 124：GNU timeout 把 claude -p 中途砍掉
  | 'infra_failure'
  | 'cli_failure'
  | 'unknown_failure'

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
  if (exitCode !== 0) return 'infra_failure'

  const resultEvent = extractResultEvent(stdoutContent)
  if (!resultEvent) return 'cli_failure' // 拿不到合法的 JSON 結果，視為 CLI 層級失敗

  // is_error 依 Claude Code CLI 契約應恆為 boolean；subtype 只有 'success'
  // 或幾個固定的 error_* 字串（無第三態）。這裡用嚴格比對（不做寬鬆型別
  // 轉換），CLI 契約若改變導致這兩個欄位型別跑掉，寧可落到下面的字串比對
  // 階段（結果頂多是 unknown_failure），也不要用寬鬆轉換製造新的誤判。
  if (resultEvent.is_error === true || (resultEvent.subtype !== undefined && resultEvent.subtype !== 'success')) {
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
