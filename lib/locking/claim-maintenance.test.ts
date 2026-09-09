import { describe, expect, mock, test } from 'bun:test'

// 維護模式（2026-09-08 新增，2026-09-09 改為「照收不拒絕」）測試：
// claimBugTicket 的受理閘門要排在所有其他判斷之前。跟
// lib/security/whitelist-claim-routing.test.ts 同一套 mock.module 手法——
// 真的 dispatchBug/getRemoteEntry 會打真實網路/spawn 背景流程，不是單元
// 測試該做的事；這裡關心「isMaintenanceModeOn() 回 true 時，claimBugTicket
// 完全不往下走、也不呼叫 dispatchBug/getRemoteEntry，改把請求排入
// request-queue.ts 的 FIFO 佇列」，以及維護結束後 drainMaintenanceQueue()
// 會重新完整跑一次本函式。
let maintenanceOn = false
const dispatchBugSpy = mock(async () => ({ ok: true, status: 'started', pid: 1 }) as any)
const getRemoteEntrySpy = mock(() => null as any)
const describeRemoteProgressSpy = mock(async () => 'progress')
mock.module('../cluster/cluster-head.ts', () => ({
  dispatchBug: dispatchBugSpy,
  getRemoteEntry: getRemoteEntrySpy,
  describeRemoteProgress: describeRemoteProgressSpy,
  isMaintenanceModeOn: () => maintenanceOn,
}))

const { claimBugTicket } = await import('./claim.ts')
const { drainMaintenanceQueue } = await import('../maintenance/request-queue.ts')

const FAKE_TECH_USER = { notion_user_id: 'fake-user-id', notion_user_name: '測試人員', email: 'fake@example.com' } as any

describe('claimBugTicket — 維護模式受理閘門', () => {
  test('維護模式開啟：照收請求排入等待佇列，回 maintenance_queued，且不呼叫 dispatchBug／getRemoteEntry', async () => {
    maintenanceOn = true
    dispatchBugSpy.mockClear()
    getRemoteEntrySpy.mockClear()

    const outcome = await claimBugTicket(FAKE_TECH_USER, 'FAQ-9999901')

    expect(outcome.code).toBe('maintenance_queued')
    expect(outcome.text).toContain('FAQ-9999901')
    expect(outcome.text).toContain('第 1 順位')
    expect(dispatchBugSpy).not.toHaveBeenCalled()
    expect(getRemoteEntrySpy).not.toHaveBeenCalled()
  })

  test('維護模式開啟：同一張單重複送出視為已排隊，回 maintenance_already_queued，順位不變', async () => {
    maintenanceOn = true
    dispatchBugSpy.mockClear()
    getRemoteEntrySpy.mockClear()

    await claimBugTicket(FAKE_TECH_USER, 'FAQ-9999902')
    const second = await claimBugTicket(FAKE_TECH_USER, 'FAQ-9999902')

    expect(second.code).toBe('maintenance_already_queued')
    expect(dispatchBugSpy).not.toHaveBeenCalled()
    expect(getRemoteEntrySpy).not.toHaveBeenCalled()
  })

  test('維護模式關閉：不會被 maintenance 分支擋下（往下走到多機派工登記檢查）', async () => {
    maintenanceOn = false
    getRemoteEntrySpy.mockClear()
    // 讓下一步（多機派工登記）短路回覆，避免測試繼續往下打真實 Notion。
    getRemoteEntrySpy.mockReturnValueOnce({
      ticket: 'FAQ-8888888',
      kind: 'bug',
      status: 'confirmed',
      worker: 'w1',
      workerUrl: 'http://x',
      dispatchedAt: new Date().toISOString(),
      triggeredBy: null,
    } as any)

    const outcome = await claimBugTicket(FAKE_TECH_USER, 'FAQ-8888888')

    expect(outcome.code).toBe('already_running_remote')
    expect(getRemoteEntrySpy).toHaveBeenCalledTimes(1)
  })

  test('維護結束後 drainMaintenanceQueue()：排隊中的單會重新完整跑一次 claimBugTicket（用 getRemoteEntry 短路避免打真實 Notion）', async () => {
    maintenanceOn = true
    const queued = await claimBugTicket(FAKE_TECH_USER, 'FAQ-9999903')
    expect(queued.code).toBe('maintenance_queued')

    maintenanceOn = false
    getRemoteEntrySpy.mockClear()
    // 用 mockImplementation（不是 mockReturnValueOnce）：本檔前面幾個測試
    // enqueue 過、但沒 drain 的條目（同一個 module 單例）也會被這次
    // drainMaintenanceQueue() 一併清空重跑，全部都要在碰到 Notion 之前被
    // 這個短路擋下。
    getRemoteEntrySpy.mockImplementation(
      () =>
        ({
          ticket: 'irrelevant',
          kind: 'bug',
          status: 'confirmed',
          worker: 'w1',
          workerUrl: 'http://x',
          dispatchedAt: new Date().toISOString(),
          triggeredBy: null,
        }) as any,
    )

    await drainMaintenanceQueue()

    expect(getRemoteEntrySpy).toHaveBeenCalledWith('FAQ-9999903')
  })
})
