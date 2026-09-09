import { describe, expect, mock, test } from 'bun:test'

// 維護模式（2026-09-08 新增，2026-09-09 改為「照收不拒絕」）測試：
// claimDemandTicket 的受理閘門，理由與手法同 claim-maintenance.test.ts。
let maintenanceOn = false
const dispatchDemandSpy = mock(async () => ({ ok: true, status: 'started', pid: 1 }) as any)
const getRemoteEntrySpy = mock(() => null as any)
const describeRemoteProgressSpy = mock(async () => 'progress')
mock.module('../cluster/cluster-head.ts', () => ({
  dispatchDemand: dispatchDemandSpy,
  getRemoteEntry: getRemoteEntrySpy,
  describeRemoteProgress: describeRemoteProgressSpy,
  isMaintenanceModeOn: () => maintenanceOn,
}))

const { claimDemandTicket } = await import('./demand-claim.ts')
const { drainMaintenanceQueue } = await import('../maintenance/request-queue.ts')

const FAKE_TECH_USER = { notion_user_id: 'fake-user-id', notion_user_name: '測試人員', email: 'fake@example.com' } as any

describe('claimDemandTicket — 維護模式受理閘門', () => {
  test('維護模式開啟：照收請求排入等待佇列，回 maintenance_queued，且不呼叫 dispatchDemand／getRemoteEntry', async () => {
    maintenanceOn = true
    dispatchDemandSpy.mockClear()
    getRemoteEntrySpy.mockClear()

    const outcome = await claimDemandTicket(FAKE_TECH_USER, 'ALDREQ-9999901')

    expect(outcome.code).toBe('maintenance_queued')
    expect(outcome.text).toContain('ALDREQ-9999901')
    expect(outcome.text).toContain('第 1 順位')
    expect(dispatchDemandSpy).not.toHaveBeenCalled()
    expect(getRemoteEntrySpy).not.toHaveBeenCalled()
  })

  test('維護模式開啟：同一張單重複送出視為已排隊，回 maintenance_already_queued', async () => {
    maintenanceOn = true
    dispatchDemandSpy.mockClear()
    getRemoteEntrySpy.mockClear()

    await claimDemandTicket(FAKE_TECH_USER, 'ALDREQ-9999902')
    const second = await claimDemandTicket(FAKE_TECH_USER, 'ALDREQ-9999902')

    expect(second.code).toBe('maintenance_already_queued')
    expect(dispatchDemandSpy).not.toHaveBeenCalled()
    expect(getRemoteEntrySpy).not.toHaveBeenCalled()
  })

  test('維護模式關閉：不會被 maintenance 分支擋下（往下走到多機派工登記檢查）', async () => {
    maintenanceOn = false
    getRemoteEntrySpy.mockClear()
    getRemoteEntrySpy.mockReturnValueOnce({
      ticket: 'ALDREQ-8888888',
      kind: 'demand',
      status: 'confirmed',
      worker: 'w1',
      workerUrl: 'http://x',
      dispatchedAt: new Date().toISOString(),
      triggeredBy: null,
    } as any)

    const outcome = await claimDemandTicket(FAKE_TECH_USER, 'ALDREQ-8888888')

    expect(outcome.code).toBe('already_running_remote')
    expect(getRemoteEntrySpy).toHaveBeenCalledTimes(1)
  })

  test('維護結束後 drainMaintenanceQueue()：排隊中的單會重新完整跑一次 claimDemandTicket（用 getRemoteEntry 短路避免打真實 Notion）', async () => {
    maintenanceOn = true
    const queued = await claimDemandTicket(FAKE_TECH_USER, 'ALDREQ-9999903')
    expect(queued.code).toBe('maintenance_queued')

    maintenanceOn = false
    getRemoteEntrySpy.mockClear()
    getRemoteEntrySpy.mockImplementation(
      () =>
        ({
          ticket: 'irrelevant',
          kind: 'demand',
          status: 'confirmed',
          worker: 'w1',
          workerUrl: 'http://x',
          dispatchedAt: new Date().toISOString(),
          triggeredBy: null,
        }) as any,
    )

    await drainMaintenanceQueue()

    expect(getRemoteEntrySpy).toHaveBeenCalledWith('ALDREQ-9999903')
  })
})
