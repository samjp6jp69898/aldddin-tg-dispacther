// T26：全域背景 pipeline 併發上限。獨立於 bug-lock.sh 的單票（per-ticket）
// 鎖——bug-lock 只保證『同一張 ticket 不會被兩個人同時觸發』，擋不住『短時間
// 內多張不同 ticket 各自觸發一個 claude -p 背景流程』疊加起來把機器資源
// 榨乾，尤其疊加 T16『每次觸發都要求全部涉及 repo 真隔離』之後，每個背景
// 流程本身的資源成本又更高（見 tasks.json T26 risk_notes）。
//
// in-memory 計數器，不做成檔案：webhook server 重啟會讓計數器歸零——這是
// 可接受的 trade-off，重啟當下本來就無從得知舊背景流程是否還在跑，檔案式
// 計數器一樣要處理『server crash 時計數器沒清乾淨』的問題，反而更複雜
// （Rule 2：不做用不到的抽象）；task 描述本身也把 in-memory 列為可接受選項。
//
// N=5：使用者 2026-08-16 明確定案（task 描述原本只給保守建議值 3，數字本身
// 不是可以自行推測的細節）。
export const GLOBAL_CONCURRENCY_LIMIT = 5

export type ConcurrencyLimiter = {
  /** 嘗試佔用一個名額；額度足夠回 true 並佔用，額度用盡回 false（不佔用）。 */
  tryAcquire: () => boolean
  /** 釋放一個名額。夾在 0 下限——多次呼叫、或從未成功 acquire 就呼叫都安全，
   * 不會讓計數器變成負數進而讓後續 tryAcquire 誤放行超過 limit 的請求。 */
  release: () => void
  /** 目前佔用的名額數，供測試/觀察用。 */
  current: () => number
}

export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  let count = 0
  return {
    tryAcquire() {
      if (count >= limit) return false
      count++
      return true
    },
    release() {
      count = Math.max(0, count - 1)
    },
    current() {
      return count
    },
  }
}

// review 發現：全 process 共用的 singleton 故意不在這裡 export——這個檔案只
// 有一個消費者（lib/pipeline-runner/spawn-create-mr.ts），比照 rate-limit.ts／
// health-monitor.ts 的既有慣例（工廠函式留在 lib，實例化交給唯一的呼叫端），
// singleton 本身就近放在 spawn-create-mr.ts 頂端。
