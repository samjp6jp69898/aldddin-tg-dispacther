import { describe, expect, test } from 'bun:test'
import {
  ARTIFACT_HOST_FROM_STAGES_SQL,
  ARTIFACT_HOST_FROM_SYNC_SQL,
  PENDING_ARTIFACT_PULL_SQL,
  SSH_TRANSPORT,
  analysisNotesPath,
  buildRsyncArgs,
  headHasArtifacts,
  isSyncableTicket,
  queryArtifactHost,
  queryPendingArtifactPulls,
  retryPendingArtifactPulls,
  ticketDebugDir,
  workerHost,
} from './artifact-sync.ts'
import type { WorkerInfo } from './worker-registry.ts'

const DEBUG = '/Users/user/aladdin/obsidian/Debug'

function worker(name: string, url = 'http://10.0.0.5:8801'): WorkerInfo {
  return { name, url, registeredAt: 'x', disabled: false }
}

/** 假 executor：依 SQL 回不同結果，並記錄綁定參數。 */
function fakePool(rowsBySql: Record<string, unknown[]>) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    pool: {
      async execute<T>(sql: string, params?: unknown[]): Promise<[T, unknown]> {
        calls.push({ sql, params: params ?? [] })
        return [(rowsBySql[sql] ?? []) as T, null]
      },
    },
  }
}

describe('artifact-sync — ticket 驗證（只同步 FAQ- 票）', () => {
  test('只接受 FAQ-<數字>；demand、路徑穿越、空值、非字串一律拒絕', () => {
    expect(isSyncableTicket('FAQ-4768')).toBe(true)
    expect(isSyncableTicket('ALDREQ-9')).toBe(false)
    expect(isSyncableTicket('FAQ-1/../../etc')).toBe(false)
    expect(isSyncableTicket('FAQ-1;rm -rf /')).toBe(false)
    expect(isSyncableTicket('FAQ-')).toBe(false)
    expect(isSyncableTicket('')).toBe(false)
    expect(isSyncableTicket(null)).toBe(false)
    expect(isSyncableTicket(42)).toBe(false)
  })

  test('headHasArtifacts 對不合法 ticket 直接 false（不碰檔案系統）', () => {
    expect(headHasArtifacts('ALDREQ-9')).toBe(false)
    expect(headHasArtifacts('../../etc/passwd')).toBe(false)
  })

  test('路徑組裝固定在 obsidian/Debug 之下', () => {
    expect(ticketDebugDir('FAQ-1')).toBe(`${DEBUG}/FAQ-1`)
    expect(analysisNotesPath('FAQ-1')).toBe(`${DEBUG}/FAQ-1/FAQ-1-analysis-notes.md`)
  })
})

describe('artifact-sync — worker.url 抽 host', () => {
  test('一般 LAN 位址與主機名', () => {
    expect(workerHost('http://10.0.0.5:8801')).toBe('10.0.0.5')
    expect(workerHost('http://landon2.local:8801')).toBe('landon2.local')
    expect(workerHost('https://worker-2:8801/')).toBe('worker-2')
  })

  test('不合法/危險形狀一律 null（IPv6 中括號、非 URL、空字串）', () => {
    expect(workerHost('http://[::1]:8801')).toBe(null)
    expect(workerHost('not a url')).toBe(null)
    expect(workerHost('')).toBe(null)
  })
})

describe('artifact-sync — rsync argv（不經 shell，不做字串拼接）', () => {
  test('pull：遠端在前、本機在後，兩端都以 / 結尾', () => {
    expect(buildRsyncArgs('pull', '10.0.0.5', 'FAQ-1')).toEqual([
      '-az',
      '-e',
      SSH_TRANSPORT,
      `user@10.0.0.5:${DEBUG}/FAQ-1/`,
      `${DEBUG}/FAQ-1/`,
    ])
  })

  test('push：本機在前、遠端在後', () => {
    expect(buildRsyncArgs('push', '10.0.0.5', 'FAQ-1')).toEqual([
      '-az',
      '-e',
      SSH_TRANSPORT,
      `${DEBUG}/FAQ-1/`,
      `user@10.0.0.5:${DEBUG}/FAQ-1/`,
    ])
  })

  test('-e 的值是單一 argv 元素（rsync 自己解析成 ssh 命令），與 sync-workers.sh 同一組參數', () => {
    const args = buildRsyncArgs('pull', '10.0.0.5', 'FAQ-1')
    expect(args[1]).toBe('-e')
    expect(args[2]).toBe('ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new')
    // 沒有任何一個元素是「整條命令列」——argv 陣列本身就是不經 shell 的證據。
    expect(args.some(a => a.includes('&&') || a.includes('|') || a.includes(';'))).toBe(false)
  })
})

