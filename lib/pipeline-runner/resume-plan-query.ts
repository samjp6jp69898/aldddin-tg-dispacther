// lib/pipeline-runner/resume-plan-query.ts — `scripts/resume-plan.sh` 的 DB 讀取端。
//
// 短命 CLI：`bun lib/pipeline-runner/resume-plan-query.ts <ticket>` 印一行 JSON，
// 讓 bash 端（aladdin_ai/scripts/resume-plan.sh）不必自己碰 mysql。輸出形狀：
//   {"available":true,"stages":[{stage,status,host,run_id,mode,finished_at}...],
//    "artifact_sync":{source_host,head_synced_at,last_attempt_at,file_count}|null}
//   {"available":false}                        ← DB 關閉、連不上、查詢失敗、參數不合法
//
// 硬規則：**任何**失敗都是 `{"available":false}` + exit 0，絕不非零退出、絕不
// 印例外堆疊到 stdout——呼叫端據此退回純檔案系統判定（plan-pipeline-modes-v1
// §3：「讀取屬決策用，DB 不可達 → 退回 resume-inventory.sh，行為與今日相同」）。
//
// pool 生命週期比照 post-run-notify.ts 的短命行程紀律：自建 connectionLimit=1
// 的 pool，用完在 finally 裡 `end()`——keep-alive 連線會讓 bun 永不退出，而本
// 行程是被 bash 用命令替換抓輸出的，掛住就等於 /create-mr Step 0.2 卡死。
import { isMonitorDbEnabled } from '../monitor-db/env.ts'
import { monitorRoleForThisHost } from '../monitor-db/runtime.ts'

const TICKET_RE = /^(FAQ|ALDREQ)-\d+$/

export interface ResumePlanStageRow {
  stage: string
  status: string
  host: string
  run_id: string | null
  mode: string | null
  finished_at: string | null
}

export interface ResumePlanArtifactSync {
  source_host: string
  head_synced_at: string | null
  last_attempt_at: string | null
  file_count: number | null
}

export interface ResumePlanQueryResult {
  available: boolean
  stages?: ResumePlanStageRow[]
  artifact_sync?: ResumePlanArtifactSync | null
}

export const STAGES_SQL =
  'SELECT stage, status, host, run_id, mode, finished_at FROM ticket_stages WHERE ticket = ? ORDER BY stage'
export const ARTIFACT_SYNC_SQL =
  'SELECT source_host, head_synced_at, last_attempt_at, file_count FROM ticket_artifact_sync WHERE ticket = ?'

interface QueryExecutor {
  execute<T>(sql: string, params?: unknown[]): Promise<[T, unknown]>
}

/** 純查詢部分（注入 executor，供單元測試用假 client）。 */
export async function queryResumePlan(pool: QueryExecutor, ticket: string): Promise<ResumePlanQueryResult> {
  const [stageRows] = await pool.execute<ResumePlanStageRow[]>(STAGES_SQL, [ticket])
  const [syncRows] = await pool.execute<ResumePlanArtifactSync[]>(ARTIFACT_SYNC_SQL, [ticket])
  return {
    available: true,
    stages: (stageRows ?? []).map(r => ({
      stage: String(r.stage),
      status: String(r.status),
      host: String(r.host),
      run_id: r.run_id ?? null,
      mode: r.mode ?? null,
      finished_at: r.finished_at == null ? null : String(r.finished_at),
    })),
    artifact_sync: (syncRows ?? [])[0] ?? null,
  }
}

async function main(): Promise<void> {
  const ticket = (process.argv[2] ?? '').trim()
  if (!TICKET_RE.test(ticket) || !isMonitorDbEnabled()) {
    console.log(JSON.stringify({ available: false }))
    return
  }
  let pool: { execute: QueryExecutor['execute']; end?: () => Promise<void> } | null = null
  try {
    const { createMonitorPool } = await import('../monitor-db/pool.ts')
    pool = createMonitorPool(monitorRoleForThisHost(), { connectionLimit: 1 }) as unknown as typeof pool
    const result = await queryResumePlan(pool as QueryExecutor, ticket)
    console.log(JSON.stringify(result))
  } catch {
    console.log(JSON.stringify({ available: false }))
  } finally {
    if (pool && typeof pool.end === 'function') {
      try {
        await pool.end()
      } catch {
        // 短命行程的最尾端，關不掉只能放著（下一行就 return，行程隨即退出）。
      }
    }
  }
}

if (import.meta.main) {
  void main()
}
