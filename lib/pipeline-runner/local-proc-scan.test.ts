// lib/pipeline-runner/local-proc-scan.test.ts — Task 3：worker 端 ps 快照解析
// 與子孫展開。純函式，全部注入假的 ps 輸出字串，不呼叫真的 ps。
import { describe, expect, test } from 'bun:test'
import { expandDescendants, parseRunningPipelineProcs } from './local-proc-scan.ts'

describe('parseRunningPipelineProcs', () => {
  test('抓到 bug wrapper（含 resume 尾端參數）與 demand wrapper，各自的 pid/kind/ticket/extra', () => {
    const ps = [
      '  100     1 bash -c trap ... EXIT\\nunset...\\ntimeout ... run-create-mr FAQ-1234 /Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-04T10-00-00-000Z.stdout.log',
      '  101   100 node /some/child/process.js',
      '  200     1 bash -c trap ... EXIT\\n...\\ntimeout ... run-demand-pipeline ALDREQ-9 someone@example.com',
    ].join('\n')
    const { procs, ppidMap } = parseRunningPipelineProcs(ps)
    expect(procs).toHaveLength(2)
    const bug = procs.find(p => p.kind === 'bug')!
    expect(bug.pid).toBe(100)
    expect(bug.ticket).toBe('FAQ-1234')
    expect(bug.extra).toBe('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-04T10-00-00-000Z.stdout.log')
    const demand = procs.find(p => p.kind === 'demand')!
    expect(demand.pid).toBe(200)
    expect(demand.ticket).toBe('ALDREQ-9')
    expect(demand.extra).toBe('someone@example.com')
    expect(ppidMap.get(101)).toBe(100)
  })

  test('resume 模式的 wrapper（尾端多一個 resume 位置參數）仍能命中', () => {
    const ps = '  300     1 bash -c wrapper-script run-create-mr FAQ-5 /path/FAQ-5.stdout.log resume'
    const { procs } = parseRunningPipelineProcs(ps)
    expect(procs).toHaveLength(1)
    expect(procs[0]!.ticket).toBe('FAQ-5')
    expect(procs[0]!.extra).toBe('/path/FAQ-5.stdout.log')
  })

  test('2026-09-08 起的 wrapper：尾端 `<mode>` 恆帶、`resume` 可選，四種 mode 皆命中且 extra 仍是 stdout 路徑', () => {
    for (const tail of ['full', 'analysis', 'fix resume', 'reanalyze', 'full resume']) {
      const ps = `  300     1 bash -c wrapper-script run-create-mr FAQ-5 /path/FAQ-5.stdout.log ${tail}`
      const { procs } = parseRunningPipelineProcs(ps)
      expect(procs).toHaveLength(1)
      expect(procs[0]!.ticket).toBe('FAQ-5')
      expect(procs[0]!.extra).toBe('/path/FAQ-5.stdout.log')
    }
  })

  test('尾端帶不在值域內的 token（防注入面漂移）不命中', () => {
    const ps = '  300     1 bash -c wrapper-script run-create-mr FAQ-5 /path/FAQ-5.stdout.log bogus'
    expect(parseRunningPipelineProcs(ps).procs).toHaveLength(0)
  })

  test('同一張票多行命中（wrapper + 子行程指令行剛好也符合正則）時只留 pid 最小的', () => {
    const ps = [
      '  500     1 bash -c wrapper run-create-mr FAQ-1 /path/FAQ-1.stdout.log',
      '  499     1 bash -c wrapper run-create-mr FAQ-1 /path/FAQ-1.stdout.log',
    ].join('\n')
    const { procs } = parseRunningPipelineProcs(ps)
    expect(procs).toHaveLength(1)
    expect(procs[0]!.pid).toBe(499)
  })

  test('不是 bash -c 開頭的行、格式不合的行一律略過', () => {
    const ps = ['  1     0 /sbin/launchd', '  2     1 node run-create-mr FAQ-1 /path', 'garbage line'].join('\n')
    const { procs } = parseRunningPipelineProcs(ps)
    expect(procs).toHaveLength(0)
  })

  test('grep/人工 shell 打出含這些字的命令列不會誤中（非 wrapper 樣式）', () => {
    const ps = '  700     1 bash -c grep run-create-mr /tmp/foo.log'
    const { procs } = parseRunningPipelineProcs(ps)
    expect(procs).toHaveLength(0)
  })
})

describe('expandDescendants', () => {
  test('BFS 展開全部子孫（含自己），順序由淺到深', () => {
    const ppidMap = new Map([
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 4],
    ])
    const order = expandDescendants(1, ppidMap)
    expect(order[0]).toBe(1)
    expect(new Set(order)).toEqual(new Set([1, 2, 3, 4, 5]))
    // 5 是 4 的子行程，4 又是 1 的子行程，5 必須排在 4 之後。
    expect(order.indexOf(5)).toBeGreaterThan(order.indexOf(4))
    expect(order.indexOf(4)).toBeGreaterThan(order.indexOf(2))
  })

  test('沒有子孫時只回傳自己', () => {
    expect(expandDescendants(42, new Map())).toEqual([42])
  })

  test('不會因為循環參照無限迴圈（防禦性：ppidMap 不該有環，但展開邏輯本身用 order.includes 擋重複）', () => {
    const ppidMap = new Map([
      [1, 2],
      [2, 1],
    ])
    const order = expandDescendants(1, ppidMap)
    expect(order).toEqual([1, 2])
  })
})
