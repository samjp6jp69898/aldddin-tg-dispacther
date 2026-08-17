import { describe, expect, test } from 'bun:test'
import { buildDemandImplementerPrompt } from './demand-implementer-prompt.ts'

describe('buildDemandImplementerPrompt — 純邏輯，不打真實 API', () => {
  test('正確帶入 ticket、規格內容、留言、worktree 路徑', () => {
    const prompt = buildDemandImplementerPrompt('ALDREQ-741', '這是規格內容', ['小明：這是留言'], {
      repos: ['abu'],
      worktreePaths: { abu: '/Users/user/aladdin/worktrees/ALDREQ-741/abu' },
    })

    expect(prompt).toContain('ALDREQ-741')
    expect(prompt).toContain('這是規格內容')
    expect(prompt).toContain('小明：這是留言')
    expect(prompt).toContain('/Users/user/aladdin/worktrees/ALDREQ-741/abu')
  })

  test('多個 repo 時，每個都列進工作範圍限制', () => {
    const prompt = buildDemandImplementerPrompt('ALDREQ-560', '規格', [], {
      repos: ['rajah', 'agrabah', 'abu'],
      worktreePaths: {
        rajah: '/wt/rajah',
        agrabah: '/wt/agrabah',
        abu: '/wt/abu',
      },
    })

    expect(prompt).toContain('/wt/rajah')
    expect(prompt).toContain('/wt/agrabah')
    expect(prompt).toContain('/wt/abu')
  })

  test('規格內容/留言是空的時候，明確標註，不是留白', () => {
    const prompt = buildDemandImplementerPrompt('ALDREQ-999', '', [], { repos: ['abu'], worktreePaths: { abu: '/wt/abu' } })
    expect(prompt).toContain('這不應該發生')
    expect(prompt).toContain('（沒有留言）')
  })

  // 這幾條斷言直接對應回溯測試三次真實漏掉的情境（見 tasks.json T35
  // changelog），釘住 prompt 真的把這些教訓寫進去，不是只在程式碼註解裡
  // 講過而已。
  test('包含窮盡搜尋、新命名前查既有慣例、粒度保守、排除清單獨立檢查這四條紀律', () => {
    const prompt = buildDemandImplementerPrompt('ALDREQ-1', '規格', [], { repos: ['abu'], worktreePaths: { abu: '/wt' } })
    expect(prompt).toContain('換一個不同的搜尋角度重新驗證一次')
    expect(prompt).toContain('先搜尋鄰近既有慣例')
    expect(prompt).toContain('最小、最集中')
    expect(prompt).toContain('排除清單')
  })
})
