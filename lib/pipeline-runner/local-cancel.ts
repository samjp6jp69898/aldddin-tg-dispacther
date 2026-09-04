// lib/pipeline-runner/local-cancel.ts — worker 端取消本機正在跑的 pipeline
// （2026-09-04 新增，worker-agent.ts 的 POST /jobs/:ticket/cancel 用）。
//
// 殺行程演算法逐步驟比照 tg-monitor/lib/ingest.ts 的 cancelPipeline()：
//   ps 快照找出 wrapper pid → 由 ppid 展開子孫（BFS）→ 反轉成最深先殺
//   → 先對子孫送 SIGTERM，讓 wrapper bash 自然 wait 到子行程的 143、在
//     EXIT trap 裡拿到非 0 的 $? 而發出 TG 通知（同時對 wrapper 送 TERM
//     會讓 trap 看到 $?=0，通知不會發，這是 tg-monitor 那份的既有踩坑）
//   → 1.5 秒後 wrapper 仍活著才補 SIGTERM
//   → 5 秒後殘留（wrapper 或任何子孫）補 SIGKILL。
// wrapper 的 EXIT trap（spawn-create-mr.ts WRAPPER_SCRIPT）之後照常觸發：
// 釋放 bug-lock、cleanup-worktree（保留 mr/{ticket} 分支）、post-run-notify
// 發 TG 通知——這段收尾已經存在，本檔不重寫。
//
// tg-monitor 是純 head 本機工具、不會部署到 worker，worker 不能 import 它
// （見 lib/monitor-db/cancel-resolve.ts 檔頭「跨 repo 用複製對齊邏輯，不是
// 技術債」）：本檔的 ps 掃描/kill 邏輯是重新實作（見 local-proc-scan.ts），
// 但「ticket → run_id」的五段解析與 W4 旗標寫入直接複用同 repo 的
// cancel-resolve.ts / writes.ts，不重寫。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMonitorDbEnabled, MON_HOST } from '../monitor-db/env.ts'
import { getLongLivedMonitorPool, getLongLivedMonitorSpoolWriter } from '../monitor-db/runtime.ts'
import { resolveRunId, resolveR2, type MarkerSnapshot } from '../monitor-db/cancel-resolve.ts'
import { writeCancelFlag } from '../monitor-db/writes.ts'
import type { CancelResolvedBy, RunKind } from '../monitor-db/types.ts'
import { readActiveMarkerSnapshot } from './active-pipeline-marker.ts'
import { expandDescendants, scanRunningPipelineProcsNow } from './local-proc-scan.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const CANCEL_FLAG_BUDGET_MS = 1000

export interface CancelLocalPipelineResult {
  ok: boolean
  killed: number[]
  wrapperPid?: number
  reason?: string
  /** 以下三個欄位只在 isMonitorDbEnabled() 為 true 時才會出現（比照
   * tg-monitor cancelPipeline 的 CancelPipelineResult 形狀）。 */
  runId?: string
  runIdResolvedBy?: string
  flagWritten?: boolean
}

// bug 的 stdout log 檔名樣式（spawn-create-mr.ts 的 `${base}.stdout.log`
// 命名慣例），與 tg-monitor/lib/ingest.ts 的 BUG_RE 同源。
const BUG_STDOUT_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.stdout\.log$/

function fileTsToIso(t: string): string {
  // 2026-08-21T01-23-16-901Z → 2026-08-21T01:23:16.901Z
  return t.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
}

/** 由 wrapper 的 stdout log 絕對路徑反推 legacy_key；反推失敗回 null。 */
function deriveLegacyKey(stdoutPath: string): string | null {
  const base = stdoutPath.split('/').pop() ?? ''
  if (!BUG_STDOUT_RE.test(base)) return null
  return base.replace(/\.stdout\.log$/, '')
}

