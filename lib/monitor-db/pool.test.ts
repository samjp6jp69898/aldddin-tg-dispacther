// lib/monitor-db/pool.test.ts — 【G:MN-G7】全 repo 靜態測試：`createPool(` 的
// 出現次數必須恰好 1（就在 pool.ts 的 createMonitorPool() 內）。
//
// 理由：同一份 writes.ts 若在兩個各自建立的 pool 上跑（一個有 -FOUND_ROWS、
// 一個沒有），affectedRows 的三值語意就會分裂成兩種——任何檔案自行呼叫
// `mysql2.createPool` 都必須被這條測試攔下。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) listTsFiles(full, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('MN-G7：createPool( 全 repo 只能出現一次', () => {
  test('唯一呼叫點在 lib/monitor-db/pool.ts', () => {
    const repoRoot = new URL('../../', import.meta.url).pathname
    const files = listTsFiles(repoRoot)
    const hits: string[] = []
    for (const f of files) {
      const codeLines = readFileSync(f, 'utf8')
        .split('\n')
        .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      for (const line of codeLines) {
        const matches = line.match(/(?<!Monitor)\bcreatePool\s*\(/g)
        if (matches) for (let i = 0; i < matches.length; i++) hits.push(f)
      }
    }
    expect(hits).toEqual([join(new URL('.', import.meta.url).pathname, 'pool.ts')])
  })
})
