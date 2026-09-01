import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WORKER_NAME_RE, WORKER_URL_RE } from './cluster-env.ts'

// head 端的 worker 名冊：worker-agent 啟動時（與其後每 30 分鐘冪等重送）
// POST /cluster/register 登記自己，head 據此知道派工候選有哪些。
//
// 持久化到檔案（tmp+rename 原子替換，手法同 pipeline-queue.ts 的 persist）：
// head 重啟後名冊不歸零，不用等 worker 的下一輪重登記才恢復派工能力。
// 名冊裡的 worker 不保證活著——派工選擇（dispatch.ts）每次都即時打
// /capacity 探測，打不通就跳過，名冊只是「去哪裡問」的地址簿，不是存活
// 判定。
//
// disabled（2026-08-31，tg-monitor Workers 分頁「中斷」按鈕新增）：head 端
// 手動停用某台 worker，讓它繼續留在名冊裡（詳情、探測都還看得到）但不再
// 被 dispatch.ts 選為派工候選；不影響該台身上已經在跑的工作。cluster-head.ts
// 組裝 dispatcher 依賴時要對 listWorkers() 的結果做 filter，本模組只負責
// 存這個狀態，不含派工邏輯。
//
// remove（同上新增）：從名冊移除一行，等同過去「退役時人工刪檔案裡那行」
// 這件事的程式化版本——注意它只是拿掉「地址簿」這一列，不會讓那台機器
// 真的停止服務：worker-agent.ts 每 30 分鐘會冪等重送登記，若該機的
// worker-agent 行程仍在跑，移除後最長 30 分鐘內會自己重新出現在名冊（且
// disabled 狀態重置為 false）。要真正讓一台 worker 退役，移除的同時要在
// 該機停掉 worker-agent（launchctl bootout）。

export type WorkerInfo = {
  name: string
  url: string
  registeredAt: string
  /** true = head 手動停用，不再收到新工作（見上方檔頭）。 */
  disabled: boolean
}

export type WorkerRegistry = {
  /** 登記或更新（同 name 覆蓋 url）。輸入不合法回 false，不拋例外——資料
   * 來自網路請求 body，格式問題是呼叫端該收到 4xx 的情況，不是本模組例外。 */
  register: (name: string, url: string) => boolean
  list: () => WorkerInfo[]
  /** 停用/恢復；找不到該名稱回 false。已是目標狀態時冪等回 true、不重寫檔。 */
  setDisabled: (name: string, disabled: boolean) => boolean
  /** 從名冊移除一行；找不到回 false。見上方檔頭「remove」一節的重新出現風險。 */
  remove: (name: string) => boolean
}

export function createWorkerRegistry(stateFile: string): WorkerRegistry {
  let workers: WorkerInfo[] = load()

  function load(): WorkerInfo[] {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { workers?: WorkerInfo[] }
      if (!Array.isArray(parsed.workers)) return []
      // 檔案可能被手動編輯（worker 退役時刪行）或半寫壞：逐筆驗格式，不合法
      // 的直接丟棄，跟 pipeline-queue.ts recoverFromDisk 同一套防線。disabled
      // 一律經 `=== true` 收斂成真正的 boolean，不信任檔案裡的任意值。
      return parsed.workers
        .filter(w => typeof w?.name === 'string' && WORKER_NAME_RE.test(w.name) && typeof w?.url === 'string' && WORKER_URL_RE.test(w.url))
        .map(w => ({ ...w, disabled: (w as { disabled?: unknown }).disabled === true }))
    } catch {
      return []
    }
  }

  function persist(): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), workers }, null, 2))
      renameSync(tmp, stateFile)
    } catch (err) {
      console.error(`worker-registry: 寫入 ${stateFile} 失敗: ${err}`)
    }
  }

  return {
    register(name: string, url: string): boolean {
      if (!WORKER_NAME_RE.test(name) || !WORKER_URL_RE.test(url)) return false
      const existing = workers.find(w => w.name === name)
      if (existing) {
        if (existing.url === url) return true // 冪等重登記，不重寫檔
        existing.url = url
        existing.registeredAt = new Date().toISOString()
      } else {
        workers.push({ name, url, registeredAt: new Date().toISOString(), disabled: false })
      }
      persist()
      return true
    },
    list: () => workers.map(w => ({ ...w })),
    setDisabled(name: string, disabled: boolean): boolean {
      const existing = workers.find(w => w.name === name)
      if (!existing) return false
      if (existing.disabled === disabled) return true // 已是目標狀態，冪等不重寫
      existing.disabled = disabled
      persist()
      return true
    },
    remove(name: string): boolean {
      const before = workers.length
      workers = workers.filter(w => w.name !== name)
      if (workers.length === before) return false
      persist()
      return true
    },
  }
}
