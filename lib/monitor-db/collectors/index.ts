// lib/monitor-db/collectors/index.ts — Phase 4 collectors 的**唯一接線入口**。
//
// 兩個長駐進入點（server.ts / worker-agent.ts）各呼叫一次
// `startMonitorCollectors({ role })`，其餘的 pool／spool 取得、角色差異、
// flag 閘門與「永不外拋」都收在本檔，進入點只留一行。
//
// 硬性紀律（違反任一條就等於打掉 §9.0(B) 的可證偽驗收）：
//   1. **flag 閘門在最前面**：`isMonitorDbEnabled()=false` 時整段 no-op——
//      不建 timer、不取 pool、不建 spool writer（連 `logs/spool/` 都不會被碰）。
//   2. **pool 一律經 runtime.ts 既有取得路徑**（`getLongLivedMonitorPool()`：
//      head=mon_head、worker=mon_exec，由 `monitorRoleForThisHost()` 決定），
//      collector 本體絕不自行 `createPool`。
//   3. **永不外拋**（比照 `startMonitorMaintenance` 的接線慣例）：任何失敗只
//      WARN + 回一個 stop() 什麼也不做的 handle，絕不讓 boot 崩潰。
//   4. 角色分工（§11.1 授權對映）：`agent_runs` head 與 worker 都寫；
//      `mcp_usage` 是 head only 的表（`mon_exec` 沒有權限），所以 audit
//      ingester 只在 head 掛載。
import { isMonitorDbEnabled, type DeclarableMonitorRole } from '../env.ts'
import { dispatchMonitorWrite, getLongLivedMonitorPool, getLongLivedMonitorSpoolWriter } from '../runtime.ts'
import { upsertAgentRun } from '../writes.ts'
import { startAgentRunsCollector } from './agent-runs-collector.ts'
import { startAuditIngester } from './audit-ingester.ts'

export interface MonitorCollectorsHandle {
  stop(): void
}

const NOOP_HANDLE: MonitorCollectorsHandle = { stop() {} }

/**
 * 掛載本機該跑的 collectors。`role` 由呼叫端顯式帶入（與
 * `declareMonitorRole()` 同一個值），不在這裡重新嗅探。
 */
export function startMonitorCollectors(opts: { role: DeclarableMonitorRole }): MonitorCollectorsHandle {
  if (!isMonitorDbEnabled()) return NOOP_HANDLE

  try {
    const handles = [
      // agent_runs：head 與 worker 都收（trace 與 stdout 都落在執行機本地）。
      startAgentRunsCollector({
        getExecutor: getLongLivedMonitorPool,
        // 非阻斷、逾時/失敗落 spool、永不 throw（§6.7）。`upsertAgentRun` 是
        // run 類 fn，spool 條目必帶非空 run_id——collector 本體已保證對不到
        // run_id 的檔案根本不會走到這裡。
        writeAgentRun: input => dispatchMonitorWrite('upsertAgentRun', input, pool => upsertAgentRun(pool, input)),
      }),
    ]

    if (opts.role === 'mon_head') {
      handles.push(
        startAuditIngester({
          getExecutor: getLongLivedMonitorPool,
          getSpool: getLongLivedMonitorSpoolWriter,
        }),
      )
    }

    return {
      stop() {
        for (const h of handles) h.stop()
      },
    }
  } catch (err) {
    console.error(`monitor-db collectors: 啟動失敗，本行程不收集 agent_runs／mcp_usage（不影響其他功能）: ${err}`)
    return NOOP_HANDLE
  }
}
