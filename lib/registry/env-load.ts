// lib/registry/env-load.ts — 名冊模組的環境載入（MJ-C11 同構）。
//
// §5.9 的兩支 mcps CLI（make-starter-kit.ts / manage-tokens.ts）是人手觸發的
// 離線 CLI，不經 launchd wrapper，process.env 裡通常沒有監控 DB 的連線資訊與
// 欄位金鑰。MJ-C11 已定案的做法：**缺 key 時 grep head 的 telegram-dispatcher/.env
// 補進 process.env**，不 cache、不改檔、不覆寫已存在的值
// （與 `deploy/monitor-db/backfill/lib/env.ts`、manage-tokens.ts 的既有慣例同構）。
//
// 計畫要的 canonical 位置是 `lib/monitor-db/load-env.ts`；該檔不在本次所有權
// 範圍內，故先落在 registry 內，日後搬遷時本檔應整份併過去、由那支取代。
//
// 只補「缺的」而不覆寫，是為了讓單元測試以 process.env 注入假金鑰的路徑完全
// 不受本檔影響；.env 不存在時靜默略過，缺漏由 loadMonitorEnv / field-crypto /
// roster-decrypt 各自的 fail-loud 抓出來（本檔不做第二套檢查）。

import { readFileSync } from 'node:fs'

export const HEAD_ENV_FILE = '/Users/user/aladdin/telegram-dispatcher/.env'

/** 名冊模組會用到的 env key 白名單（逐 key 列名，比照 launchd wrapper 慣例）。 */
export const REGISTRY_ENV_KEYS = [
  'MON_DB_HOST',
  'MON_DB_PORT',
  'MON_DB_SCHEMA',
  'MON_DB_USER',
  'MON_DB_PASSWORD',
  'MON_FIELD_KEY_V1',
  'MON_BIDX_KEY',
] as const

/**
 * 對 REGISTRY_ENV_KEYS 中 process.env 尚未持有的 key，自 .env 檔補進 process.env。
 * 已存在的一律不覆寫；.env 讀不到時靜默 return。
 */
export function loadRegistryEnv(envFile: string = HEAD_ENV_FILE): void {
  let content: string
  try {
    content = readFileSync(envFile, 'utf8')
  } catch {
    return
  }
  for (const key of REGISTRY_ENV_KEYS) {
    if (process.env[key]) continue
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
    if (m) process.env[key] = m[1].replace(/[\r\n]/g, '')
  }
}
