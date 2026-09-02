// backfill/lib/env.ts — Phase 6 回填腳本的環境載入。
//
// 回填是離線 CLI（plan §11.2：一次性、離線、單執行緒、可重跑），與 §5.9 MJ-C11
// 的兩支名冊 CLI 同構：process.env 缺 key 時直接 grep head 的
// telegram-dispatcher/.env（與 manage-tokens.ts 既有慣例同構），不 cache、不改檔。
//
// host 常數依 plan v3 §11.2（MN-3 / m2）：回填列 host 一律 'unknown_pre_migration'
// ——§10.2 雙軌對照白名單靠它排除回填列、R1 不變式靠它標記離線回填例外。
// （2026-09-02 指揮官裁定：以計畫為準，不用 'head'。）

import { readFileSync } from 'node:fs'

export const BACKFILL_HOST = 'unknown_pre_migration'

export const HEAD_ENV_FILE = '/Users/user/aladdin/telegram-dispatcher/.env'

/** 回填各腳本會用到的 env key 白名單（逐 key 列名，比照 launchd wrapper 慣例）。 */
export const BACKFILL_ENV_KEYS = [
  'MON_DB_HOST',
  'MON_DB_PORT',
  'MON_DB_SCHEMA',
  'MON_DB_USER',
  'MON_DB_PASSWORD',
  'MON_FIELD_KEY_V1',
  'MON_BIDX_KEY',
  'MON_VL_URL',
  'MON_VL_USER',
  'MON_VL_PASSWORD',
] as const

/**
 * 對 BACKFILL_ENV_KEYS 中 process.env 尚未持有的 key，自 .env 檔補進 process.env。
 * 只補缺的（已存在的一律不覆寫——測試以 process.env 注入假值的路徑因此不受影響）。
 * .env 不存在時靜默略過（單元測試環境），由後續 loadMonitorEnv / field-crypto
 * 的 fail-loud 把缺漏抓出來。
 */
export function loadBackfillEnv(envFile: string = HEAD_ENV_FILE): void {
  let content: string
  try {
    content = readFileSync(envFile, 'utf8')
  } catch {
    return
  }
  for (const key of BACKFILL_ENV_KEYS) {
    if (process.env[key]) continue
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
    if (m) process.env[key] = m[1].replace(/[\r\n]/g, '')
  }
}
