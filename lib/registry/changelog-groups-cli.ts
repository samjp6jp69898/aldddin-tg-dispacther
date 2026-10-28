// lib/registry/changelog-groups-cli.ts — changelog 允許群組（changelog_allowed_groups，migration 008）
// 的唯一寫入者。
//
// 由 head 本機的 tg-monitor dashboard（127.0.0.1:8799）spawn 呼叫，比照名冊的
// tech-users-sync.ts：tg-monitor 行程本身是 mon_ui（對這張表沒有權限），一律經
// telegram-dispatcher 這一個入口以 mon_head 讀寫。讀取端（changelog bot）見
// lib/webhook-server/changelog-group-allowlist.ts。
//
// 用法（輸出一律是單行 JSON：成功 {"ok":true,...}，失敗 {"ok":false,"error":"..."} 且 exit 1）：
//   --list
//   --add <chat_id> [--title <名稱>] [--by <來源>]
//   --edit <chat_id> [--title <名稱> | --refresh-title] [--by <來源>]
//   --set-enabled <chat_id> <0|1> [--by <來源>]
//   --delete <chat_id>
//
// 群組名稱：--add / --refresh-title 會用 aladdin operation bot 呼叫 Telegram getChat 帶入，
// 同時順便確認 bot 確實在這個群組裡（使用者 2026-10-28 定案）。getChat 失敗時，--add 有手填
// --title 就照手填的新增，沒有就拒絕。

import { readFileSync } from 'node:fs'
import { HEAD_ENV_FILE } from './env-load.ts'

export type ChangelogGroupDb = {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
}

export type CliDeps = {
  db: ChangelogGroupDb
  /** 回群組名稱；bot 不在群組、chat_id 錯、或打不到 Telegram 時回 { ok:false, reason }。 */
  getChatTitle: (chatId: string) => Promise<{ ok: true; title: string } | { ok: false; reason: string }>
}

export type CliResult = { exitCode: number; out: Record<string, unknown> }

export type ChangelogGroupRow = {
  chat_id: string
  title: string | null
  enabled: boolean
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

/** 群組 chat_id 一律是負數（supergroup 形如 -100xxxxxxxxxx）。 */
export const GROUP_CHAT_ID_RE = /^-\d{5,20}$/

const TITLE_MAX = 255

const fail = (error: string): CliResult => ({ exitCode: 1, out: { ok: false, error } })
const ok = (extra: Record<string, unknown> = {}): CliResult => ({ exitCode: 0, out: { ok: true, ...extra } })

type ParsedArgs = { cmd: string | null; pos: string[]; title?: string; by?: string; refreshTitle: boolean }

export function parseArgs(argv: string[]): ParsedArgs {
  const p: ParsedArgs = { cmd: null, pos: [], refreshTitle: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--title') p.title = argv[++i] ?? ''
    else if (a === '--by') p.by = argv[++i] ?? ''
    else if (a === '--refresh-title') p.refreshTitle = true
    else if (['--list', '--add', '--edit', '--set-enabled', '--delete'].includes(a)) p.cmd = a.slice(2)
    else p.pos.push(a)
  }
  return p
}

function toRow(r: Record<string, unknown>): ChangelogGroupRow {
  return {
    chat_id: String(r.chat_id),
    title: typeof r.title === 'string' ? r.title : null,
    enabled: Number(r.enabled) === 1,
    created_by: typeof r.created_by === 'string' ? r.created_by : null,
    updated_by: typeof r.updated_by === 'string' ? r.updated_by : null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }
}

async function findRow(db: ChangelogGroupDb, chatId: string): Promise<ChangelogGroupRow | null> {
  const [rows] = await db.query('SELECT * FROM changelog_allowed_groups WHERE chat_id = ?', [chatId])
  const list = rows as Record<string, unknown>[]
  return list.length > 0 ? toRow(list[0]!) : null
}

function cleanTitle(t: string | undefined): string | undefined {
  if (t === undefined) return undefined
  return t.trim().slice(0, TITLE_MAX)
}

export async function runChangelogGroupsCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const args = parseArgs(argv)
  const by = (args.by ?? '').trim().slice(0, 255) || null
  const title = cleanTitle(args.title)

  if (args.cmd === 'list') {
    const [rows] = await deps.db.query('SELECT * FROM changelog_allowed_groups ORDER BY created_at DESC')
    return ok({ groups: (rows as Record<string, unknown>[]).map(toRow) })
  }
  if (args.cmd === null) {
    return fail('usage: --list | --add <chat_id> [--title X] | --edit <chat_id> [--title X | --refresh-title] | --set-enabled <chat_id> <0|1> | --delete <chat_id>  [--by X]')
  }

  const chatId = (args.pos[0] ?? '').trim()
  if (!GROUP_CHAT_ID_RE.test(chatId)) return fail(`chat_id 格式錯誤：群組 id 必須是負數（如 -1001234567890），收到「${chatId}」`)

  switch (args.cmd) {
    case 'add': {
      if (await findRow(deps.db, chatId)) return fail(`群組 ${chatId} 已在清單中，請改用編輯／啟用`)
      const tg = await deps.getChatTitle(chatId)
      let finalTitle: string
      let titleSource: 'telegram' | 'manual'
      if (tg.ok) {
        finalTitle = tg.title.slice(0, TITLE_MAX)
        titleSource = 'telegram'
      } else if (title) {
        finalTitle = title
        titleSource = 'manual'
      } else {
        return fail(`無法從 Telegram 取得群組名稱（${tg.reason}）。請確認 bot 已在該群組、chat_id 正確；或手填名稱後再新增。`)
      }
      await deps.db.query(
        'INSERT INTO changelog_allowed_groups (chat_id, title, enabled, created_by, updated_by) VALUES (?, ?, 1, ?, ?)',
        [chatId, finalTitle, by, by],
      )
      return ok({ group: await findRow(deps.db, chatId), titleSource, telegramError: tg.ok ? null : tg.reason })
    }
    case 'edit': {
      if (!(await findRow(deps.db, chatId))) return fail(`群組 ${chatId} 不在清單中`)
      let newTitle: string
      if (args.refreshTitle) {
        const tg = await deps.getChatTitle(chatId)
        if (!tg.ok) return fail(`無法從 Telegram 取得群組名稱：${tg.reason}`)
        newTitle = tg.title.slice(0, TITLE_MAX)
      } else if (title) {
        newTitle = title
      } else {
        return fail('編輯需要 --title <名稱> 或 --refresh-title')
      }
      await deps.db.query('UPDATE changelog_allowed_groups SET title = ?, updated_by = ? WHERE chat_id = ?', [newTitle, by, chatId])
      return ok({ group: await findRow(deps.db, chatId) })
    }
    case 'set-enabled': {
      const flag = args.pos[1]
      if (flag !== '0' && flag !== '1') return fail('set-enabled 需要 0 或 1')
      if (!(await findRow(deps.db, chatId))) return fail(`群組 ${chatId} 不在清單中`)
      await deps.db.query('UPDATE changelog_allowed_groups SET enabled = ?, updated_by = ? WHERE chat_id = ?', [Number(flag), by, chatId])
      return ok({ group: await findRow(deps.db, chatId) })
    }
    case 'delete': {
      if (!(await findRow(deps.db, chatId))) return fail(`群組 ${chatId} 不在清單中`)
      await deps.db.query('DELETE FROM changelog_allowed_groups WHERE chat_id = ?', [chatId])
      return ok({ deleted: chatId })
    }
    default:
      return fail(`未知指令 ${args.cmd}`)
  }
}

