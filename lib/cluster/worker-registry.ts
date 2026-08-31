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
// 判定。刻意不做移除 API：worker 退役時人工刪檔案裡那行即可（低頻維運
// 操作，Rule 2 不為它寫程式）。

export type WorkerInfo = {
  name: string
  url: string
  registeredAt: string
}

export type WorkerRegistry = {
  /** 登記或更新（同 name 覆蓋 url）。輸入不合法回 false，不拋例外——資料
   * 來自網路請求 body，格式問題是呼叫端該收到 4xx 的情況，不是本模組例外。 */
  register: (name: string, url: string) => boolean
  list: () => WorkerInfo[]
}

export function createWorkerRegistry(stateFile: string): WorkerRegistry {
  let workers: WorkerInfo[] = load()

  function load(): WorkerInfo[] {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { workers?: WorkerInfo[] }
      if (!Array.isArray(parsed.workers)) return []
      // 檔案可能被手動編輯（worker 退役時刪行）或半寫壞：逐筆驗格式，不合法
      // 的直接丟棄，跟 pipeline-queue.ts recoverFromDisk 同一套防線。
      return parsed.workers.filter(w => typeof w?.name === 'string' && WORKER_NAME_RE.test(w.name) && typeof w?.url === 'string' && WORKER_URL_RE.test(w.url))
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
        workers.push({ name, url, registeredAt: new Date().toISOString() })
      }
      persist()
      return true
    },
    list: () => workers.map(w => ({ ...w })),
  }
}