function readTriggeredByRecord(key: string, logDir: string): { name: string | null; email: string | null } | null {
  try {
    const raw = readFileSync(join(logDir, `${key}.triggered-by.json`), 'utf8')
    const parsed = JSON.parse(raw) as { name?: string; email?: string }
    return { name: parsed.name ?? null, email: parsed.email ?? null }
  } catch {
    return null
  }
}

/**
 * W4b 六欄推導（stdout_path/stderr_path/started_at/trigger_source/
 * triggered_by_email/triggered_by_name），純函式，逐邏輯比照
 * tg-monitor/lib/ingest.ts 的 deriveCancelFlagFields。extra 只有
 * kind==='bug' 時才是 stdout log 絕對路徑（demand 的 extra 是
 * assigneeEmail，deriveLegacyKey 對這個輸入本來就回 null）。
 */
export function deriveCancelFlagFields(
  kind: RunKind,
  extra: string,
  legacyKey: string | null,
  logDir: string = LOG_DIR,
): {
  stdoutPath: string | null
  stderrPath: string | null
  startedAt: string | null
  triggerSource: 'telegram' | 'cli'
  triggeredByEmail: string | null
  triggeredByName: string | null
} {
  const stdoutPath = kind === 'bug' && legacyKey ? extra : null
  const stderrPath = stdoutPath ? stdoutPath.replace(/\.stdout\.log$/, '.stderr.log') : null
  let startedAt: string | null = null
  if (stdoutPath) {
    const m = BUG_STDOUT_RE.exec(stdoutPath.split('/').pop() ?? '')
    if (m) startedAt = fileTsToIso(m[2]!)
  }
  const triggeredByRecord = legacyKey ? readTriggeredByRecord(legacyKey, logDir) : null
  return {
    stdoutPath,
    stderrPath,
    startedAt,
    triggerSource: triggeredByRecord ? 'telegram' : 'cli',
    triggeredByEmail: triggeredByRecord?.email ?? null,
    triggeredByName: triggeredByRecord?.name ?? null,
  }
}

/**
 * 監控 DB 逾時/不可達時的本機退路：只用本機 marker（無 DB），永遠有結果。
 * 邏輯與 tg-monitor/lib/mon-db.ts 的 resolveRunIdLocalOnly 相同，這裡直接
 * 呼叫同 repo 的 cancel-resolve.ts 匯出的 resolveR2（不重寫五段解析裡的
 * marker 判斷）。
 */
export function resolveRunIdLocalOnly(kind: RunKind, marker: MarkerSnapshot): { runId: string; resolvedBy: CancelResolvedBy } {
  const r2 = resolveR2({ kind, ticket: '', target: { pid: 0, pidSet: [] }, legacyKey: null, stdoutPath: null, marker })
  if (r2 && !r2.mismatch) return { runId: r2.runId, resolvedBy: 'marker' }
  if (r2?.mismatch) {
    console.warn(
      `cancel_marker_mismatch: kind=${kind} markerRunId=${r2.runId} markerKind=${marker.kind}` +
        `（worker 本機逾時/DB 不可達退路下的自我驗證失敗，改鑄 placeholder）`,
    )
  }
  const placeholder = crypto.randomUUID()
  console.warn(`cancel_runid_placeholder: kind=${kind} runId=${placeholder}（worker 本機逾時/DB 不可達退路，本機也無可用 marker）`)
  return { runId: placeholder, resolvedBy: 'placeholder' }
}

/**
 * 取消本機一條背景 pipeline。演算法見檔頭。isMonitorDbEnabled()=false 時，
 * 步驟 2–3（run_id 解析＋旗標寫入）整段跳過，只做 ps 掃描與 kill——與
 * tg-monitor cancelPipeline 的降級語意一致。
 */
