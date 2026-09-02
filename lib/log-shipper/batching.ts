// lib/log-shipper/batching.ts — 依 byte 數切批（§7.2 裁定 4(c)）。
//
// 軟目標 maxBytes/批（shipper.ts 用 1MB）；單行超過軟目標 → 該行自成一批。

export function batchByBytes<T>(items: T[], sizeOf: (item: T) => number, maxBytes: number): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let currentBytes = 0

  for (const item of items) {
    const bytes = sizeOf(item)
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += bytes
    // 單行本身就超過軟目標：不等下一個 item，立刻自成一批。
    if (currentBytes > maxBytes && current.length === 1) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
  }
  if (current.length > 0) batches.push(current)
  return batches
}
