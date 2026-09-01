import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const CLOUDFLARED_METRICS_URL = 'http://127.0.0.1:20241/ready'
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
 * 唯讀查詢本機 cloudflared metrics `/ready`（launchd/run-cloudflare-tunnel.sh
 * 沒有覆寫 --metrics，維持預設只 bind 127.0.0.1），判斷 tunnel 是否還活著。
 * 2026-08-25：取代原本查 ngrok `4040/api/tunnels` 的版本（ngrok 已退役，該
 * launchd job 已 bootout）。查不到／逾時／回應格式不對都當作不健康，不拋
 * 例外——健康檢查本身出錯不該連帶讓 process 掛掉。
 */
export async function checkCloudflaredTunnelReachable(apiUrl: string = CLOUDFLARED_METRICS_URL): Promise<boolean> {
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return false
    const data = (await res.json()) as { readyConnections?: unknown }
    return typeof data.readyConnections === 'number' && data.readyConnections > 0
  } catch {
    return false
  }
}

// F-3：hosted server 的 Bearer token 名冊。名冊載入是 fail-closed 的（見
// obsidian mcps/aladdin-admin/src/auth.ts 的 loadRegistry，commit 0d102dc4）：
// 檔案讀不到、JSON 壞掉、條目缺欄位、id/token 重複——任何一種都讓那台 hosted
// server 對**所有** token 一律回 401，直到檔案修好。
//
// 為什麼要在 dispatcher 這裡監控：這個故障的外部可觀測性極低。企劃端看到的
// 只是「認證失敗，請重新登入」，重登還是 401；M1 之後又拿掉了經公網探測
// hosted /health 的能力；唯一的線索是 hosted server 寫在 launchd err log 裡
// 的一行 stderr，沒有人在看。
//
// aladdin-toolsmith 不在清單裡：它沒有名冊檔（認證機制不同），列進來只會變成
// 永遠告警的假陽性。
const TOKEN_REGISTRY_PATHS = [
  '/Users/user/aladdin/aladdin_mcps/aladdin-admin/tokens.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-admin/tokens.pre.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-admin/tokens.evi.json',
  '/Users/user/aladdin/aladdin_mcps/aladdin-platform/tokens.json',
]

/**
 * 判斷一份名冊檔此刻是否還能被 hosted server 成功載入。回傳 null 表示可載入，
 * 否則回傳「不可載入的原因」。
 *
 * 驗證項目刻意逐條對齊 auth.ts 的 loadRegistry——它是唯一的權威，這裡少檢查
 * 一項就會漏報、多檢查一項就會誤報。**已知的耦合**：這是跨 repo 的邏輯複製，
 * loadRegistry 若新增驗證項目，這裡不會自動跟上（漏報，不是誤報）。接受這個
 * 耦合換掉「在 dispatcher 存一把 hosted token 去打需認證端點」那個做法：那會
 * 讓 dispatcher 從「只握有 TG bot token」變成「握有 agrabah 後台憑證」，為了
 * 一個監控功能擴張憑證面，而且監控用的 token 自己被撤銷時會變成永久假警報。
 *
 * reason 只帶固定字串與條目 index，**絕不帶 token 值、id、display_name 或任何
 * 名冊內容**——這個字串會被原樣發到 Telegram（同 auth.ts failClosed 的紀律，
 * 那裡也刻意不輸出 JSON 解析器的原始訊息：Bun 的 JSON.parse 會把出錯位置附近
 * 的原文嵌進訊息，那可能就是 token 值）。
 */
export function checkTokenRegistryLoadable(registryPath: string): string | null {
  let raw: string
  try {
    raw = readFileSync(registryPath, 'utf-8')
  } catch (err) {
    const code = (err as { code?: string }).code
    return code === 'ENOENT' ? '名冊檔不存在' : `名冊檔無法讀取（${code ?? 'unknown'}）`
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'JSON 解析失敗'
  }

  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { tokens?: unknown }).tokens)) {
    return 'tokens 欄位不存在或不是陣列'
  }

  const entries = (parsed as { tokens: Array<{ id?: unknown; token?: unknown }> }).tokens
  const seenIds = new Set<unknown>()
  const seenTokens = new Set<unknown>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (typeof entry?.id !== 'string' || entry.id.length === 0) return `第 ${i} 筆條目缺少合法的 id`
    if (typeof entry.token !== 'string' || entry.token.length === 0) return `第 ${i} 筆條目缺少合法的 token`
    if (seenIds.has(entry.id)) return `第 ${i} 筆條目的 id 與前面重複`
    if (seenTokens.has(entry.token)) return `第 ${i} 筆條目的 token 與前面重複`
    seenIds.add(entry.id)
    seenTokens.add(entry.token)
  }
  return null
}

