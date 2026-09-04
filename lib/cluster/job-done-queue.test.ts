// lib/cluster/job-done-queue.test.ts — Task 2：job-done 回報待重送佇列。
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobDoneQueue, retryJobDoneQueue } from './job-done-queue.ts'

describe('createJobDoneQueue', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('未呼叫 loadFromDisk 前 enqueue 不落盤（短命行程/測試安全網）', () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const stateFile = join(dir, 'job-done-queue.json')
    const q = createJobDoneQueue(stateFile)
    q.enqueue({ ticket: 'FAQ-1', worker: 'w1' })
    expect(() => readFileSync(stateFile, 'utf8')).toThrow()
    expect(q.list()).toHaveLength(1) // in-memory 仍然看得到
  })

  test('loadFromDisk 之後 enqueue/remove 會 tmp+rename 原子寫入', () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const stateFile = join(dir, 'job-done-queue.json')
    const q = createJobDoneQueue(stateFile)
    q.loadFromDisk() // 啟用 persist（空檔案，等同全新啟動）
    const id = q.enqueue({ ticket: 'FAQ-1', worker: 'w1', trackerRow: 'FAQ-1\tdone\t2026-09-04 1200' })
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8')) as { entries: unknown[] }
    expect(onDisk.entries).toHaveLength(1)

    q.remove(id)
    const afterRemove = JSON.parse(readFileSync(stateFile, 'utf8')) as { entries: unknown[] }
    expect(afterRemove.entries).toHaveLength(0)
    expect(q.list()).toHaveLength(0)
  })

  test('worker 重啟：新 createJobDoneQueue 呼叫 loadFromDisk() 撿回上次未送達的回報', () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const stateFile = join(dir, 'job-done-queue.json')
    const q1 = createJobDoneQueue(stateFile)
    q1.loadFromDisk()
    q1.enqueue({ ticket: 'FAQ-42', worker: 'worker-a' })

    // 模擬行程重啟：全新的 queue 實例，指向同一個 stateFile。
    const q2 = createJobDoneQueue(stateFile)
    const recovered = q2.loadFromDisk()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.ticket).toBe('FAQ-42')
    expect(recovered[0]!.worker).toBe('worker-a')
  })

  test('loadFromDisk 對壞掉/格式不對的條目逐筆丟棄，不讓半寫壞的檔案流進佇列', () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const stateFile = join(dir, 'job-done-queue.json')
    writeFileSync(
      stateFile,
      JSON.stringify({
        entries: [
          { id: 'ok-1', ticket: 'FAQ-1', worker: 'w1', enqueuedAt: '2026-09-04T00:00:00.000Z' },
          { id: 'bad-missing-ticket', worker: 'w1', enqueuedAt: '2026-09-04T00:00:00.000Z' },
          { ticket: 'FAQ-3' }, // 缺 id/worker/enqueuedAt
        ],
      }),
    )
    const q = createJobDoneQueue(stateFile)
    const recovered = q.loadFromDisk()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.id).toBe('ok-1')
  })
})

describe('retryJobDoneQueue — 模擬「第一次失敗落地、第二次 tick 重試成功、佇列清空」', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('post 失敗時保留在佇列；post 成功時移除', async () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const stateFile = join(dir, 'job-done-queue.json')
    const q = createJobDoneQueue(stateFile)
    q.loadFromDisk()
    q.enqueue({ ticket: 'FAQ-100', worker: 'w1' })
    q.enqueue({ ticket: 'FAQ-200', worker: 'w1' })

    // 第一輪：兩筆都失敗（模擬 head 打不到）。
    const r1 = await retryJobDoneQueue(q, async () => false)
    expect(r1).toEqual({ attempted: 2, succeeded: 0 })
    expect(q.list()).toHaveLength(2)

    // 第二輪：head 恢復，只有 FAQ-100 成功送達（模擬部分成功）。
    const r2 = await retryJobDoneQueue(q, async entry => entry.ticket === 'FAQ-100')
    expect(r2).toEqual({ attempted: 2, succeeded: 1 })
    expect(q.list().map(e => e.ticket)).toEqual(['FAQ-200'])

    // 第三輪：剩下那筆也送達，佇列清空。
    const r3 = await retryJobDoneQueue(q, async () => true)
    expect(r3).toEqual({ attempted: 1, succeeded: 1 })
    expect(q.list()).toHaveLength(0)

    // 完整流程走完後，磁碟上也是空佇列（tmp+rename 落地）。
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8')) as { entries: unknown[] }
    expect(onDisk.entries).toHaveLength(0)
  })

  test('post 丟例外視同失敗，保留在佇列、不讓例外往外冒', async () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const q = createJobDoneQueue(join(dir, 'job-done-queue.json'))
    q.loadFromDisk()
    q.enqueue({ ticket: 'FAQ-1', worker: 'w1' })

    const r = await retryJobDoneQueue(q, async () => {
      throw new Error('network error')
    })
    expect(r).toEqual({ attempted: 1, succeeded: 0 })
    expect(q.list()).toHaveLength(1)
  })

  test('空佇列：attempted=0，不呼叫 post', async () => {
    dir = mkdtempSync(join(tmpdir(), 'job-done-queue-'))
    const q = createJobDoneQueue(join(dir, 'job-done-queue.json'))
    q.loadFromDisk()
    let calls = 0
    const r = await retryJobDoneQueue(q, async () => {
      calls++
      return true
    })
    expect(r).toEqual({ attempted: 0, succeeded: 0 })
    expect(calls).toBe(0)
  })
})
