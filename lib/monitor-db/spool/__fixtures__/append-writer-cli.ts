#!/usr/bin/env bun
// 測試專用 fixture：一次性 writer 行程。啟動後對指定 spool 目錄 append N 條，
// 然後正常結束（exit 0）。只給 replayer.test.ts 的「Phase 1.4 測試 1：並行
// 不丟失」使用——目的是產生兩個真的獨立 OS 行程各自 append，驗證 append-only
// + 批次 fsync 在真實並行下不會互相踩到（v3.2 §6.5(b)）。
//
// 用法：bun append-writer-cli.ts <spoolDir> <writerName> <count> <runIdPrefix>
import { createSpoolWriter } from '../writer.ts'

const [dir, writerName, countStr, runIdPrefix] = process.argv.slice(2)
if (!dir || !writerName || !countStr || !runIdPrefix) {
  console.error('用法：bun append-writer-cli.ts <spoolDir> <writerName> <count> <runIdPrefix>')
  process.exit(1)
}

const count = Number(countStr)
const w = createSpoolWriter({ writer: writerName, dir })

for (let i = 0; i < count; i++) {
  w.append({ ts: new Date().toISOString(), host: 'test-host', run_id: `${runIdPrefix}-${i}`, fn: 'testFn', args: [i] })
}
w.close()
