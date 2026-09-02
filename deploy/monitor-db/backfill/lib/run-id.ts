// backfill/lib/run-id.ts — 回填 run_id 派生（plan §11.2）。
//
// 「以舊 key（<ticket>.<ISO毫秒>）做確定性 UUIDv5 → 可重跑、可對數」。
// namespace 是本案自訂的固定常數（回填的確定性只要求「同一 legacy_key 永遠
// 派生同一 run_id」，namespace 本身取值任意，但一旦定案不得再改——改了等於
// 全部回填列換 PK，重跑就會產生重複列）。

import { createHash } from 'node:crypto'

/** 固定 namespace（2026-09-02 定案，不得變更）。 */
export const BACKFILL_RUN_ID_NAMESPACE = '3e0aa7d4-19c5-4b31-9c8a-6f2d5e8b71c9'

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** RFC 4122 UUIDv5（SHA-1）。 */
export function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6]! & 0x0f) | 0x50 // version 5
  b[8] = (b[8]! & 0x3f) | 0x80 // variant RFC 4122
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 由 sqlite pipeline_runs.key（`<ticket>.<ISO毫秒>`，即 stdout log 檔 base 名）
 * 派生回填列的 run_id；同一 key 重跑必得同一 UUID（冪等的前提）。
 * legacy_key 欄另存原字串（§10.2 對位鍵），不由本函式處理。
 */
export function deriveRunId(legacyKey: string): string {
  return uuidV5(BACKFILL_RUN_ID_NAMESPACE, legacyKey)
}
