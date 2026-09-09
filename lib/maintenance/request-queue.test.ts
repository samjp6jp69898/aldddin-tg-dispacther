import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaintenanceRequestQueue, type MaintenanceQueueEntry } from './request-queue.ts'

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-request-queue-test-'))
  return { file: join(dir, 'maintenance-request-queue.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const TECH_A = { notion_user_id: 'u-a', notion_user_name: 'A', email: 'a@example.com' }
const TECH_B = { notion_user_id: 'u-b', notion_user_name: 'B', email: 'b@example.com' }

describe('createMaintenanceRequestQueue — enqueue', () => {
  test('第一筆 queued，position=1 ahead=0', () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    const r = q.enqueue('bug', TECH_A, 'FAQ-1')
    expect(r).toEqual({ status: 'queued', position: 1, ahead: 0 })
    expect(q.size()).toBe(1)
    cleanup()
  })

  test('第二筆不同 ticket，position 遞增', () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    q.enqueue('bug', TECH_A, 'FAQ-1')
    const r = q.enqueue('bug', TECH_B, 'FAQ-2')
    expect(r).toEqual({ status: 'queued', position: 2, ahead: 1 })
    cleanup()
  })

  test('同 kind+ticket 重複送出 → already_queued，不重複佔位', () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    q.enqueue('bug', TECH_A, 'FAQ-1')
    const r = q.enqueue('bug', TECH_B, 'FAQ-1')
    expect(r).toEqual({ status: 'already_queued', position: 1, ahead: 0 })
    expect(q.size()).toBe(1)
    cleanup()
  })

  test('同 ticket 字串但不同 kind → 視為不同條目，各自佔位', () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    q.enqueue('bug', TECH_A, 'FAQ-1')
    const r = q.enqueue('demand', TECH_A, 'FAQ-1')
    expect(r).toEqual({ status: 'queued', position: 2, ahead: 1 })
    expect(q.size()).toBe(2)
    cleanup()
  })
})

describe('createMaintenanceRequestQueue — drainAll', () => {
  test('依 FIFO 原順序逐一呼叫對應 kind 註冊的 processor，並清空佇列', async () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    const order: string[] = []
    q.registerProcessor('bug', async entry => {
      order.push(entry.ticket)
    })
    q.enqueue('bug', TECH_A, 'FAQ-1')
    q.enqueue('bug', TECH_B, 'FAQ-2')
    q.enqueue('bug', TECH_A, 'FAQ-3')

    await q.drainAll()

    expect(order).toEqual(['FAQ-1', 'FAQ-2', 'FAQ-3'])
    expect(q.size()).toBe(0)
    cleanup()
  })

  test('沒有註冊對應 kind 的 processor：跳過、不拋例外，不影響其他條目', async () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    const order: string[] = []
    q.registerProcessor('bug', async entry => {
      order.push(entry.ticket)
    })
    q.enqueue('demand', TECH_A, 'ALDREQ-1') // 沒註冊 demand processor
    q.enqueue('bug', TECH_A, 'FAQ-1')

    await expect(q.drainAll()).resolves.toBeUndefined()

    expect(order).toEqual(['FAQ-1'])
    expect(q.size()).toBe(0)
    cleanup()
  })

  test('單筆 processor 丟例外：不中斷後面的單', async () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    const order: string[] = []
    q.registerProcessor('bug', async entry => {
      if (entry.ticket === 'FAQ-1') throw new Error('boom')
      order.push(entry.ticket)
    })
    q.enqueue('bug', TECH_A, 'FAQ-1')
    q.enqueue('bug', TECH_A, 'FAQ-2')

    await q.drainAll()

    expect(order).toEqual(['FAQ-2'])
    cleanup()
  })

  test('崩潰安全：每處理一筆才落盤那一筆，不是一開始就把整條佇列清空落盤（對抗性 review 2026-09-09 發現的問題）', async () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    q.recoverFromDisk() // 啟用 persist
    let sawOnDiskWhileProcessingSecond: string[] | null = null
    q.registerProcessor('bug', async entry => {
      if (entry.ticket === 'FAQ-2') {
        // 正在處理第二筆時，讀狀態檔應該只剩第三筆（第一、二筆都已經被
        // shift 掉並落盤）——不是「一開始就整條清空」，也不是「全部還在」。
        const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { entries: MaintenanceQueueEntry[] }
        sawOnDiskWhileProcessingSecond = onDisk.entries.map(e => e.ticket)
      }
    })
    q.enqueue('bug', TECH_A, 'FAQ-1')
    q.enqueue('bug', TECH_A, 'FAQ-2')
    q.enqueue('bug', TECH_A, 'FAQ-3')

    await q.drainAll()

    expect(sawOnDiskWhileProcessingSecond).toEqual(['FAQ-3'])
    cleanup()
  })

  test('processor 把單重新排回佇列（模擬 drain 中途維護又被打開的自我修正）：只處理這次呼叫開始時就在佇列裡的條目，不會無限迴圈', async () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    const order: string[] = []
    q.registerProcessor('bug', async entry => {
      order.push(entry.ticket)
      if (entry.ticket === 'FAQ-1') {
        // 模擬 claimBugTicket 發現維護又開了，把自己重新排回佇列尾端。
        q.enqueue('bug', TECH_A, 'FAQ-1-requeued')
      }
    })
    q.enqueue('bug', TECH_A, 'FAQ-1')
    q.enqueue('bug', TECH_A, 'FAQ-2')

    await q.drainAll()

    // 只處理了原本的兩筆，重新排回去的那筆留給下一次 drain，且沒有無限迴圈。
    expect(order).toEqual(['FAQ-1', 'FAQ-2'])
    expect(q.size()).toBe(1)
    cleanup()
  })

  test('drainAll 之後再 enqueue：position 從 1 重新算（不是接續舊佇列長度）', async () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    q.registerProcessor('bug', async () => {})
    q.enqueue('bug', TECH_A, 'FAQ-1')
    q.enqueue('bug', TECH_A, 'FAQ-2')
    await q.drainAll()

    const r = q.enqueue('bug', TECH_A, 'FAQ-3')
    expect(r).toEqual({ status: 'queued', position: 1, ahead: 0 })
    cleanup()
  })
})

