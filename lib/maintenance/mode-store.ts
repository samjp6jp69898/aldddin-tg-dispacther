import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// 維護模式（2026-09-08 新增）：manual on/off 開關，由 tg-monitor 手動控制。
// head 與 worker 各自在自己機器上落地一份（同一套 /Users/user/aladdin 目錄
// 慣例，見 cluster-head.ts／worker-agent.ts 的 LOG_DIR 常數），互不共享
// 記憶體——head 開著時 claim.ts／demand-claim.ts 的認領入口一律拒絕，這是
// 系統層級「完全不受理新單」的唯一保證；worker 開著時只保證「這台自己不會
// spawn 新工作」，不保證這張單完全沒人執行——dispatch.ts 把 worker 的拒絕
// 當一般 fallback 理由處理，可能改在 head 本機跑（belt-and-braces 的意思是
// 「就算 head 因為 bug 仍然派工到這台，這台自己也會擋」，不是「開任一邊都
// 等於系統整體不受理」，細節見 worker-agent.ts /jobs handler 的呼叫點註解）。
// 正常操作一律兩邊一起開／關（tg-monitor 的一鍵切換），不要只動 worker 這邊。
//
// 持久化到檔案（tmp+rename 原子替換，手法同 worker-registry.ts 的 persist）：
// 行程重啟後維護狀態不會靜默歸零變成「非維護」，這是安全預設方向——維運者
// 手動開啟維護模式期間若剛好遇到部署重啟，不該在沒人注意時悄悄恢復受理。

export type MaintenanceModeStore = {
  isOn: () => boolean
  setOn: (on: boolean) => void
}

export function createMaintenanceModeStore(stateFile: string): MaintenanceModeStore {
  let on = load()

  function load(): boolean {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { on?: unknown }
      return parsed.on === true
    } catch {
      return false // 檔案不存在／壞掉：預設非維護，與加入本功能之前行為一致
    }
  }

  function persist(): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), on }, null, 2))
      renameSync(tmp, stateFile)
    } catch (err) {
      console.error(`maintenance-mode: 寫入 ${stateFile} 失敗: ${err}`)
    }
  }

  return {
    isOn: () => on,
    setOn(next: boolean): void {
      if (on === next) return // 已是目標狀態，冪等不重寫
      on = next
      persist()
    },
  }
}

/** TG bot／ops-ui 對使用者顯示的維護中訊息，兩邊共用同一段文案（比照
 * claim.ts 檔頭「Web UI 與 TG callback 共用同一條路徑」的既有紀律）。 */
export const MAINTENANCE_MESSAGE = '系統目前維護中，暫不受理新的 Bug／需求單認領，請稍後再試。'
