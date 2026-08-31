// 多機派工（head/worker cluster）的環境變數單一讀取處。
//
// 設計不變式（整個 lib/cluster/ 的前提）：CLUSTER_SHARED_SECRET 沒設定時，
// 多機機制整體不存在——head 不掛 /cluster/* 路由、不做遠端派工、不啟動
// sweeper；worker-agent.ts 直接拒絕啟動。這保證單機部署（現況）的行為與
// 加入 cluster 程式碼之前 100% 相同，現役 launchd 服務即使意外重啟也不受
// 影響。
//
// secret 讀取衛生比照 TG_WEBHOOK_SECRET（見 server.ts / run-server.sh）：
// 只從 process.env 讀（值由 launchd wrapper script 從根目錄 .env 匯出），
// 不自己解析 .env、不印出值、不寫死。

const MIN_SECRET_LENGTH = 32

let warned = false

/**
 * 回傳 cluster 共用 secret；未設定回 null（= 多機機制停用）。
 * 太短的值視同未設定並警告一次——這個 secret 同時暴露在 LAN 與（head 端）
 * cloudflared tunnel 的路由上（後者另有 CF header 結構性阻擋，見
 * cluster-auth.ts），不允許弱值上線。
 */
export function getClusterSecret(): string | null {
  const raw = (process.env.CLUSTER_SHARED_SECRET ?? '').trim()
  if (raw === '') return null
  if (raw.length < MIN_SECRET_LENGTH) {
    if (!warned) {
      warned = true
      console.error(`cluster: CLUSTER_SHARED_SECRET 長度不足（需 ≥${MIN_SECRET_LENGTH} 字元），視同未設定，多機派工停用`)
    }
    return null
  }
  return raw
}

/** worker 名稱格式（登記、job-done 回報共用）：檔名/監控安全字元集。 */
export const WORKER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

/** worker URL 格式：只接受 http(s)://host[:port]，host 不含路徑（callback
 * 與派工都由程式自己補路徑，不讓登記端夾帶任意 path）。 */
export const WORKER_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/

/** head/worker 通用的 ticket 格式（Bug 與需求單兩種前綴）。各 submit 端
 * 仍有自己更嚴的驗證（spawn-create-mr.ts / spawn-demand-pipeline.ts 的
 * TICKET_RE），這裡是 cluster 邊界的第一道防線。 */
export const CLUSTER_TICKET_RE = /^(FAQ|ALDREQ)-\d+$/
