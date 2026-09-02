// 應用層欄位加密（決策 4 / D2，§4.1）。
//
// 邊界（BL-C4 的一半，v3 §4.1 刻意拆開的兩個模組之一）：
// - 本檔只提供「加密／盲索引／判斷是否已加密／金鑰指紋」。
// - **不提供解密**——`decryptField` 唯一定義在 `roster-decrypt.ts`，且只有
//   `lib/registry/*` 可以 import 那支模組（見 roster-decrypt.ts 頂部註解與
//   import-boundary.test.ts）。
//
// 演算法：AES-256-GCM，iv 12 bytes random，tag 16 bytes，
// 密文格式 `enc:v1:<base64url(iv12 ‖ ct ‖ tag16)>`。
//
// 金鑰只在 head 的 `.env`（`MON_FIELD_KEY_V1`／`MON_BIDX_KEY`），本模組只從
// `process.env` 讀，不主動載入或快取任何 .env 檔案本身。缺鑰為 fail-loud：
// 呼叫加密／盲索引時直接丟例外，不靜默降級、不回退明文。

import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'

const VERSION_PREFIX = 'enc:v1:'
const IV_LEN = 12
const KEY_LEN = 32
const BIDX_INFO_ENCODING = 'utf8'

function loadKey(envVar: string): Buffer {
  const raw = process.env[envVar]
  if (!raw) {
    throw new Error(`[field-crypto] missing required key env var: ${envVar}`)
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LEN) {
    throw new Error(`[field-crypto] ${envVar} must decode (base64) to ${KEY_LEN} bytes, got ${key.length}`)
  }
  return key
}

function fieldKey(): Buffer {
  return loadKey('MON_FIELD_KEY_V1')
}

function bidxKey(): Buffer {
  return loadKey('MON_BIDX_KEY')
}

/**
 * 加密單一欄位值。`ctx` 是 AAD，慣例為 `"<table>.<column>:<row-key>"`——
 * 呼叫端必須傳入寫入前就算得出的自然鍵（見 §4.1 m-2），本函式不驗證格式，
 * 只把它當 opaque byte string 綁進 GCM 的 AAD（密文因此不能被複製到另一列／另一欄）。
 */
export function encryptField(ctx: string, plaintext: string): string {
  const key = fieldKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(ctx, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, ct, tag])
  return VERSION_PREFIX + payload.toString('base64url')
}

/** value 是否帶已知版本的加密前綴（不解密、不驗證密文完整性）。 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(VERSION_PREFIX)
}

/**
 * `SHA-256(key)` 輸出的前 8 hex（MN-C6：明確不是金鑰本身的前 8 hex，
 * 後者會洩漏 32 bit 金鑰）。用於 doctor 比對 head 上的金鑰與 DB 密文是否同源，
 * 不會洩漏可用於解密的資訊。
 */
export function keyFingerprint(): string {
  const key = fieldKey()
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/**
 * 等值查詢用盲索引。`scope` 是 `"<table>.<column>"`（**不含 row-key**，
 * 與 `encryptField` 的 `ctx` 刻意不同）——同一 scope 內相同明文必須映射到
 * 相同的索引值，等值查詢才做得到。
 *
 * 金鑰獨立於欄位加密金鑰（`MON_BIDX_KEY`，不是 `MON_FIELD_KEY_V1`），並以
 * `HKDF-SHA256(MON_BIDX_KEY, info=scope)` 派生每個 scope 的子金鑰，避免跨
 * 原語金鑰重用、且換欄位金鑰時不會連帶讓全部盲索引失效。
 *
 * 空字串／`null`／`undefined` 輸入一律回 `null`（不是常數雜湊）——MAJOR-D7：
 * 若把 `blindIndex('')` 寫進 `UNIQUE` 欄位，多列空值會全部撞同一個雜湊，
 * MySQL 的 `UNIQUE` 卻允許多個 `NULL` 並存，故空值一律存 `NULL`。
 */
export function blindIndex(scope: string, plaintext: string | null | undefined): Buffer | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return null
  }
  const key = bidxKey()
  const subKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(scope, BIDX_INFO_ENCODING), KEY_LEN))
  return createHmac('sha256', subKey).update(plaintext, 'utf8').digest()
}
