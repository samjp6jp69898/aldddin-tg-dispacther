/**
 * T36（2026-08-18 redesign，見 tasks.json T36 changelog）：需求 pipeline 每
 * 一種終止分支的收尾邏輯——分類該用哪個 Notion「AI分析」值、留言文字、
 * Telegram 通知文字怎麼寫。純邏輯抽出來獨立於 run-demand-pipeline.ts（那邊
 * 負責真的呼叫 notion.sh／gdrive.sh／tg-notify.sh），方便不打真實 API 測試。
 *
 * 背景：原設計（T35 prompt）讓 implementer agent 直接改 code、留在 working
 * tree，收尾只發一則 Telegram、不寫 Notion。真實跑過 ALDREQ-746 後使用者
 * 定案改成：這個 pipeline 只產出一份 plan.md（見
 * demand-implementer-prompt.ts），上傳 Google Drive，並且**不管哪一種結果
 * 分支**都要在 Notion 留言＋更新 AI分析（比照 aladdin 既有 Bug pipeline
 * drive-uploader 的既有慣例：無論 pipeline_status 為何都必須更新狀態欄
 * 位）。AI分析 的四個目標值（分析成功／不需分析／分析失敗／待釐清）皆已
 * 用 notion.sh 對總需求池資料庫 schema 實測確認存在，不是憑空造的字串。
 *
 * 2026-08-21 使用者定案移除 kind:'cross-repo'：原本跨 ≥2 個 repo 的需求單
 * 會被 repo-scope-gate 直接攔下、標成這個結果分支（待釐清＋不發 Telegram，
 * 見 git 歷史）。實測發現這個關卡太保守——連「明確知道要動哪三個 repo」的
 * 小需求都會被擋，改成跨 repo 需求一樣走 kind:'plan' 那條路（見
 * run-demand-pipeline.ts／demand-plan-pipeline.ts 2026-08-21 的變更）。
 */

export type DemandOutcome =
  | { kind: 'insufficient-spec'; missing: string }
  | { kind: 'setup-failed'; reason: string }
  | { kind: 'implementer-error'; detail: string }
  | { kind: 'unexpected-error'; detail: string }
  | { kind: 'plan'; status: 'success' | 'already-satisfied' | 'needs-clarification'; planPath: string; summary: string }

export type DemandAiAnalysisValue = '分析成功' | '不需分析' | '分析失敗' | '待釐清'

/**
 * 監控 DB 化（plan-db-as-truth-v3.md §6.1 R3'／§9 Phase 2「demand 結構化
 * outcome」列）：demand pipeline 的結構化終態值域，供 `runs.outcome` 欄使用。
 * 這是目前唯一的定案來源——plan 本身承認「demand pipeline 的結構化 outcome
 * 字串尚未在任何 Phase 2 程式碼定案」（見 lib/monitor-db/types.ts
 * KNOWN_OUTCOME_TIER 註解），這裡把它定下來。全部七個值在 §6.1 R3' 的分級表
 * 裡都歸在「2 權威終態」（demand 結構化值），一律經 W2（tier 2）寫入
 * ——這正是本次改動相對現況（舊軌只有截斷 80 字的 log 字串）的核心改善：
 * `runs.outcome` 從此能精確反映 DemandOutcome 的 kind/status，而不是一段
 * 自由文字。命名比照既有值域的 snake_case 慣例（如 `already_fixed`、
 * `needs_qa_clarification`）。
 */
export function demandOutcomeToRunsOutcome(outcome: DemandOutcome): string {
  switch (outcome.kind) {
    case 'plan':
      if (outcome.status === 'success') return 'success'
      if (outcome.status === 'already-satisfied') return 'already_satisfied'
      return 'needs_clarification'
    case 'insufficient-spec':
      return 'insufficient_spec'
    case 'setup-failed':
      return 'setup_failed'
    case 'implementer-error':
      return 'implementer_error'
    case 'unexpected-error':
      return 'unexpected_error'
  }
}

/**
 * 這次結果要不要真的上傳 plan.md 到 Drive——只有 implementer 真的跑完、
 * 產出一份可讀 plan.md 的三種 kind:'plan' 分支才有文件可傳；其餘分支（規格
 * 不足／技術性失敗）根本沒有 plan.md 存在，不嘗試上傳。
 */
export function shouldUploadPlan(outcome: DemandOutcome): outcome is Extract<DemandOutcome, { kind: 'plan' }> {
  return outcome.kind === 'plan'
}

