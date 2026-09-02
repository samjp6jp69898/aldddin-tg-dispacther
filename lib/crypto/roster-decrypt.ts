// `decryptField` 唯一定義處（決策 4 / D2，§4.1，BL-C4 的一半）。
//
// **邊界紀律**：這是全 repo 唯一能把 DB 密文變回明文的入口。
// - 只有 `lib/registry/*`（名冊重生／投影模組）可以 import 本檔。
// - `import-boundary.test.ts` 掃全 repo 的 import 圖強制這條規則：
//   `roster-decrypt.ts` 的 importer 集合必須恰好等於白名單，多一個就 FAIL。
// - 同一測試另外掃 `aladdin_mcps` 全 repo，斷言沒有任何檔案直接 import
//   `telegram-dispatcher/lib/crypto/**`（MJ-E9 §4.1 白名單第二列）。
//
// 契約改動（v3 對 v2「明文旁路」的修法，BL-C4）：
// - value **未帶 `enc:v1:` 前綴 → 丟例外**（v2 是「原樣回傳明文」，那正是
//   鑄造攻擊的入口——本檔絕不回退明文）。
// - 帶未知版本前綴 → 丟例外。
// - GCM tag 驗證失敗（竄改、AAD 不符、密文損毀）→ `createDecipheriv` /
//   `.final()` 原生丟例外，不吞、不轉成「解密失敗回 null」這種可被誤用的形狀。
//
// 金鑰只從 `process.env.MON_FIELD_KEY_V1` 讀（head 專用，Phase 0 已佈建），
// 缺鑰為 fail-loud：呼叫 `decryptField` 時直接丟例外。

import { createDecipheriv } from 'node:crypto'

const VERSION_PREFIX = 'enc:v1:'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

function fieldKey(): Buffer {
  const raw = process.env.MON_FIELD_KEY_V1
  if (!raw) {
    throw new Error('[roster-decrypt] missing required key env var: MON_FIELD_KEY_V1')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LEN) {
    throw new Error(`[roster-decrypt] MON_FIELD_KEY_V1 must decode (base64) to ${KEY_LEN} bytes, got ${key.length}`)
  }
  return key
}

/**
 * 解密單一欄位值。`ctx` 必須與加密時傳入 `encryptField` 的 `ctx` 逐字元相同
 * （AAD 綁定），否則視為竄改並丟例外。
 *
 * `value` 缺 `enc:v1:` 前綴、帶未知版本前綴、或 GCM tag 驗證失敗，一律丟例外
 * ——這是本函式與 v2 版本的核心差異：**不回退明文、不吞例外**。
 */
export function decryptField(ctx: string, value: string): string {
  if (typeof value !== 'string' || !value.startsWith(VERSION_PREFIX)) {
    throw new Error(`[roster-decrypt] value missing 'enc:v1:' prefix or unknown version (ctx=${ctx})`)
  }
  const b64 = value.slice(VERSION_PREFIX.length)
  const payload = Buffer.from(b64, 'base64url')
  if (payload.length < IV_LEN + TAG_LEN) {
    throw new Error(`[roster-decrypt] ciphertext too short (ctx=${ctx})`)
  }
  const iv = payload.subarray(0, IV_LEN)
  const tag = payload.subarray(payload.length - TAG_LEN)
  const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN)

  const key = fieldKey()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(ctx, 'utf8'))
  decipher.setAuthTag(tag)
  // 竄改／AAD 不符／密文損毀 → decipher.final() 原生丟例外，不吞。
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}