export type HealthMonitor = {
  /** 執行一次檢查＋（狀態變化時）通知，回傳這次檢查結果。供測試直接呼叫，
   * 不必等真的 setInterval 觸發（硬規則：測試不得靠等待時間成立）。 */
  runOnce: () => Promise<boolean>
  start: (intervalMs?: number) => ReturnType<typeof setInterval>
}

/**
 * T19：週期性健康檢查。risk_notes 講的核心風險是『KeepAlive 只保證 process
 * 存活，不保證 tunnel 真的還連著』（2026-08-25 起 tunnel 換成 Cloudflare
 * Tunnel，但這個風險本質不變：cloudflared 行程活著不代表它跟 Cloudflare 邊緣
 * 的連線還在，bun server 本身完全不會發現）——這裡直接查 cloudflared 本機
 * metrics API 判斷 tunnel 是否還在，只在『健康 ↔ 不健康』狀態真的
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
    registryPaths?: string[]
  } = {},
): HealthMonitor {
  const apiUrl = deps.apiUrl ?? CLOUDFLARED_METRICS_URL
  const chatId = deps.chatId ?? OPERATOR_CHAT_ID
  const registryPaths = deps.registryPaths ?? TOKEN_REGISTRY_PATHS
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
  // F-3：每份名冊各自記狀態，一份壞掉不會遮蔽另一份接著壞掉（若把四份併成
  // 一個布林，第二份壞掉時整體狀態沒有翻轉，就不會再發第二次告警）。
  // 值是「上次看到的原因」，null = 當時可載入；key 不存在 = 還沒檢查過。
  const lastRegistryFailure = new Map<string, string | null>()

  // 跟 ngrok 那半刻意不同：這裡**第一次檢查就會告警**，沒有「只記基準值」的
  // 寬限。tunnel 需要寬限是因為 dispatcher 可能比 tunnel 早起來，是暫態；
  // 而一份存在磁碟上、當下就解析不了的名冊沒有這種暖機期，它已經是故障。
  // 若沿用「第一次只記基準」，「dispatcher 重啟時名冊已經是壞的」這個最該被
  // 告警的情境反而會永遠靜默——那正是 F-3 要補的盲區。
  function checkRegistries(): void {
    for (const registryPath of registryPaths) {
      const reason = checkTokenRegistryLoadable(registryPath)
      const known = lastRegistryFailure.has(registryPath) ? lastRegistryFailure.get(registryPath)! : undefined
      if (known === reason) continue
      lastRegistryFailure.set(registryPath, reason)

      // 只帶檔名不帶完整路徑、只帶 reason 不帶名冊內容（見
      // checkTokenRegistryLoadable 的說明）。
      const name = basename(registryPath)
      if (reason === null) {
        // 從壞掉恢復才報，開機第一次就正常不需要通知。
        if (known !== undefined) notify(`✅ [dispatcher 健康檢查] hosted token 名冊 ${name} 已恢復可載入，認證恢復正常`)
        continue
      }
      notify(
        `⚠️ [dispatcher 健康檢查] hosted token 名冊 ${name} 載入失敗：${reason}\n` +
          '該服務目前對所有 token 一律回 401（fail-closed），企劃端會看到「認證失敗，請重新登入」而且重登也沒用。請修好名冊檔，修好後下一個請求就會自動恢復，不必重啟。',
      )
    }
  }

  async function runOnce(): Promise<boolean> {
    checkRegistries()

    const healthy = await checkCloudflaredTunnelReachable(apiUrl)

    if (lastKnownHealthy === null) {
      lastKnownHealthy = healthy
      return healthy
    }
    if (healthy !== lastKnownHealthy) {
      lastKnownHealthy = healthy
      const text = healthy
        ? '✅ [dispatcher 健康檢查] Cloudflare tunnel 已恢復連線'
        : '⚠️ [dispatcher 健康檢查] Cloudflare tunnel 偵測不到（本機 20241 metrics API 打不到或 readyConnections=0），Telegram webhook 可能已經收不到訊息，請檢查 cloudflared 行程是否還在跑'
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
