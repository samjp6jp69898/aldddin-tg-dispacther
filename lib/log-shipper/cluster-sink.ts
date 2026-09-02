// lib/log-shipper/cluster-sink.ts — ClusterSink（worker only）：POST 到 head 的
// log intake（本機 tunnel 127.0.0.1:9429 /cluster/logs）。
//
// body 形狀對齊 lib/log-shipper/intake-server.ts（唯讀，見該檔 LogLineIn 介面
// 與 POST /cluster/logs handler）：`{ worker, lines: LogLineIn[] }`，
// header `x-cluster-token`。
//
// 出入記錄（NOTES 亦記一份）：派工規格提到「每行帶 line_id ... 供 intake LRU
// 去重」，但讀過 intake-server.ts 後確認 line_id 是 intake 端自己用「驗證過的
// worker 名稱」+ 收到的 line.path/inode/offset 算出來的
// （intake-server.ts computeLineId(worker, line.path, line.inode, line.offset)，
// 見該檔 158-163 行），LogLineIn 介面本身沒有 lineId 欄位，isLogLineIn 也不
// 檢查它。因此本檔不在 wire payload 內夾帶 line_id——以 intake 現況為準，只要
// path/inode/offset 三者如實帶上，intake 端就能算出穩定一致的去重 key。
//
// 成功語意：res.ok（2xx）才算成功；429／其餘非 2xx／逾時／fetch 例外一律回
// false——不重試、不自旋、不 sleep。

import type { LogSink, ShipLine } from './types.ts'

export type FetchFn = typeof fetch

export interface ClusterSinkOptions {
  /** 已驗證的 worker 名稱（= MON_HOST，見 shipper.ts）；夾帶在 body.worker。 */
  worker: string
  clusterSecret: string
  baseUrl?: string
  fetchImpl?: FetchFn
  timeoutMs?: number
}

/** 對齊 intake-server.ts 的 LogLineIn 介面（wire 格式，camelCase）。 */
export interface ClusterSinkWireLine {
  path: string
  inode: number
  offset: number
  ts?: string
  content?: string
  truncated?: true
  origBytes?: number
  head4k?: string
  tail4k?: string
  ticket?: string | null
  runId?: string | null
  kind?: string | null
  source?: string
}

export function toWireLine(line: ShipLine): ClusterSinkWireLine {
  return {
    path: line.path,
    inode: line.inode,
    offset: line.offset,
    ts: line.ts,
    content: line.truncated ? undefined : line.content,
    truncated: line.truncated,
    origBytes: line.origBytes,
    head4k: line.head4k,
    tail4k: line.tail4k,
    ticket: line.ticket,
    runId: line.runId,
    kind: line.kind,
    source: line.source,
  }
}

export function createClusterSink(opts: ClusterSinkOptions): LogSink {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:9429').replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 5_000

  return {
    async send(batch: ShipLine[]): Promise<boolean> {
      if (batch.length === 0) return true
      const body = JSON.stringify({ worker: opts.worker, lines: batch.map(toWireLine) })
      try {
        const res = await fetchImpl(`${baseUrl}/cluster/logs`, {
          method: 'POST',
          headers: { 'x-cluster-token': opts.clusterSecret, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok
      } catch {
        return false
      }
    },
  }
}
