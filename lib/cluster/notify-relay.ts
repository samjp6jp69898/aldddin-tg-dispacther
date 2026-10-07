// worker → head 的通知代發（2026-10-07）。
//
// 背景：chat_id 在 DB 是密文，解密金鑰 MON_FIELD_KEY_V1 依設計只放 head
// （doctor-worker.sh 會斷言 worker 不得有）。worker 上 tg-notify.sh 查得到名冊
// 卻解不開 chat_id，pipeline 收尾通知因此發不出去。這裡讓 worker 把「收件人
// ＋文字」交給 head，由 head 本機跑同一支 tg-notify.sh（有金鑰）代發。
// 金鑰與 chat_id 明碼都不離開 head；worker 只送收件人識別與訊息文字。
//
// 認證沿用 /cluster/* 同一組 guard（LAN-only + shared secret）。
import { execFile } from 'node:child_process'

const TG_NOTIFY_SH = '/Users/user/aladdin/aladdin_ai/scripts/tg-notify.sh'
const EXEC_TIMEOUT_MS = 30_000
const EMAIL_RE = /^[^\s,@]{1,128}@[^\s,@]{1,128}$/
const NOTION_IDS_RE = /^[A-Za-z0-9-]+( [A-Za-z0-9-]+)*$/
const MAX_TEXT = 4000

export interface NotifyRelayBody {
  email?: string
  notionUserIds?: string
  text?: string
  dryRun?: boolean
}

export type NotifyRunner = (args: string[]) => Promise<string>

const defaultRunner: NotifyRunner = args =>
  new Promise((resolve, reject) => {
    execFile(
      'bash',
      [TG_NOTIFY_SH, ...args],
      // TG_NO_RELAY：head 自己的 tg-notify.sh 解析失敗時不可再轉發（防迴圈）
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, env: { ...process.env, TG_NO_RELAY: '1' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })

/** 驗證 body 並代發；回傳 tg-notify.sh 的結果行。body 不合法回 null。 */
export async function relayNotify(body: NotifyRelayBody | null, run: NotifyRunner = defaultRunner): Promise<string | null> {
  if (!body || typeof body.text !== 'string' || body.text === '' || body.text.length > MAX_TEXT) return null
  const hasEmail = typeof body.email === 'string' && EMAIL_RE.test(body.email)
  const hasIds = typeof body.notionUserIds === 'string' && NOTION_IDS_RE.test(body.notionUserIds)
  if (!hasEmail && !hasIds) return null
  const args = hasEmail ? ['--email', body.email as string] : ['--notion-user-ids', body.notionUserIds as string]
  args.push('--text', body.text)
  if (body.dryRun === true) args.push('--dry-run')
  const out = await run(args)
  return out.trim().split('\n').pop() ?? ''
}
