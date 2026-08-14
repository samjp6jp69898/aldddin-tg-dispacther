import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'
// 見 cron/bug-report-run.sh 同一套維運告警慣例：維運對象（Landon）的
// chat_id 直接寫死，不透過 tech-users.csv 查——這是給「人」的維運告警，不是
// 給某張 ticket 的技術指派，跟 T13 補發通知的判準（Notion 當前指派）不同。
const OPERATOR_CHAT_ID = '5022865804'
const FETCH_TIMEOUT_MS = 5000
const EXEC_TIMEOUT_MS = 10_000
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const LOG_FILE = join(LOG_DIR, 'health-monitor.log')

// review 發現：原本 notify 失敗被 catch 空吞掉，完全沒有任何 fallback
// 記錄——tunnel 真的斷線、且 tg-notify.sh 本身也失敗（例如逾時/被誤刪）這種
// 雙重故障會無聲無息、哪裡都查不到。比照 T13 post-run-notify.ts 的既有慣例
// （成功/失敗都各自留一筆 log），這裡也一樣落地記錄。
function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // 連寫 log 都失敗（例如磁碟問題）不該讓健康檢查本身掛掉，放棄記錄即可。
  }
}

/**
 * 唯讀查詢本機 ngrok admin API（launchd/run-tunnel.sh 沒有覆寫 --web-addr，
 * 維持預設只 bind 127.0.0.1，見 T18），判斷 tunnel 是否還活著。查不到／
 * 逾時／回應格式不對都當作不健康，不拋例外——健康檢查本身出錯不該連帶讓
 * process 掛掉。
 */
export async function checkNgrokTunnelReachable(apiUrl: string = NGROK_API_URL): Promise<boolean> {
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return false
    const data = (await res.json()) as { tunnels?: unknown }
    return Array.isArray(data.tunnels) && data.tunnels.length > 0
  } catch {
    return false
  }
}

export type HealthMonitor = {
  /** 執行一次檢查＋（狀態變化時）通知，回傳這次檢查結果。供測試直接呼叫，
   * 不必等真的 setInterval 觸發（硬規則：測試不得靠等待時間成立）。 */
  runOnce: () => Promise<boolean>
  start: (intervalMs?: number) => ReturnType<typeof setInterval>
}

/**
 * T19：週期性健康檢查。risk_notes 講的核心風險是『KeepAlive 只保證 process
 * 存活，不保證 ngrok tunnel 真的還連著』（ngrok 免費方案同時間只允許 1 個
 * agent session，被踢下線後 bun server 本身完全不會發現）——這裡直接查
 * ngrok 本機 admin API 判斷 tunnel 是否還在，只在『健康 ↔ 不健康』狀態真的
 * 翻轉時才發 tg-notify.sh（避免每次 tick 都通知洗版），第一次檢查只記基準
 * 值不發通知（避免程式剛啟動、tunnel 還沒起來就誤報）。用 setInterval 做
 * 週期排程——硬規則明文允許的合法用途（週期性排程器），不是拿 sleep/輪詢
 * 去規避某個競態。
 *
 * 已知範圍缺口（review 發現，非本次修復範圍）：這只覆蓋 risk_notes 講的
 * 「ngrok tunnel 斷線」這一半，沒有覆蓋「bun server 本身 event loop 卡死」
 * 那一半——若真的整個卡死，這裡的 setInterval callback 本身也不會觸發，
 * 是「靜默不再檢查」而非「主動偵測到自己掛了並告警」。這種自我不可觀測的
 * 故障，結構上只能靠外部（另一個獨立 process）定期從外部戳 /health 才能
 * 偵測，不是這支「輕量」內部檢查的範圍，需要的話應該另開一個 task。
 */
export function createHealthMonitor(
  deps: {
    apiUrl?: string
    chatId?: string
    notify?: (text: string) => void
  } = {},
): HealthMonitor {
  const apiUrl = deps.apiUrl ?? NGROK_API_URL
  const chatId = deps.chatId ?? OPERATOR_CHAT_ID
  const notify =
    deps.notify ??
    ((text: string) => {
      try {
        execFileSync('bash', [TG_NOTIFY_SH, '--chat-id', chatId, '--text', text], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS })
        log(`notify OK: ${text.split('\n')[0]}`)
      } catch (err) {
        // best-effort：通知失敗不影響健康檢查本身繼續跑下一輪，但要留痕跡
        // ——tunnel 斷線 + tg-notify.sh 也失敗這種雙重故障不能完全無聲無息。
        log(`notify FAILED: ${text.split('\n')[0]} -> ${err}`)
      }
    })

  let lastKnownHealthy: boolean | null = null // null = 還沒檢查過（開機基準）

  async function runOnce(): Promise<boolean> {
    const healthy = await checkNgrokTunnelReachable(apiUrl)

    if (lastKnownHealthy === null) {
      lastKnownHealthy = healthy
      return healthy
    }
    if (healthy !== lastKnownHealthy) {
      lastKnownHealthy = healthy
      const text = healthy
        ? '✅ [dispatcher 健康檢查] ngrok tunnel 已恢復連線'
        : '⚠️ [dispatcher 健康檢查] ngrok tunnel 偵測不到（本機 4040 admin API 打不到或沒有 active tunnel），Telegram webhook 可能已經收不到訊息，請檢查 tunnel 是否被踢下線'
      notify(text)
    }
    return healthy
  }

  function start(intervalMs = 60_000) {
    return setInterval(() => {
      runOnce().catch(() => {}) // setInterval 的 callback 不能是會丟未捕捉 rejection 的 async
    }, intervalMs)
  }

  return { runOnce, start }
}
