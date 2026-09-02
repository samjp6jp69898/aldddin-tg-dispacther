import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { blindIndex, encryptField, isEncrypted, keyFingerprint } from './field-crypto.ts'
import { decryptField } from './roster-decrypt.ts'

// 測試一律用當場產生的拋棄式合成金鑰塞進 process.env，絕不讀取／記錄真正的
// production 金鑰或明文——符合「測試不得把金鑰或明文寫進任何持久檔」的要求。
const ORIG_FIELD_KEY = process.env.MON_FIELD_KEY_V1
const ORIG_BIDX_KEY = process.env.MON_BIDX_KEY

function freshKey(): string {
  return randomBytes(32).toString('base64')
}

beforeEach(() => {
  process.env.MON_FIELD_KEY_V1 = freshKey()
  process.env.MON_BIDX_KEY = freshKey()
})

afterEach(() => {
  if (ORIG_FIELD_KEY === undefined) delete process.env.MON_FIELD_KEY_V1
  else process.env.MON_FIELD_KEY_V1 = ORIG_FIELD_KEY
  if (ORIG_BIDX_KEY === undefined) delete process.env.MON_BIDX_KEY
  else process.env.MON_BIDX_KEY = ORIG_BIDX_KEY
})

describe('encryptField / decryptField 往返', () => {
  test('同一 ctx 加解密回原文', () => {
    const ctx = 'mcp_tokens.token_enc:tok_abc123'
    const plaintext = 'sk-live-secret-token-value'
    const enc = encryptField(ctx, plaintext)
    expect(enc.startsWith('enc:v1:')).toBe(true)
    expect(decryptField(ctx, enc)).toBe(plaintext)
  })

  test('空字串明文可加解密往返', () => {
    const ctx = 'tech_users.tg_chat_id_enc:a@b.tw'
    const enc = encryptField(ctx, '')
    expect(decryptField(ctx, enc)).toBe('')
  })

  test('中文與多位元組字元往返不失真', () => {
    const ctx = 'tg_unknown_senders.sender_profile_enc:deadbeef'
    const plaintext = '使用者暱稱 🎉 with emoji and 中文'
    const enc = encryptField(ctx, plaintext)
    expect(decryptField(ctx, enc)).toBe(plaintext)
  })

  test('nonce 唯一性：同明文同 ctx 連續加密兩次，密文（含 iv）不同', () => {
    const ctx = 'mcp_tokens.token_enc:tok_same'
    const plaintext = 'identical-plaintext'
    const enc1 = encryptField(ctx, plaintext)
    const enc2 = encryptField(ctx, plaintext)
    expect(enc1).not.toBe(enc2)
    // 兩次的 iv12 前綴（base64url 解碼後的前 12 bytes）必須不同，
    // 抽 20 次確認沒有明顯的重複（nonce 碰撞的間接證據）。
    const ivs = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const enc = encryptField(ctx, plaintext)
      const payload = Buffer.from(enc.slice('enc:v1:'.length), 'base64url')
      ivs.add(payload.subarray(0, 12).toString('hex'))
    }
    expect(ivs.size).toBe(20)
  })

  test('竄改偵測：翻轉密文一個 byte 必須被 GCM tag 擋下（丟例外）', () => {
    const ctx = 'mcp_tokens.token_enc:tok_tamper'
    const enc = encryptField(ctx, 'do-not-tamper-with-me')
    const payload = Buffer.from(enc.slice('enc:v1:'.length), 'base64url')
    // 翻轉 ciphertext 區段（iv 之後、tag 之前）的第一個 byte。
    payload[12] = payload[12] ^ 0xff
    const tampered = 'enc:v1:' + payload.toString('base64url')
    expect(() => decryptField(ctx, tampered)).toThrow()
  })

  test('竄改偵測：翻轉 auth tag 必須被擋下（丟例外）', () => {
    const ctx = 'mcp_tokens.token_enc:tok_tamper2'
    const enc = encryptField(ctx, 'another-secret')
    const payload = Buffer.from(enc.slice('enc:v1:'.length), 'base64url')
    payload[payload.length - 1] = payload[payload.length - 1] ^ 0xff
    const tampered = 'enc:v1:' + payload.toString('base64url')
    expect(() => decryptField(ctx, tampered)).toThrow()
  })

  test('AAD 綁定：用不同 ctx 解密必須丟例外（密文不能搬到另一列/另一欄）', () => {
    const encCtx = 'mcp_tokens.token_enc:tok_row_1'
    const wrongCtx = 'mcp_tokens.token_enc:tok_row_2'
    const enc = encryptField(encCtx, 'row-scoped-secret')
    expect(() => decryptField(wrongCtx, enc)).toThrow()
  })

  test('缺 enc:v1: 前綴 → decryptField 丟例外（不回退明文）', () => {
    expect(() => decryptField('any.ctx:x', 'plain-old-value')).toThrow()
    expect(() => decryptField('any.ctx:x', '')).toThrow()
  })

  test('未知版本前綴 → decryptField 丟例外', () => {
    expect(() => decryptField('any.ctx:x', 'enc:v2:AAAAAAAAAAAAAAAAAAAA')).toThrow()
    expect(() => decryptField('any.ctx:x', 'enc:v0:AAAAAAAAAAAAAAAAAAAA')).toThrow()
  })
})

