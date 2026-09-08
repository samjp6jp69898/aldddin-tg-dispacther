import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// Telegram Login Widget 回呼驗簽（https://core.telegram.org/widgets/login）。
// 使用者在 /ops/ 按下 widget 後，Telegram 把瀏覽器導回 data-auth-url
// （/ops/auth/telegram）並在 query string 附上 id / first_name / last_name /
// username / photo_url / auth_date / hash。驗證步驟（官方規格）：
//   data_check_string = 除 hash 以外的所有欄位，依 key 排序，`key=value` 以
//                       換行接起來
//   secret_key        = SHA256(bot_token)
//   hash 必須等於 hex(HMAC_SHA256(secret_key, data_check_string))
// 另外 auth_date 不能太舊（防重放：拿到一條舊的回呼網址不能無限期登入）。
//
// 只有驗簽過的 id 才拿去比對 tech-users.csv 的 tg_chat_id——私訊 chat 的
// chat_id 就是使用者的 Telegram user id，兩者同值，不需要另外對映表。
// 本模組純函式、零 I/O、不印任何欄位（bot token 只在 HMAC 裡用到）。

export type TelegramLoginVerified = { ok: true; id: string; displayName: string; username: string | null }
export type TelegramLoginFailure = { ok: false; reason: 'missing_fields' | 'bad_hash' | 'expired' }

export const DEFAULT_MAX_AGE_SECONDS = 600

export function buildDataCheckString(params: Record<string, string>): string {
  return Object.keys(params)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('\n')
}

export function computeTelegramHash(params: Record<string, string>, botToken: string): string {
  const secret = createHash('sha256').update(botToken).digest()
  return createHmac('sha256', secret).update(buildDataCheckString(params)).digest('hex')
}

function onlyStrings(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export function verifyTelegramLogin(
  raw: Record<string, string | undefined>,
  botToken: string,
  opts: { now?: number; maxAgeSeconds?: number } = {},
): TelegramLoginVerified | TelegramLoginFailure {
  const params = onlyStrings(raw)
  const { id, auth_date: authDate, hash } = params
  if (!id || !authDate || !hash || !/^\d+$/.test(id) || !/^\d+$/.test(authDate) || !/^[0-9a-f]{64}$/.test(hash)) {
    return { ok: false, reason: 'missing_fields' }
  }
  const expected = Buffer.from(computeTelegramHash(params, botToken), 'hex')
  const actual = Buffer.from(hash, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_hash' }
  }
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const issued = Number(authDate)
  // 未來時間也拒絕（容許 60 秒時鐘誤差）：auth_date 本該是 Telegram 簽發當下。
  if (nowSec - issued > maxAge || issued - nowSec > 60) {
    return { ok: false, reason: 'expired' }
  }
  const displayName = [params.first_name, params.last_name].filter(s => s && s.trim() !== '').join(' ') || id
  return { ok: true, id, displayName, username: params.username ?? null }
}
