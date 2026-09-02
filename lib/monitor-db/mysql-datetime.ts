// lib/monitor-db/mysql-datetime.ts — ISO 8601（UTC）字串 ↔ MySQL DATETIME(3) 字面字串。
//
// 【重要，S7 語意驗證中發現】：pool.ts 用 `dateStrings: ['DATE','DATETIME']`
// （為了避免 JS Date 物件在毫秒精度與時區上的損耗，讓時間欄一律以字串原樣往返，
// 見 plan §6.2.1 S7 的原始動機）。這個選項只影響「讀出」的格式（server 回什麼
// 字串就原樣給），**不會**讓「寫入」時自動接受 ISO 8601 格式——本輪對真實
// mon-mysql 實測證實：直接把 `'2026-08-26T03:23:44.751Z'`（帶 `T`/`Z`）當參數
// 綁定到 DATETIME(3) 欄位，MySQL 回 `ER_TRUNCATED_WRONG_VALUE`（`Incorrect
// datetime value`），連寫入都進不去，不是「格式對不上」的軟性落差。
//
// 因此 writes.ts 的所有 datetime 型參數（`startedAt`/`finishedAt`/
// `cancelRequestedAt`/`ts` 等）在呼叫端仍維持「一律傳絕對 ISO 字串」
// （§6.5(a) 的硬規則要求），由本檔在 SQL 邊界做轉換：寫入前 ISO → MySQL 字面字串，
// 讀出後 MySQL 字面字串 → ISO（目前 writes.ts 的 SELECT 都不讀 datetime 欄，
// 這支主要供未來讀取端或測試使用）。

const ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/
const MYSQL_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/

/** `'2026-08-26T03:23:44.751Z'` → `'2026-08-26 03:23:44.751'`（server 以 +00:00 存 UTC，見 §2.1）。 */
export function isoToMysqlDatetime3(iso: string): string {
  const m = ISO_UTC_RE.exec(iso)
  if (!m) {
    throw new Error(`isoToMysqlDatetime3: 不是合法的 UTC ISO 字串（必須以 'Z' 結尾）：${iso}`)
  }
  const ms = (m[3] ?? '000').padEnd(3, '0').slice(0, 3)
  return `${m[1]} ${m[2]}.${ms}`
}

/** `'2026-08-26 03:23:44.751'` → `'2026-08-26T03:23:44.751Z'`。 */
export function mysqlDatetimeToIso(value: string): string {
  const m = MYSQL_DATETIME_RE.exec(value.trim())
  if (!m) {
    throw new Error(`mysqlDatetimeToIso: 不是預期的 MySQL DATETIME 字串：${value}`)
  }
  const ms = (m[3] ?? '000').padEnd(3, '0').slice(0, 3)
  return `${m[1]}T${m[2]}.${ms}Z`
}

/** null-safe 版本：常用於選填的 datetime 參數。 */
export function isoToMysqlDatetime3OrNull(iso: string | null | undefined): string | null {
  return iso == null ? null : isoToMysqlDatetime3(iso)
}
