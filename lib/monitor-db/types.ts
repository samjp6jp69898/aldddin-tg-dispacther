// lib/monitor-db/types.ts — 監控 DB 寫入層共用型別。
//
// 來源：plan-db-as-truth-v3.md §6.1（Invariant）／§6.3（影響列數三態與計數器）；
// plan-db-as-truth-v3.2.md 裁定 2（outcome_tier 定案）／MJ-E1（W1 host 守衛的冷路徑分類）。

/** `runs.kind`：目前只有 bug pipeline 與 demand pipeline 兩種。 */
export type RunKind = 'bug' | 'demand'

/** `runs.lifecycle_rank`：只能單調前進（R2）。10 queued / 30 running / 100 finished。 */
export const LIFECYCLE_RANK = { queued: 10, running: 30, finished: 100 } as const
export type LifecycleRank = (typeof LIFECYCLE_RANK)[keyof typeof LIFECYCLE_RANK]

/**
 * 終態兩級（R3'）：
 *   tier 1 ＝暫定終態（本機 sweeper / reaper / 重啟 sweep 寫，可被權威值覆寫）
 *   tier 2 ＝權威終態（EXIT trap / finalize / spawn 失敗 / queue 出口 / 回填寫，互不覆寫）
 * `outcome_tier` 由「呼叫哪一支具名寫入函式」決定，不是 outcome 值的函式
 * （§6.1 已論證：由 outcome 值推導 tier 在回填資料上會算錯）——因此這裡刻意
 * *不* 提供「由字串反推 tier」的函式；W2/W3 的 tier 在呼叫端就已經固定。
 */
export type OutcomeTier = 1 | 2

/**
 * 命名約定（§6.1）：`unknown_*` / `lost_*` 前綴一律 tier 1。
 * 下表只收「本輪讀過計畫文字或原始碼、確有依據」的值，供 Phase 1 的一致性
 * 測試核對命名約定；不是 outcome 值域的權威清單（demand pipeline 的結構化
 * outcome 字串尚未在任何 Phase 2 程式碼定案，此處不臆測）。
 */
export const KNOWN_OUTCOME_TIER: Readonly<Record<string, OutcomeTier>> = Object.freeze({
  // tier 1（暫定終態，§6.1 R3' 原表）
  unknown_no_writer: 1,
  unknown_reaped: 1,
  lost_on_restart: 1,
  unknown_dispatch_lost: 1,
  // tier 1（§11.2 回填：'empty' → unknown_failure，明文標為 tier 1「本來就是不知道」）
  unknown_failure: 1,
  // tier 2（權威終態，§6.1 R3' 原表 ＋ classify-result.ts 的 Classification 值域）
  success: 2,
  failed: 2,
  timeout: 2,
  needs_qa_clarification: 2,
  // 2026-09-08 新增，pipeline-modes Phase 2「只做問題分析」模式的暫停出口，
  // create-mr 自己會在 7c 發 TG，不是失敗（見
  // pipeline-modes-project-docs/plan-pipeline-modes-v1.md §2.4）。
  analysis_done: 2,
  already_fixed: 2,
  i18n: 2,
  cancelled: 2,
  infra_failure: 2,
  cli_failure: 2,
  spawn_error: 2,
  skipped: 2,
  skipped_locked: 2,
  skipped_expired: 2,
  dispatched_to_worker: 2,
  recovered: 2,
  // tier 2（§11.2 回填：對映不到已知值域者）
  legacy_unmapped: 2,
  // tier 2（demand pipeline 結構化 outcome，見 demand-finalize.ts
  // demandOutcomeToRunsOutcome：全部七個值於 §6.1 R3' 分級表歸在「2 權威終態」；
  // `success` 與 bug pipeline 共用同一個值，已在上面定義，這裡不重複）
  already_satisfied: 2,
  needs_clarification: 2,
  insufficient_spec: 2,
  setup_failed: 2,
  implementer_error: 2,
  unexpected_error: 2,
})

/** 三態影響列數判定（§6.3）。 */
export type WriteApplyKind = 'inserted' | 'applied' | 'guarded'

/**
 * 冷路徑診斷 SELECT 的分類結果（§6.3 四個計數器 ＋ MJ-E1 的 W1 兩條擴充）。
 * `r1_violation` 必須恆為 0，非零即 ERROR + TG 告警（不在本模組職責內，本模組
 * 只負責產出正確的分類結果）。
 */
export type GuardedReason = 'r1_violation' | 'guarded_rank' | 'guarded_terminal' | 'guarded_other'

export interface WriteOutcome {
  kind: WriteApplyKind
  /** 只有 kind === 'guarded' 時才有值。 */
  guardedReason?: GuardedReason
  /**
   * kind === 'applied' 且這次寫入把一個 tier 1 暫定終態覆寫成 tier 2 權威終態時為 true
   * （`provisional_superseded`，§6.1 BL-C1 修法生效的觀察指標，非零屬正常）。
   * 這個欄位只供計數/觀察，不影響任何寫入路徑的判斷（正確性完全由 SQL 的
   * WHERE 守衛保證）。
   */
  supersededProvisional?: boolean
}

/**
 * `ticket_stages.stage` 值域（migration 005，pipeline-modes Phase 3）。
 * 前七個對應 `lib/pipeline-runner/local-stage-files.ts` 的產物檔（review 由三份
 * reviewer 報告合併成一個 stage），`worktree`/`fixer` 由 `mr/<ticket>` 分支上的
 * commit 數判定，`exit` 由呼叫端傳入的 run outcome 決定。
 */
export const TICKET_STAGES = [
  'analytics',
  'spec',
  'grounding',
  'analysis-notes',
  'worktree',
  'fixer',
  'review',
  'final-review',
  'solution',
  'exit',
] as const
export type TicketStage = (typeof TICKET_STAGES)[number]

/**
 * `ticket_stages.status` 值域。刻意**沒有** `pending`/`missing`：沒有證據的
 * stage 一律不寫列（「查無此列」就是「沒做到」），只有真的到達終點的 stage 才
 * 進表。`skipped` 保留給「這個模式結構上不會做這一步」（例如 analysis 模式的
 * worktree/fixer/review/final-review），與「跑到一半死掉所以沒有」區分得開。
 */
export type TicketStageStatus = 'done' | 'failed' | 'skipped'

/** `runs.cancel_resolved_by` 值域（【G:MJ-G3】新增的稽核欄）。 */
export type CancelResolvedBy = 'pid_match' | 'marker' | 'legacy_key' | 'latest_running' | 'placeholder'

/**
 * `monitor_heartbeat.writer` 值域（plan-db-as-truth-v3.2.md 裁定 1 §11.1 修訂，
 * migration 002 套用）：head 上有 server/tg-monitor/log-intake 三個監控寫入行程
 * 共用一列時，「head 自己 DB 不可寫」的告警永遠不會觸發——PK 改
 * `(host, writer)` 讓每個行程各自一列，這裡列出目前計畫已知的四個行程身分。
 */
export type MonitorHeartbeatWriter = 'server' | 'worker-agent' | 'tg-monitor' | 'log-intake'