describe('createMaintenanceRequestQueue — persist／recoverFromDisk', () => {
  test('recoverFromDisk 之前：enqueue 不落盤（短命 CLI 行程不能覆蓋常駐 server 的快照檔）', () => {
    const { file, cleanup } = tmpFile()
    const q = createMaintenanceRequestQueue(file)
    q.enqueue('bug', TECH_A, 'FAQ-1')
    expect(() => readFileSync(file, 'utf8')).toThrow()
    cleanup()
  })

  test('recoverFromDisk 之後：enqueue 會落盤，新實例（模擬行程重啟）讀得回同一批條目', () => {
    const { file, cleanup } = tmpFile()
    const q1 = createMaintenanceRequestQueue(file)
    q1.recoverFromDisk() // 空檔案，啟用 persist
    q1.enqueue('bug', TECH_A, 'FAQ-1')
    q1.enqueue('demand', TECH_B, 'ALDREQ-2')

    const q2 = createMaintenanceRequestQueue(file)
    q2.recoverFromDisk()
    expect(q2.size()).toBe(2)
    cleanup()
  })

  test('狀態檔被竄改/半寫壞：當作空佇列，不拋例外', () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(file, '{not valid json')
    const q = createMaintenanceRequestQueue(file)
    expect(() => q.recoverFromDisk()).not.toThrow()
    expect(q.size()).toBe(0)
    cleanup()
  })

  test('條目 ticket 格式不合法／techUser 欄位不全：該筆丟棄，其餘照舊撿回', () => {
    const { file, cleanup } = tmpFile()
    const entries: Partial<MaintenanceQueueEntry>[] = [
      { kind: 'bug', ticket: 'FAQ-1', techUser: TECH_A, enqueuedAt: new Date().toISOString() },
      { kind: 'bug', ticket: 'not-a-valid-ticket', techUser: TECH_A, enqueuedAt: new Date().toISOString() },
      { kind: 'bug', ticket: 'FAQ-2', techUser: { notion_user_id: 'x' } as any, enqueuedAt: new Date().toISOString() },
    ]
    writeFileSync(file, JSON.stringify({ entries }))

    const q = createMaintenanceRequestQueue(file)
    q.recoverFromDisk()

    expect(q.size()).toBe(1)
    cleanup()
  })
})