describe('isEncrypted', () => {
  test('已加密值回 true', () => {
    const enc = encryptField('t.c:k', 'x')
    expect(isEncrypted(enc)).toBe(true)
  })

  test('明文／未知格式／null/undefined 回 false', () => {
    expect(isEncrypted('plain-token-value')).toBe(false)
    expect(isEncrypted('enc:v2:xxx')).toBe(false)
    expect(isEncrypted(null)).toBe(false)
    expect(isEncrypted(undefined)).toBe(false)
    expect(isEncrypted('')).toBe(false)
  })
})

describe('keyFingerprint', () => {
  test('回傳 8 字元 hex，且不等於金鑰本身的前 8 hex（不洩漏金鑰）', () => {
    const fp = keyFingerprint()
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    const rawKeyHexPrefix = Buffer.from(process.env.MON_FIELD_KEY_V1!, 'base64').toString('hex').slice(0, 8)
    expect(fp).not.toBe(rawKeyHexPrefix)
  })

  test('同金鑰兩次呼叫結果一致', () => {
    expect(keyFingerprint()).toBe(keyFingerprint())
  })
})

describe('blindIndex', () => {
  test('空字串／null／undefined 一律回 null', () => {
    expect(blindIndex('tech_users.tg_chat_id', '')).toBeNull()
    expect(blindIndex('tech_users.tg_chat_id', null)).toBeNull()
    expect(blindIndex('tech_users.tg_chat_id', undefined)).toBeNull()
  })

  test('同 scope 同明文 → 相同索引值（等值查詢可行）', () => {
    const a = blindIndex('tech_users.tg_chat_id', '123456789')
    const b = blindIndex('tech_users.tg_chat_id', '123456789')
    expect(a).not.toBeNull()
    expect(a!.equals(b!)).toBe(true)
  })

  test('同明文不同 scope → 不同索引值（scope 隔離）', () => {
    const a = blindIndex('tech_users.tg_chat_id', '123456789')
    const b = blindIndex('tg_unknown_senders.chat_id', '123456789')
    expect(a!.equals(b!)).toBe(false)
  })

  test('不同明文同 scope → 不同索引值', () => {
    const a = blindIndex('tech_users.tg_chat_id', '111')
    const b = blindIndex('tech_users.tg_chat_id', '222')
    expect(a!.equals(b!)).toBe(false)
  })

  test('輸出為 32 bytes（供 BINARY(32) 欄位）', () => {
    const v = blindIndex('tech_users.tg_chat_id', 'x')
    expect(v!.length).toBe(32)
  })
})

describe('金鑰缺失時的 fail-loud 行為', () => {
  test('MON_FIELD_KEY_V1 缺失 → encryptField 丟例外', () => {
    delete process.env.MON_FIELD_KEY_V1
    expect(() => encryptField('t.c:k', 'x')).toThrow()
  })

  test('MON_FIELD_KEY_V1 缺失 → decryptField 丟例外', () => {
    const enc = encryptField('t.c:k', 'x')
    delete process.env.MON_FIELD_KEY_V1
    expect(() => decryptField('t.c:k', enc)).toThrow()
  })

  test('MON_FIELD_KEY_V1 缺失 → keyFingerprint 丟例外', () => {
    delete process.env.MON_FIELD_KEY_V1
    expect(() => keyFingerprint()).toThrow()
  })

  test('MON_BIDX_KEY 缺失 → blindIndex(非空值) 丟例外', () => {
    delete process.env.MON_BIDX_KEY
    expect(() => blindIndex('t.c', 'nonempty')).toThrow()
  })

  test('MON_BIDX_KEY 缺失但明文為空 → 仍回 null（不觸碰金鑰）', () => {
    delete process.env.MON_BIDX_KEY
    expect(blindIndex('t.c', '')).toBeNull()
  })

  test('金鑰不是合法 base64/長度不對 → 丟例外', () => {
    process.env.MON_FIELD_KEY_V1 = 'not-32-bytes'
    expect(() => encryptField('t.c:k', 'x')).toThrow()
  })
})
