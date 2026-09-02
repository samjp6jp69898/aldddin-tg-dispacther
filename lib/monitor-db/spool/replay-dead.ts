// lib/monitor-db/spool/replay-dead.ts
//
// 再攝入路徑（v3.2 §6.5(g)，v3 完全沒有）：逐條重放 <writer>.<pid>.<start>
// .dead.jsonl 內的條目——成功即從檔案移除、失敗保留並記錄原因，可重跑（多次
// 呼叫同一份殘餘 dead 檔，結果與只呼叫一次相同）。
//
// deploy/monitor-db/replay-dead.sh 會呼叫本檔的 CLI 入口。真正的 applyEntry
// 由 lib/monitor-db/apply-entry.ts（DB client 負責人的檔案）提供，見檔尾
// CLI 入口的動態 import——刻意用動態 import 而非靜態，維持
// replayDeadFile() 這個核心函式完全可測試、與 DB client 無關（bun test
// 收集本檔時不需要真的連得到 DB）。

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { SpoolEntry } from './types.ts'

export interface DeadReplayDeps {
  applyEntry(entry: SpoolEntry): Promise<{ ok: boolean; reason?: string }>
}

export interface DeadReplayResult {
  succeeded: number
  remaining: number
  failures: Array<{ seq: number; reason?: string }>
}

/**
 * 逐條重放 dead-letter 檔：成功即從檔案移除、失敗保留並記錄原因。冪等、可
 * 重跑——多次呼叫同一份殘餘 dead 檔，結果與只呼叫一次相同（§6.5(g)）。
 */
export async function replayDeadFile(filePath: string, deps: DeadReplayDeps): Promise<DeadReplayResult> {
  if (!existsSync(filePath)) return { succeeded: 0, remaining: 0, failures: [] }

  const lines = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.length > 0)
  const remaining: string[] = []
  const failures: Array<{ seq: number; reason?: string }> = []
  let succeeded = 0

  for (const line of lines) {
    let entry: SpoolEntry & { dead_reason?: string }
    try {
      entry = JSON.parse(line)
    } catch {
      remaining.push(line) // 壞行原樣保留，不要憑空丟資料
      continue
    }
    const result = await deps.applyEntry(entry)
    if (result.ok) {
      succeeded += 1
    } else {
      remaining.push(JSON.stringify({ ...entry, dead_reason: result.reason ?? entry.dead_reason }))
      failures.push({ seq: entry.seq, reason: result.reason })
    }
  }

  if (remaining.length > 0) {
    writeFileSync(filePath, `${remaining.join('\n')}\n`, { mode: 0o600 })
  } else {
    unlinkSync(filePath)
  }
  return { succeeded, remaining: remaining.length, failures }
}

// CLI 入口：bun lib/monitor-db/spool/replay-dead.ts <dead-file> [--worker]
// 整合修補批次（item 2）接上真正的 applyEntry（lib/monitor-db/apply-entry.ts）。
// 動態 import：本檔的核心函式 replayDeadFile() 完全與 DB client 無關、可獨立
// 測試，CLI 入口才需要真的連 DB，維持「import 這個模組本身零副作用」的既有
// 紀律（只有真的執行 CLI 時才載入 mysql2）。
if (import.meta.main) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('用法：bun lib/monitor-db/spool/replay-dead.ts <dead-file> [--worker]')
    process.exit(1)
  }
  const isWorker = process.argv.includes('--worker')
  const { createMonitorPool } = await import('./../pool.ts')
  const { createDeadReplayDeps } = await import('./../apply-entry.ts')
  const pool = createMonitorPool(isWorker ? 'mon_exec' : 'mon_head', { connectionLimit: 1 })
  try {
    const result = await replayDeadFile(filePath, createDeadReplayDeps(pool))
    console.log(`replay-dead: succeeded=${result.succeeded} remaining=${result.remaining}`)
    if (result.failures.length > 0) {
      for (const f of result.failures) console.log(`  seq=${f.seq} reason=${f.reason ?? '(無)'}`)
    }
    process.exit(result.remaining > 0 ? 1 : 0)
  } finally {
    await pool.end()
  }
}