/**
 * 分類這次結果對應的 Notion AI分析 值（比照使用者 2026-08-18 定案）：
 * - plan.success            → 分析成功（產出可行動的變更建議）
 * - plan.already-satisfied  → 不需分析（調查後發現已被現有程式碼滿足）
 * - plan.needs-clarification / insufficient-spec → 待釐清
 *   （這兩種本質上都是「AI 沒辦法自己判定，需要人」，歸同一類）
 * - setup-failed / implementer-error / unexpected-error → 分析失敗
 *   （pipeline 本身的技術性失敗，跟需求內容無關）
 */
export function classifyAiAnalysis(outcome: DemandOutcome): DemandAiAnalysisValue {
  switch (outcome.kind) {
    case 'plan':
      if (outcome.status === 'success') return '分析成功'
      if (outcome.status === 'already-satisfied') return '不需分析'
      return '待釐清'
    case 'insufficient-spec':
      return '待釐清'
    case 'setup-failed':
    case 'implementer-error':
    case 'unexpected-error':
      return '分析失敗'
  }
}

/**
 * Notion 留言純文字（不含連結——連結由呼叫端用 notion.sh comment-text 的
 * link 參數另外帶）。
 *
 * 2026-09-16 使用者定案：三種技術性失敗（setup-failed / implementer-error /
 * unexpected-error）的 reason / detail 是 head/worker 本機的執行錯誤（含本機
 * 路徑、指令行），**不得**貼進 Notion——同事看到也無從處理，只會洩漏本機
 * 環境細節。Notion 只留「內部錯誤、本次結果無效、排除後會重跑」一句話；
 * 完整錯誤照舊由 buildTelegramText 帶給維運者本人。
 */
export function buildNotionCommentText(ticket: string, outcome: DemandOutcome): string {
  switch (outcome.kind) {
    case 'plan':
      if (outcome.status === 'success') return `${ticket} AI 需求分析完成，已產出可行動的實作計畫（plan.md），連結如下，請人工複核後照著改。`
      if (outcome.status === 'already-satisfied') return `${ticket} AI 調查後判定：這個需求已經被現有程式碼滿足，不需要再改。詳細調查過程見 plan.md 連結。`
      return `${ticket} AI 調查過程中發現規格或範圍有無法自行判定的落差，需要人工釐清。詳細內容見 plan.md 連結。`
    case 'insufficient-spec':
      return `${ticket} AI 判定規格不足，無法自動分析：${outcome.missing}\n\n請在 Notion 補充規格後重新認領。`
    case 'setup-failed':
    case 'implementer-error':
    case 'unexpected-error':
      return `${ticket} AI 分析因執行環境內部錯誤中止，本次結果無效；詳細錯誤已另行通知維運人員，排除後會重新分析，這張單不需要因此做任何處理。`
  }
}

/**
 * Telegram 通知文字。kind:'plan' 的三種結果都已經有 Notion 留言＋Drive
 * 連結承載完整內容（使用者 2026-08-18 定案：訊息不要再貼一大段分析文字進
 * Telegram），這裡故意維持極簡——只給結論、Drive 連結、Notion 連結。其餘
 * 技術性/需人工分支沒有 plan.md 可連，維持原本「把關鍵資訊直接講清楚」的
 * 做法。
 */
export function buildTelegramText(ticket: string, outcome: DemandOutcome, links: { driveLink?: string; notionUrl?: string }): string {
  if (outcome.kind === 'plan') {
    const parts = [`${ticket} 已完成`]
    if (links.driveLink) parts.push(`實作報告：${links.driveLink}`)
    if (links.notionUrl) parts.push(`Notion：${links.notionUrl}`)
    return parts.join('\n')
  }

  switch (outcome.kind) {
    case 'insufficient-spec':
      return `${ticket} 規格不足，無法自動分析：\n${outcome.missing}\n\n請在 Notion 補充規格後重新認領。`
    case 'setup-failed':
      return `${ticket} 環境建置失敗，無法自動分析：${outcome.reason}\n請聯絡維運人員或自行處理。`
    case 'implementer-error':
      return `${ticket} 分析執行異常：${outcome.detail}`
    case 'unexpected-error':
      return `⚠️ ${ticket} 需求 pipeline 執行時發生未預期錯誤，請人工檢查：${outcome.detail}`
  }
}
