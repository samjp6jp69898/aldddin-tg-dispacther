// cursor-restore.ts + mount.ts 的關鍵語意測試。
//
// 這支只釘一件事，但那件事錯了代價最大：**「問不到游標」與「沒有游標」必須
// 是兩種不同的回傳**。混為一談的話，一次 DB 讀取失敗就會讓 shipper 對每個檔
// 從 offset 0 重讀，把整份歷史（掛載當下 head 是 151.8 MB／170 個檔）重送一次。

import { describe, expect, test } from 'bun:test'
import { restoreCursorsFromDb } from './cursor-restore.ts'
import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

function fakeDb(rows: unknown[]): MonitorDbExecutor {
  return { execute: async () => [rows as never, null] }
}
function throwingDb(): MonitorDbExecutor {
  return { execute: async () => { throw new Error('connection lost') } }
}

describe('restoreCursorsFromDb', () => {
  test('查詢失敗 → null（不是空物件）', async () => {
    expect(await restoreCursorsFromDb(throwingDb(), 'head')).toBeNull()
  })

  test('查得 0 列 → 空物件（不是 null）——真的沒有游標，可以從頭開始', async () => {
    expect(await restoreCursorsFromDb(fakeDb([]), 'head')).toEqual({})
  })

  test('正常還原成 path → {inode, offset}', async () => {
    const got = await restoreCursorsFromDb(
      fakeDb([{ path: '/a/b.log', inode: 123, offset: 456 }]),
      'head',
    )
    expect(got).toEqual({ '/a/b.log': { inode: 123, offset: 456 } })
  })

  test('inode 為 NULL 的列略過——還原不出可信游標，寧可重複不可缺口', async () => {
    const got = await restoreCursorsFromDb(
      fakeDb([
        { path: '/a/good.log', inode: 1, offset: 10 },
        { path: '/a/bad.log', inode: null, offset: 20 },
      ]),
      'head',
    )
    expect(got).toEqual({ '/a/good.log': { inode: 1, offset: 10 } })
  })

  test('mysql2 可能回字串數值 → 轉成 number，不讓字串流進 tailer', async () => {
    const got = await restoreCursorsFromDb(
      fakeDb([{ path: '/a/b.log', inode: '123', offset: '456' }]),
      'head',
    )
    expect(got).toEqual({ '/a/b.log': { inode: 123, offset: 456 } })
  })
})