export async function cancelLocalPipeline(kind: RunKind, ticket: string): Promise<CancelLocalPipelineResult> {
  const { procs, ppidMap } = scanRunningPipelineProcsNow()
  const target = procs.find(p => p.kind === kind && p.ticket === ticket)
  if (!target) return { ok: false, killed: [], reason: 'not running（可能剛結束，或 ps 快照尚未更新，3 秒後再試）' }

  // 由 ppid 快照展開子孫（BFS，含自己），最深先殺。
  const order = expandDescendants(target.pid, ppidMap)

  let dbFields: { runId: string; runIdResolvedBy: string; flagWritten: boolean } | undefined

  if (isMonitorDbEnabled()) {
    const marker = readActiveMarkerSnapshot(ticket)
    const legacyKey = kind === 'bug' ? deriveLegacyKey(target.extra) : null
    const cancelRequestedAt = new Date().toISOString()
    const { stdoutPath, stderrPath, startedAt, triggerSource, triggeredByEmail, triggeredByName } = deriveCancelFlagFields(
      kind,
      target.extra,
      legacyKey,
    )

    // 單一 1000ms 預算涵蓋「解析 run_id ＋ 寫旗標」整段（比照 tg-monitor
    // cancelPipeline：mysql2 對已建立但對端卡死的連線沒有 per-query 逾時，
    // 必須整段用 Promise.race 包住）。
    const attempt = (async () => {
      const pool = await getLongLivedMonitorPool()
      if (!pool) throw new Error('monitor pool 不可用')
      const resolved = await resolveRunId(pool, {
        kind,
        ticket,
        target: { pid: target.pid, pidSet: order },
        legacyKey,
        stdoutPath: kind === 'bug' ? target.extra : null,
        marker,
      })
      const write = await writeCancelFlag(pool, {
        runId: resolved.runId,
        ticket,
        kind,
        cancelRequestedAt,
        resolvedBy: resolved.resolvedBy,
        legacyKey,
        stdoutPath,
        stderrPath,
        startedAt,
        triggerSource,
        triggeredByEmail,
        triggeredByName,
      })
      return { runId: resolved.runId, resolvedBy: resolved.resolvedBy, ok: write.kind !== 'guarded' }
    })()
    const budget = new Promise<null>(resolve => setTimeout(() => resolve(null), CANCEL_FLAG_BUDGET_MS))
    // attempt 若晚於 budget 完成，讓它繼續在背景跑完（mysql2 沒有內建 query
    // cancel）；race 只決定這次回應要不要等它。
    const raced = await Promise.race([attempt.catch(() => null), budget])

    if (raced && raced.ok) {
      dbFields = { runId: raced.runId, runIdResolvedBy: raced.resolvedBy, flagWritten: true }
    } else {
      const local = resolveRunIdLocalOnly(kind, marker)
      try {
        getLongLivedMonitorSpoolWriter().append({
          ts: cancelRequestedAt,
          host: MON_HOST,
          run_id: local.runId,
          fn: 'writeCancelFlag',
          args: [{ runId: local.runId, ticket, kind, cancelRequestedAt, resolvedBy: local.resolvedBy, legacyKey }],
        })
      } catch (err) {
        console.error(`cancelLocalPipeline: 落 spool 失敗（${ticket}）：${err}`)
      }
      console.warn(`cancel_flag_deferred: ticket=${ticket} kind=${kind} runId=${local.runId}（旗標整段逾時/失敗，已落 spool）`)
      dbFields = { runId: local.runId, runIdResolvedBy: local.resolvedBy, flagWritten: false }
    }
  }

  // 既有 kill 流程，不論上面的結果如何，只要拿到 target 就一定執行——先只殺
  // 子孫（最深的先），1.5 秒後 wrapper 還活著才補 TERM，5 秒後殘留補 KILL。
  const killed: number[] = []
  const descendants = order.slice(1).reverse()
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(target.pid, 0)
      process.kill(target.pid, 'SIGTERM')
    } catch {}
  }, 1500)
  setTimeout(() => {
    for (const pid of order) {
      try {
        process.kill(pid, 0) // 還活著才會成功
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }, 5000)

  return { ok: true, killed, wrapperPid: target.pid, ...dbFields }
}
