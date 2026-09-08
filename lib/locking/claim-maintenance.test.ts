import { describe, expect, mock, test } from 'bun:test'

// 維護模式（2026-09-08）測試：claimBugTicket 的受理閘門要排在所有其他判斷
// 之前。跟 lib/security/whitelist-claim-routing.test.ts 同一套 mock.module
// 手法——真的 dispatchBug/getRemoteEntry 會打真實網路/spawn 背景流程，不是
// 單元測試該做的事；這裡只關心「isMaintenanceModeOn() 回 true 時，
// claimBugTicket 完全不往下走、也不呼叫 dispatchBug/getRemoteEntry」。
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
const { MAINTENANCE_MESSAGE } = await import('../maintenance/mode-store.ts')

const FAKE_TECH_USER = { notion_user_id: 'fake-user-id', notion_user_name: '測試人員', email: 'fake@example.com' } as any

describe('claimBugTicket — 維護模式受理閘門', () => {
  test('維護模式開啟：回 maintenance 代碼與文案，且不呼叫 dispatchBug／getRemoteEntry', async () => {
    maintenanceOn = true
    dispatchBugSpy.mockClear()
    getRemoteEntrySpy.mockClear()

    const outcome = await claimBugTicket(FAKE_TECH_USER, 'FAQ-9999999')

    expect(outcome).toEqual({ code: 'maintenance', text: MAINTENANCE_MESSAGE })
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
})
