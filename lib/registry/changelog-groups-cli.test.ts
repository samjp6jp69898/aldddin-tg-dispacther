import { describe, expect, test } from 'bun:test'
import { runChangelogGroupsCli, type ChangelogGroupDb, type CliDeps } from './changelog-groups-cli.ts'

// changelog 允許群組 CLI 的指令語意：以記憶體假 DB 模擬 changelog_allowed_groups，
// 只辨識本 CLI 實際會送的幾種 SQL 形狀；getChat 以注入函式控制。

type Row = { chat_id: string; title: string | null; enabled: number; created_by: string | null; updated_by: string | null; created_at: string; updated_at: string }

function memDb(): ChangelogGroupDb & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  return {
    rows,
    async query(sql: string, params: unknown[] = []) {
      const p = params.map(String)
      if (sql.startsWith('SELECT * FROM changelog_allowed_groups WHERE')) return [rows.has(p[0]!) ? [rows.get(p[0]!)] : [], []]
      if (sql.startsWith('SELECT * FROM changelog_allowed_groups ORDER')) return [[...rows.values()], []]
      if (sql.startsWith('INSERT')) {
        rows.set(p[0]!, { chat_id: p[0]!, title: p[1]!, enabled: 1, created_by: p[2]!, updated_by: p[3]!, created_at: 't', updated_at: 't' })
        return [{}, []]
      }
      if (sql.startsWith('UPDATE changelog_allowed_groups SET title')) {
        Object.assign(rows.get(p[2]!)!, { title: p[0], updated_by: p[1] })
        return [{}, []]
      }
      if (sql.startsWith('UPDATE changelog_allowed_groups SET enabled')) {
        Object.assign(rows.get(p[2]!)!, { enabled: Number(p[0]), updated_by: p[1] })
        return [{}, []]
      }
      if (sql.startsWith('DELETE')) {
        rows.delete(p[0]!)
        return [{}, []]
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
}

const GID = '-1001234567890'
const tgOk: CliDeps['getChatTitle'] = async () => ({ ok: true, title: '版本發布群' })
const tgFail: CliDeps['getChatTitle'] = async () => ({ ok: false, reason: 'Bad Request: chat not found' })

describe('changelog-groups-cli', () => {
  test('--add 從 Telegram 帶入群組名稱並啟用', async () => {
    const db = memDb()
    const r = await runChangelogGroupsCli(['--add', GID, '--by', 'tg-monitor'], { db, getChatTitle: tgOk })
    expect(r.exitCode).toBe(0)
    expect(r.out.titleSource).toBe('telegram')
    expect(db.rows.get(GID)).toMatchObject({ title: '版本發布群', enabled: 1, created_by: 'tg-monitor' })
  })

  test('--add getChat 失敗但有手填名稱 → 照手填新增；都沒有 → 拒絕', async () => {
    const db = memDb()
    const manual = await runChangelogGroupsCli(['--add', GID, '--title', '手填群'], { db, getChatTitle: tgFail })
    expect(manual.exitCode).toBe(0)
    expect(manual.out.titleSource).toBe('manual')
    expect(db.rows.get(GID)!.title).toBe('手填群')

    const none = await runChangelogGroupsCli(['--add', '-1009999999'], { db, getChatTitle: tgFail })
    expect(none.exitCode).toBe(1)
    expect(String(none.out.error)).toContain('chat not found')
    expect(db.rows.has('-1009999999')).toBe(false)
  })

  test('chat_id 格式驗證：正數、非數字、太短一律拒絕', async () => {
    const db = memDb()
    for (const bad of ['1001234567890', 'abc', '-12', '-100 OR 1=1', '']) {
      const r = await runChangelogGroupsCli(['--add', bad], { db, getChatTitle: tgOk })
      expect(r.exitCode).toBe(1)
    }
    expect(db.rows.size).toBe(0)
  })

  test('重複新增 → 拒絕', async () => {
    const db = memDb()
    await runChangelogGroupsCli(['--add', GID], { db, getChatTitle: tgOk })
    const again = await runChangelogGroupsCli(['--add', GID], { db, getChatTitle: tgOk })
    expect(again.exitCode).toBe(1)
  })

  test('--edit 手填名稱／--refresh-title 重抓；--set-enabled 停用再啟用；--delete 移除', async () => {
    const db = memDb()
    await runChangelogGroupsCli(['--add', GID], { db, getChatTitle: tgOk })

    expect((await runChangelogGroupsCli(['--edit', GID, '--title', '新名稱'], { db, getChatTitle: tgOk })).exitCode).toBe(0)
    expect(db.rows.get(GID)!.title).toBe('新名稱')
    expect((await runChangelogGroupsCli(['--edit', GID, '--refresh-title'], { db, getChatTitle: tgOk })).exitCode).toBe(0)
    expect(db.rows.get(GID)!.title).toBe('版本發布群')

    expect((await runChangelogGroupsCli(['--set-enabled', GID, '0'], { db, getChatTitle: tgOk })).exitCode).toBe(0)
    expect(db.rows.get(GID)!.enabled).toBe(0)
    expect((await runChangelogGroupsCli(['--set-enabled', GID, '1'], { db, getChatTitle: tgOk })).exitCode).toBe(0)
    expect(db.rows.get(GID)!.enabled).toBe(1)
    expect((await runChangelogGroupsCli(['--set-enabled', GID, 'yes'], { db, getChatTitle: tgOk })).exitCode).toBe(1)

    expect((await runChangelogGroupsCli(['--delete', GID], { db, getChatTitle: tgOk })).exitCode).toBe(0)
    expect(db.rows.has(GID)).toBe(false)
    expect((await runChangelogGroupsCli(['--delete', GID], { db, getChatTitle: tgOk })).exitCode).toBe(1)
  })

  test('--list 回傳 enabled 為布林', async () => {
    const db = memDb()
    await runChangelogGroupsCli(['--add', GID], { db, getChatTitle: tgOk })
    await runChangelogGroupsCli(['--set-enabled', GID, '0'], { db, getChatTitle: tgOk })
    const r = await runChangelogGroupsCli(['--list'], { db, getChatTitle: tgOk })
    expect(r.out.groups).toEqual([expect.objectContaining({ chat_id: GID, enabled: false, title: '版本發布群' })])
  })
})
