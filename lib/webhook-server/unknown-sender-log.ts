import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// whitelist.ts 對白名單外的 chat_id 一律靜默 return，本來完全不留任何痕跡；
// 而 tg-chatid-sync 原本靠 Telegram getUpdates 讀「誰 DM 過本 bot」，但
// getUpdates 跟本服務的 webhook 互斥（Telegram 409 Conflict，二選一，不是
// 設定問題），webhook 開著就永遠讀不到。這裡補上本機這份 log，讓「新同事
// 第一次 DM」也能被 tg-chatid-sync 事後對映回 tech-users.csv，不必為了讀
// getUpdates 去停用正式在跑的 webhook。
export const DEFAULT_UNKNOWN_SENDERS_LOG = join('/Users/user/aladdin/telegram-dispatcher/logs', 'unknown-senders.jsonl')

type MinimalChat = {
  id: number | string
  type?: string
  first_name?: string
  last_name?: string
  username?: string
}

function hasSeenChatId(logFile: string, chatId: string): boolean {
  if (!existsSync(logFile)) return false
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      if (String(JSON.parse(trimmed).chat_id) === chatId) return true
    } catch {
      // 壞行忽略，不影響判斷。
    }
  }
  return false
}

/**
 * 只記白名單外、私聊（type === 'private'）的 sender；群組/頻道一律忽略。
 * 寫檔失敗（例如磁碟問題）不該讓訊息處理連帶掛掉，放棄記錄即可（比照
 * health-monitor.ts 的 log() 慣例）。
 *
 * 回傳這個 chat_id 是否為「第一次」出現在這份 log——呼叫端（whitelist.ts）
 * 用這個訊號決定要不要 fire-and-forget 觸發 tg-auto-sync.sh，避免同一個還
 * 卡在 ASK 待人工確認的 sender，每多傳一則訊息就重跑一次整套比對流程。
 */
// 預設值故意每次呼叫才求值（不是模組載入時求值一次的 top-level const）：
// 讓 TG_UNKNOWN_SENDERS_LOG_PATH 可以在測試檔動態 import whitelist.ts 之前
// 設定，不受「哪個測試檔先 import 到這個 module」的載入順序影響——見
// whitelist-auto-sync-trigger.test.ts 檔頭註解。生產環境不用設這個變數。
export function logUnknownSender(
  chat: MinimalChat,
  logFile: string = process.env.TG_UNKNOWN_SENDERS_LOG_PATH || DEFAULT_UNKNOWN_SENDERS_LOG,
): boolean {
  if (chat.type !== 'private') return false
  const chatId = String(chat.id)
  const isNew = !hasSeenChatId(logFile, chatId)
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      chat_id: chatId,
      first_name: chat.first_name ?? '',
      last_name: chat.last_name ?? '',
      username: chat.username ?? '',
    })
    appendFileSync(logFile, line + '\n')
  } catch {
    // 寫 log 失敗不影響訊息處理本身。
  }
  return isNew
}
