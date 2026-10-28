import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeProgress, createProgressReporter, formatElapsed, renderProgress } from './changelog-progress.ts'

// /changelog 進度：以 RUN_DIR 內產物是否存在判斷階段；reporter 只在內容變動時 edit、失敗不拋。
// 時間一律注入 now()，不靠等待。

function runDirWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-progress-'))
  mkdirSync(join(dir, 'v2'))
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}

const REPOS = ['agrabah', 'rajah', 'abu', 'lago']

describe('computeProgress', () => {
  test('剛開始：全部未完成，提取 0/4', () => {
    const dir = runDirWith(['ranges.json'])
    const steps = computeProgress(dir, REPOS, join(dir, 'out.html'))
    expect(steps.every(s => !s.done)).toBe(true)
    expect(steps[0]!.count).toEqual({ done: 0, total: 4 })
  })

  test('提取到一半＋菜單已解析：各自獨立判斷', () => {
    const dir = runDirWith(['agrabah.md', 'abu.md', 'menu-tree.json'])
    const steps = computeProgress(dir, REPOS, join(dir, 'out.html'))
    expect(steps[0]).toMatchObject({ done: false, count: { done: 2, total: 4 } })
    expect(steps[1]!.done).toBe(true)
    expect(steps[2]!.done).toBe(false)
  })

  test('影響範圍只計有 commit 的 repo；全部產物齊全時每步都完成', () => {
    const dir = runDirWith([
      'agrabah.md', 'abu.md', 'menu-tree.json', 'changes.json',
      'v2/impact-agrabah-rel.json', 'v2/impact-abu-rel.json', 'v2/changes-business.json', 'out.html',
    ])
    const steps = computeProgress(dir, ['agrabah', 'abu'], join(dir, 'out.html'))
    expect(steps.map(s => s.done)).toEqual([true, true, true, true, true, true])
  })
})

describe('renderProgress', () => {
  test('第一個未完成標 ⏳、之後 ⬜；多 repo 顯示計數，不含預估時間與去重數量', () => {
    const text = renderProgress(
      '開始產生 changelog：\n• abu abu_admin_1.10.46 → feature/20261008（12 個 commit）',
      [
        { label: '提取各 repo 變更', done: true, count: { done: 4, total: 4 } },
        { label: '解析菜單', done: false },
        { label: '對應菜單與 commit 審計', done: false },
      ],
      125_000,
    )
    expect(text).toContain('進度（已執行 2 分 5 秒）：')
    expect(text).toContain('✅ 1/3 提取各 repo 變更（4/4）')
    expect(text).toContain('⏳ 2/3 解析菜單')
    expect(text).toContain('⬜ 3/3 對應菜單與 commit 審計')
    expect(text).not.toContain('20–40')
    expect(text).not.toContain('去重後')
  })

  test('單一 repo 不顯示 1/1 計數；footer 取代進度標題', () => {
    const text = renderProgress('h', [{ label: '提取各 repo 變更', done: true, count: { done: 1, total: 1 } }], 0, '✅ 完成')
    expect(text.endsWith('✅ 1/1 提取各 repo 變更')).toBe(true)
    expect(text).toContain('✅ 完成')
    expect(text).not.toContain('進度（')
  })

  test('formatElapsed', () => {
    expect(formatElapsed(59_900)).toBe('59 秒')
    expect(formatElapsed(61_000)).toBe('1 分 1 秒')
  })
})

describe('createProgressReporter', () => {
  function setup(opts: { failEdit?: boolean } = {}) {
    const edits: string[] = []
    let t = 0
    let done = false
    const reporter = createProgressReporter({
      api: {
        editMessageText: (async (_chat: number, _msg: number, text: string) => {
          if (opts.failEdit) throw new Error('Bad Request: message to edit not found')
          edits.push(text)
          return true
        }) as never,
      },
      chatId: -1001,
      messageId: 42,
      header: 'h',
      progress: () => [{ label: '組裝 HTML', done }],
      startedAt: 0,
      now: () => t,
    })
    return { reporter, edits, setTime: (v: number) => (t = v), markDone: () => (done = true) }
  }

  test('內容不變不重送；時間或階段變了才 edit', async () => {
    const { reporter, edits, setTime, markDone } = setup()
    await reporter.tick()
    await reporter.tick()
    expect(edits).toHaveLength(1)
    setTime(20_000)
    await reporter.tick()
    expect(edits).toHaveLength(2)
    markDone()
    await reporter.finish('✅ 完成（耗時 20 秒），HTML 已傳送')
    expect(edits).toHaveLength(3)
    expect(edits[2]).toContain('✅ 1/1 組裝 HTML')
    expect(edits[2]).toContain('✅ 完成（耗時 20 秒），HTML 已傳送')
  })

  test('edit 失敗不往外拋', async () => {
    const { reporter } = setup({ failEdit: true })
    await reporter.tick()
    await reporter.finish('❌')
  })
})