describe('artifact-sync — 產物所在機器查詢（§4.3 A2）', () => {
  test('優先取 ticket_artifact_sync.source_host', async () => {
    const f = fakePool({ [ARTIFACT_HOST_FROM_SYNC_SQL]: [{ source_host: 'landon2' }] })
    expect(await queryArtifactHost(f.pool, 'FAQ-1', 'head')).toBe('landon2')
    expect(f.calls.map(c => c.sql)).toEqual([ARTIFACT_HOST_FROM_SYNC_SQL]) // 不必再查 stages
  })

  test('sync 表沒有時退 ticket_stages 最新一列的 host', async () => {
    const f = fakePool({ [ARTIFACT_HOST_FROM_SYNC_SQL]: [], [ARTIFACT_HOST_FROM_STAGES_SQL]: [{ host: 'landon3' }] })
    expect(await queryArtifactHost(f.pool, 'FAQ-1', 'head')).toBe('landon3')
    expect(f.calls.map(c => c.sql)).toEqual([ARTIFACT_HOST_FROM_SYNC_SQL, ARTIFACT_HOST_FROM_STAGES_SQL])
    expect(f.calls[0]!.params).toEqual(['FAQ-1'])
  })

  test('查到的是 head 自己 → null（紀錄過時，視同查無，走從頭分析）', async () => {
    const f = fakePool({ [ARTIFACT_HOST_FROM_SYNC_SQL]: [{ source_host: 'head' }] })
    expect(await queryArtifactHost(f.pool, 'FAQ-1', 'head')).toBe(null)
  })

  test('兩張表都沒有 → null；不合法 ticket 連查都不查', async () => {
    const empty = fakePool({})
    expect(await queryArtifactHost(empty.pool, 'FAQ-1', 'head')).toBe(null)
    const bad = fakePool({})
    expect(await queryArtifactHost(bad.pool, 'ALDREQ-9', 'head')).toBe(null)
    expect(bad.calls).toEqual([])
  })
})

describe('artifact-sync — 待重試清單與重試迴圈（§4.1）', () => {
  test('查詢帶 MySQL DATETIME(3) 字面字串（不是 ISO），並濾掉不合法的列', async () => {
    const f = fakePool({
      [PENDING_ARTIFACT_PULL_SQL]: [
        { ticket: 'FAQ-1', source_host: 'landon2' },
        { ticket: 'ALDREQ-9', source_host: 'landon2' }, // demand：不在範圍
        { ticket: 'FAQ-2', source_host: '' }, // 沒有來源機器：無從拉起
      ],
    })
    const rows = await queryPendingArtifactPulls(f.pool, '2026-09-08T01:02:03.456Z')
    expect(rows).toEqual([{ ticket: 'FAQ-1', sourceHost: 'landon2' }])
    const param = String(f.calls[0]!.params[0])
    expect(param).not.toContain('T')
    expect(param).not.toContain('Z')
    expect(param).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  test('DB 關閉（pool=null）：整段 no-op，回 0', async () => {
    expect(await retryPendingArtifactPulls({ pool: null, listWorkers: () => [worker('landon2')] })).toBe(0)
  })

  test('只對仍在名冊的來源機器重試；找不到的那張這輪跳過', async () => {
    const f = fakePool({
      [PENDING_ARTIFACT_PULL_SQL]: [
        { ticket: 'FAQ-1', source_host: 'landon2' },
        { ticket: 'FAQ-2', source_host: '已退役' },
      ],
    })
    const pulled: string[] = []
    const n = await retryPendingArtifactPulls({
      pool: f.pool,
      listWorkers: () => [worker('landon2')],
      pull: async (w, ticket) => {
        pulled.push(`${w.name}:${ticket}`)
        return { ok: true, fileCount: 3 }
      },
    })
    expect(n).toBe(1)
    expect(pulled).toEqual(['landon2:FAQ-1'])
  })

  test('拉取本身失敗不會中斷整輪（下一張照樣試），也不拋例外', async () => {
    const f = fakePool({
      [PENDING_ARTIFACT_PULL_SQL]: [
        { ticket: 'FAQ-1', source_host: 'landon2' },
        { ticket: 'FAQ-2', source_host: 'landon2' },
      ],
    })
    const pulled: string[] = []
    const n = await retryPendingArtifactPulls({
      pool: f.pool,
      listWorkers: () => [worker('landon2')],
      pull: async (_w, ticket) => {
        pulled.push(ticket)
        return { ok: false, error: 'rsync 逾時被中止' }
      },
    })
    expect(n).toBe(2)
    expect(pulled).toEqual(['FAQ-1', 'FAQ-2'])
  })

  test('查詢丟例外：吞掉回 0（下一輪 sweep 再試），不讓 sweeper 掛掉', async () => {
    const throwing = {
      async execute<T>(): Promise<[T, unknown]> {
        throw new Error('mon-mysql 連不上')
      },
    }
    expect(await retryPendingArtifactPulls({ pool: throwing, listWorkers: () => [worker('landon2')] })).toBe(0)
  })
})
