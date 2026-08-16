// T27：update_id 重放去重（defense-in-depth，見 tasks.json T27 risk_notes——
// bug-lock.sh 的原子鎖已經防住『同一張單被重複觸發 pipeline』這個主要情境，
// 這裡是額外一層保險，擋的是「同一個 update 本身被重放」：可能是有人截了
// 一份合法 webhook payload 對著（猜對的）webhook 路徑重送，也可能是 Telegram
// 自己在我們回應逾時/出錯時做的合法重試——不管哪種情境，同一個 update_id
// 第二次進來都不該再跑一次業務邏輯（重複查 Notion、重複觸發 claim/spawn）。
//
// Telegram 保證每個 update 的 update_id 全域唯一且遞增（不分 message／
// callback_query 等 update 類型，都在同一個序列上），所以整個 bot 只需要
// 一份共用的去重集合，不用分開追蹤 message 跟 callback_query。
//
// 用 bounded in-memory Set（插入順序 = 舊到新，超過上限就砍最舊的一筆）：
// 不用 TTL/計時器——acceptance criteria 給的兩個選項『上限或 TTL』本來就是
// 互相替代關係，size cap 已經足夠滿足『不會無限增長造成記憶體洩漏』，不需要
// 額外背一個 setInterval 清理迴圈（Rule 2）。
const MAX_TRACKED = 1000

export type ReplayGuard = {
  /** 這個 updateId 是不是已經看過：是的話回 true（呼叫端應該直接忽略，不
   * 執行任何業務邏輯）；第一次看到回 false，並記錄下來。 */
  isDuplicate: (updateId: number) => boolean
  /** review 發現：isDuplicate 是「查完立刻記」，若業務邏輯在 isDuplicate
   * 回傳 false 之後才失敗（例如打 Notion/Telegram API 失敗），Telegram 會
   * 依照它自己的重試機制重新投遞同一個 update_id——但那次重試會被誤判成
   * 重放而永久吞掉，使用者收不到任何回應，也沒有錯誤提示。呼叫端應該在
   * 業務邏輯丟出例外時呼叫這個方法，把該 updateId 從已處理集合移除，讓
   * Telegram 之後真正的重試可以再跑一次業務邏輯。 */
  forget: (updateId: number) => void
}

export function createReplayGuard(maxTracked: number = MAX_TRACKED): ReplayGuard {
  const seen = new Set<number>()
  return {
    isDuplicate(updateId) {
      if (seen.has(updateId)) return true
      seen.add(updateId)
      if (seen.size > maxTracked) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      return false
    },
    forget(updateId) {
      seen.delete(updateId)
    },
  }
}
