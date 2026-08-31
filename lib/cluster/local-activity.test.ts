import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalActivity, parsePipelineWrapperTickets } from './local-activity.ts'

// 真實 ps 輸出中，wrapper script 內嵌的換行會被 BSD ps 轉成不可列印字元
// （單行呈現）——這也是 post-run-notify.ts 既有掃描能逐行 parse 的前提。
const WRAPPER_PS = [
  '  123 bash -c ?trap stuff?timeout 7200 claude -p ... run-create-mr FAQ-100 /x/logs/FAQ-100.stdout.log',
  '  124 bash -c ?trap stuff?timeout 7200 claude -p ... run-create-mr FAQ-101 /x/logs/FAQ-101.stdout.log resume',
  '  125 bash -c ?EC=$??bun /x/lib/pipeline-runner/run-demand-pipeline.ts "$1" "$2"? run-demand-pipeline ALDREQ-7 a@x.tw',
  '  126 /Users/user/.bun/bin/bun server.ts',
  '  127 grep run-create-mr FAQ-999 something', // 不是 bash -c 開頭，不算
].join('\n')

describe('parsePipelineWrapperTickets', () => {
  test('抓出 bug（含 resume）與 demand wrapper 的 ticket，忽略非 wrapper 行程', () => {
    expect(parsePipelineWrapperTickets(WRAPPER_PS).sort()).toEqual(['ALDREQ-7', 'FAQ-100', 'FAQ-101'])
  })

  test('script 本文裡的 run-demand-pipeline.ts 路徑不會誤中（位置參數樣式才算）', () => {
    const out = '  1 bash -c ?bun /x/run-demand-pipeline.ts "$1"? run-demand-pipeline ALDREQ-8 b@x.tw'
    expect(parsePipelineWrapperTickets(out)).toEqual(['ALDREQ-8'])
    const noArgs = '  2 bash -c ?bun /x/run-demand-pipeline.ts "$1"? something-else'
    expect(parsePipelineWrapperTickets(noArgs)).toEqual([])
  })
})

describe('createLocalActivity — queue ∪ 鎖目錄 ∪ ps 三合一', () => {
  function makeHarness(opts: { queueBug?: string[]; queueDemand?: string[]; locks?: string[]; ps?: string; psThrows?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'local-activity-test-'))
    for (const t of opts.locks ?? []) mkdirSync(join(dir, t), { recursive: true })
    const activity = createLocalActivity({
      queueRunning: { bug: () => opts.queueBug ?? [], demand: () => opts.queueDemand ?? [] },
      lockDir: dir,
      psOutput: () => {
        if (opts.psThrows) throw new Error('ps failed')
        return opts.ps ?? ''
      },
    })
    return { activity, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('三個來源任一看得到就算 active；activeTickets 依前綴分 kind', () => {
    const h = makeHarness({
      queueBug: ['FAQ-1'], // 只有 queue 看得到（剛 spawn）
      locks: ['FAQ-2', 'ALDREQ-3'], // 只有鎖看得到（out-of-band 已拿鎖）
      ps: '  9 bash -c ?x? run-create-mr FAQ-4 /logs/x.log', // 只有 ps 看得到（out-of-band 冷啟動）
    })
    expect(h.activity.isActive('FAQ-1')).toBe(true)
    expect(h.activity.isActive('FAQ-2')).toBe(true)
    expect(h.activity.isActive('ALDREQ-3')).toBe(true)
    expect(h.activity.isActive('FAQ-4')).toBe(true)
    expect(h.activity.isActive('FAQ-999')).toBe(false)
    expect([...h.activity.activeTickets('bug')].sort()).toEqual(['FAQ-1', 'FAQ-2', 'FAQ-4'])
    expect([...h.activity.activeTickets('demand')]).toEqual(['ALDREQ-3'])
    h.cleanup()
  })

  test('ps 掃描失敗不癱瘓判定：退回 queue + 鎖兩個來源', () => {
    const h = makeHarness({ queueBug: ['FAQ-1'], locks: ['ALDREQ-2'], psThrows: true })
    expect(h.activity.isActive('FAQ-1')).toBe(true)
    expect(h.activity.isActive('ALDREQ-2')).toBe(true)
    expect(h.activity.isActive('FAQ-3')).toBe(false)
    h.cleanup()
  })

  test('鎖目錄不存在（機器重開後 /tmp 清空）當空集合', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'local-activity-test-')), 'nonexistent')
    const activity = createLocalActivity({
      queueRunning: { bug: () => [], demand: () => [] },
      lockDir: dir,
      psOutput: () => '',
    })
    expect(activity.isActive('FAQ-1')).toBe(false)
    expect(activity.activeTickets('bug').size).toBe(0)
  })
})
