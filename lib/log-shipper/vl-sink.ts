// lib/log-shipper/vl-sink.ts — VLDirectSink（head only）：直寫 VictoriaLogs 9428。
//
// 見 plan §7.4：POST ${MON_VL_URL}/insert/jsonline，Basic Auth，每行 JSON 含
// _time、_msg 與 stream fields（host, source, ticket, run_id, kind）。格式對齊
// lib/log-shipper/intake-server.ts 的 forwardToVictoriaLogs 與
// deploy/monitor-db/backfill/backfill-logs-vl.ts 的 buildEntry/postBatch
// （皆唯讀參考，未 import——那兩份是各自檔案所有權範圍內的既有實作）。
//
// 成功語意：res.ok（2xx）才算成功；任何非 2xx、逾時、fetch 例外一律回
// false——不重試、不自旋、不 sleep（呼叫端 shipper.ts 據此結束本輪）。

import type { LogSink, ShipLine } from './types.ts'

export type FetchFn = typeof fetch

export interface VLDirectSinkOptions {
  vlUrl: string
  vlUser: string
  vlPassword: string
  fetchImpl?: FetchFn
  timeoutMs?: number
}

function buildVlMsg(line: ShipLine): string {
  if (line.truncated) {
    return JSON.stringify({
      truncated: true,
      orig_bytes: line.origBytes ?? null,
      head_4k: line.head4k ?? '',
      tail_4k: line.tail4k ?? '',
      file: line.path,
      offset: line.offset,
      host: line.host,
    })
  }
  return line.content ?? ''
}

export function createVLDirectSink(opts: VLDirectSinkOptions): LogSink {
  const vlUrl = opts.vlUrl.replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 5_000

  return {
    async send(batch: ShipLine[]): Promise<boolean> {
      if (batch.length === 0) return true
      const ndjson = batch
        .map(line =>
          JSON.stringify({
            _msg: buildVlMsg(line),
            _time: line.ts,
            host: line.host,
            source: line.source,
            ticket: line.ticket ?? '',
            run_id: line.runId ?? '',
            kind: line.kind ?? '',
            path: line.path,
          }),
        )
        .join('\n')
      try {
        const auth = Buffer.from(`${opts.vlUser}:${opts.vlPassword}`).toString('base64')
        const res = await fetchImpl(`${vlUrl}/insert/jsonline?_stream_fields=host,source,ticket,run_id,kind`, {
          method: 'POST',
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/stream+json' },
          body: ndjson,
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok
      } catch {
        return false
      }
    },
  }
}
