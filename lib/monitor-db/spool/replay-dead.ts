// lib/monitor-db/spool/replay-dead.ts
//
// 再攝入路徑（v3.2 §6.5(g)，v3 完全沒有）：逐條重放 <writer>.<pid>.<start>
// .dead.jsonl 內的條目——成功即從檔案移除、失敗保留並記錄原因，可重跑（多次
// 呼叫同一份殘餘 dead 檔，結果與只呼叫一次相同）。
//
// deploy/monitor-db/replay-dead.sh 會呼叫本檔的 CLI 入口；那支 shell 腳本與
// 「真正的 applyEntry 怎麼建」屬於整合階段（lib/monitor-db/writes.ts 尚未
// 存在，是 DB client 負責人的檔案），不在本檔案的所有權範圍內——這裡只故意
// 不對它做靜態 import，避免它還不存在時讓 bun test 整批連 collect 都失敗。
// replayDeadFile() 這個核心函式本身是完全可測試、與 DB client 無關的。

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

// CLI 入口（整合時使用）：bun lib/monitor-db/spool/replay-dead.ts <dead-file>
// 真正的 applyEntry 由整合階段注入（deploy/monitor-db/replay-dead.sh，不在
// 本檔所有權內）。這裡故意不 import 任何 lib/monitor-db/writes.ts。
if (import.meta.main) {
  console.error(
    'replay-dead.ts CLI 尚待整合：需注入真正的 applyEntry（來自 lib/monitor-db/writes.ts，尚未建立）。' +
      '請改用 replayDeadFile(filePath, { applyEntry }) 由整合腳本呼叫。',
  )
  process.exit(1)
}
