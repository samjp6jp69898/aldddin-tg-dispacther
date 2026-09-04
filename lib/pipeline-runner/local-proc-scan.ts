// lib/pipeline-runner/local-proc-scan.ts — worker 端「這張票的 wrapper pid 在
// ps 快照裡是哪一個、子孫怎麼展開」，供 lib/pipeline-runner/local-cancel.ts
// 的取消端點使用。
//
// 演算法與行程指紋比照 tg-monitor/lib/ingest.ts 的
// scanRunningPipelineProcs()/cancelPipeline()（tg-monitor 是純 head 本機工具，
// 不會部署到 worker，worker 不能 import 它——見
// lib/monitor-db/cancel-resolve.ts 檔頭「跨 repo 用複製對齊邏輯，不是技術債」
// 的既有模式）；行程指紋正則與 lib/cluster/local-activity.ts 的
// BUG_PROC_RE/DEMAND_PROC_RE 同源（wrapper 命令列樣式見 spawn-create-mr.ts
// 的 WRAPPER_SCRIPT 檔頭），這裡額外多抓 ppid（子孫展開）與位置參數本體
// （bug 的 stdout log 路徑／demand 的 assignee email，供 legacy_key 反推），
// local-activity.ts 只需要 ticket 存在與否，兩邊職責不同，不合併成一份。

import { execFileSync } from 'node:child_process'

export type RunningProc = { pid: number; kind: 'bug' | 'demand'; ticket: string; extra: string }

const PS_TIMEOUT_MS = 10_000

/**
 * 解析 `ps -axo pid=,ppid=,command=` 的輸出：找出目前有 wrapper 行程在跑的
 * ticket（每張票只留 pid 最小那個——bash wrapper 本體），並回傳 pid→ppid 的
 * 對照表供子孫展開用。純函式，`psOutput` 由呼叫端傳入以便單測（不吃預設值
 * 就一定要外部提供，避免測試不小心打到真實 ps）。
 */
export function parseRunningPipelineProcs(psOutput: string): { procs: RunningProc[]; ppidMap: Map<number, number> } {
  const procs: RunningProc[] = []
  const ppidMap = new Map<number, number>()
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const cmd = m[3]!
    ppidMap.set(pid, ppid)
    if (!cmd.startsWith('bash -c ')) continue
    // 尾端可選的字面 `resume`（比照 spawn-create-mr.ts $3 只有 {'resume', ''}
    // 兩個值，見 tg-monitor/lib/ingest.ts scanRunningPipelineProcs 同款正則）。
    let mm = /^bash -c [\s\S]*\brun-create-mr\s+([A-Z]+-\d+)\s+(\S+?)(?:\s+resume)?\s*$/.exec(cmd)
    if (mm) {
      procs.push({ pid, kind: 'bug', ticket: mm[1]!, extra: mm[2]! })
      continue
    }
    mm = /^bash -c [\s\S]*\brun-demand-pipeline\s+([A-Z]+-\d+)\s+(\S+)\s*$/.exec(cmd)
    if (mm) procs.push({ pid, kind: 'demand', ticket: mm[1]!, extra: mm[2]! })
  }
  // 同一張票可能有 bash wrapper + 子行程多行命中（極少見，但比照 tg-monitor
  // 既有紀律），留 pid 最小那個。
  const byKey = new Map<string, RunningProc>()
  for (const p of procs) {
    const k = `${p.kind}:${p.ticket}`
    if (!byKey.has(k) || byKey.get(k)!.pid > p.pid) byKey.set(k, p)
  }
  return { procs: [...byKey.values()], ppidMap }
}

/** 真的呼叫 `ps` 取得目前快照（生產路徑；測試一律注入固定字串，不呼叫這支）。 */
export function scanRunningPipelineProcsNow(): { procs: RunningProc[]; ppidMap: Map<number, number> } {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS })
    return parseRunningPipelineProcs(out)
  } catch {
    return { procs: [], ppidMap: new Map() }
  }
}

/**
 * 由 ppid 快照展開一個 pid 的全部子孫（BFS，含 pid 自己），回傳順序是
 * 「由淺到深」——呼叫端要「最深先殺」時自行 `.reverse()`（比照
 * tg-monitor/lib/ingest.ts cancelPipeline 的 order/descendants 用法）。
 */
export function expandDescendants(pid: number, ppidMap: ReadonlyMap<number, number>): number[] {
  const order: number[] = []
  const queue = [pid]
  while (queue.length) {
    const p = queue.shift()!
    order.push(p)
    for (const [cpid, cppid] of ppidMap) if (cppid === p && !order.includes(cpid)) queue.push(cpid)
  }
  return order
}