/** 用 aladdin operation bot 的 getChat 取群組名稱。token 只從 head 的 .env 單 key 讀出。 */
export async function telegramGetChatTitle(chatId: string, token: string | null): Promise<{ ok: true; title: string } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: '.env 缺 TG_ALADDIN_OPERATION_BOT_TOKEN' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json()) as { ok?: boolean; description?: string; result?: { title?: string; type?: string } }
    if (!body.ok) return { ok: false, reason: body.description ?? `HTTP ${res.status}` }
    if (body.result?.type !== 'group' && body.result?.type !== 'supergroup') return { ok: false, reason: `這個 chat 不是群組（type=${body.result?.type}）` }
    return { ok: true, title: body.result.title ?? '' }
  } catch (err) {
    // 錯誤訊息可能夾帶含 token 的 URL，輸出前遮掉（結果會一路回到 dashboard 畫面）。
    return { ok: false, reason: `呼叫 Telegram 失敗：${(err instanceof Error ? err.message : String(err)).replaceAll(token, '***')}` }
  }
}

function readOperationBotToken(): string | null {
  if (process.env.TG_ALADDIN_OPERATION_BOT_TOKEN) return process.env.TG_ALADDIN_OPERATION_BOT_TOKEN
  try {
    const m = readFileSync(HEAD_ENV_FILE, 'utf8').match(/^TG_ALADDIN_OPERATION_BOT_TOKEN=(.*)$/m)
    return m ? m[1]!.replace(/[\r\n]/g, '') || null : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const { loadRegistryEnv } = await import('./env-load.ts')
  loadRegistryEnv()
  const { createMonitorPool } = await import('../monitor-db/pool.ts')
  // 只在 head 跑（tg-monitor 本機 spawn），固定 mon_head。
  const pool = createMonitorPool('mon_head', { connectionLimit: 1 })
  const token = readOperationBotToken()
  let result: CliResult
  try {
    result = await runChangelogGroupsCli(process.argv.slice(2), {
      db: { query: (sql, params) => pool.query(sql, params) as Promise<[unknown, unknown]> },
      getChatTitle: chatId => telegramGetChatTitle(chatId, token),
    })
  } catch (err) {
    result = fail(`DB 操作失敗：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await pool.end()
  }
  console.log(JSON.stringify(result.out))
  process.exitCode = result.exitCode
}

if (import.meta.main) {
  await main()
}
