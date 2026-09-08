import { describe, expect, mock, test } from 'bun:test'

// 維護模式（2026-09-08）測試：claimDemandTicket 的受理閘門，理由與手法同
// claim-maintenance.test.ts。
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
const { MAINTENANCE_MESSAGE } = await import('../maintenance/mode-store.ts')

const FAKE_TECH_USER = { notion_user_id: 'fake-user-id', notion_user_name: '測試人員', email: 'fake@example.com' } as any

describe('claimDemandTicket — 維護模式受理閘門', () => {
  test('維護模式開啟：回 maintenance 代碼與文案，且不呼叫 dispatchDemand／getRemoteEntry', async () => {
    maintenanceOn = true
    dispatchDemandSpy.mockClear()
    getRemoteEntrySpy.mockClear()

    const outcome = await claimDemandTicket(FAKE_TECH_USER, 'ALDREQ-9999999')

    expect(outcome).toEqual({ code: 'maintenance', text: MAINTENANCE_MESSAGE })
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
})
