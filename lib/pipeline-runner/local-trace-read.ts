// lib/pipeline-runner/local-trace-read.ts — worker 端唯讀「這個 trace/stdout
// 檔案的內容是什麼」（2026-09-04 新增，worker-agent.ts 的 GET /files 用）。
//
// 背景：head 的 tg-monitor `/api/agent-trace` 原本直接把 `agent_runs.path`
// 當 head 本機路徑做 `existsSync`/`readFileSync`——worker 執行的 run 一律
// 404（那個路徑只存在於執行機的本地檔案系統）。這裡讓 worker 自己暴露一支
// 唯讀端點回傳檔案內容，head 端 proxy 過去（見 tg-monitor/server.ts
// `/api/agent-trace` 的 host 分流），不用把整份 trace 檔透過 log-shipper 落地
// 到 head（那條管線非同步、有延遲，且是給 tail 用的頂層 *.log，不含
// agent-traces/**/*.json，見 lib/log-shipper/mount.ts 檔頭）。
//
// 白名單規則**逐字比照** tg-monitor/lib/services.ts 的 isAllowedTracePath——
// 兩邊都是同一套 /Users/user/aladdin 目錄慣例（worker 機上的 telegram-dispatcher
// checkout 固定在這個路徑，見 worker-agent.ts LOG_DIR 註解），刻意不放寬。

import { existsSync, readFileSync } from 'node:fs'

const DISPATCHER_LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const AGENT_TRACE_DIR = `${DISPATCHER_LOG_DIR}/agent-traces`

/** 逐字比照 tg-monitor/lib/services.ts 的 isAllowedTracePath——改動任一邊都要同步。 */
export function isAllowedTracePath(p: string): boolean {
  if (p.includes('..')) return false
  if (p.startsWith(`${AGENT_TRACE_DIR}/`) && p.endsWith('.json')) return true
  return p.startsWith(`${DISPATCHER_LOG_DIR}/`) && p.endsWith('.stdout.log')
}

export type ReadLocalTraceResult = { ok: true; content: string } | { ok: false; reason: 'not_allowed' | 'missing' | 'read_failed'; detail?: string }

/** 白名單 + 存在性 + 讀檔，三段錯誤各自回傳可分辨的 reason（worker-agent.ts
 * 的 handler 據此決定 HTTP status）。 */
export function readLocalTraceFile(path: string): ReadLocalTraceResult {
  if (!isAllowedTracePath(path)) return { ok: false, reason: 'not_allowed' }
  if (!existsSync(path)) return { ok: false, reason: 'missing' }
  try {
    return { ok: true, content: readFileSync(path, 'utf8') }
  } catch (err) {
    return { ok: false, reason: 'read_failed', detail: String(err) }
  }
}
