import { randomBytes } from 'node:crypto'
import type { TechUser } from '../user-resolution/tech-user.ts'

// ops-ui 的瀏覽器 session（2026-09-08）：純記憶體、process 重啟即失效（技術
// 同事重新按一次 Telegram 登入即可，不落地任何可被撿走的 session 檔）。
// id 是 32 bytes 隨機 hex，只存在 HttpOnly cookie 裡；這裡不存任何 Telegram
// 個資以外的東西——TechUser 本來就是 tech-users.csv 內的公開名冊欄位。

export type OpsSession = {
  id: string
  chatId: string
  user: TechUser
  displayName: string
  createdAt: number
  expiresAt: number
}

export type SessionStore = {
  create: (chatId: string, user: TechUser, displayName: string) => OpsSession
  /** 過期的 session 在讀取時順手移除並回 null。 */
  get: (id: string) => OpsSession | null
  delete: (id: string) => void
  size: () => number
  ttlMs: number
}

export function createSessionStore(opts: { ttlMs: number; now?: () => number; randomId?: () => string }): SessionStore {
  const now = opts.now ?? (() => Date.now())
  const randomId = opts.randomId ?? (() => randomBytes(32).toString('hex'))
  const sessions = new Map<string, OpsSession>()

  // 每次 create 順手掃一次過期項，避免長時間沒人登出讓 map 無限成長
  //（技術人數個位數，線性掃描成本可忽略）。
  const sweep = () => {
    const t = now()
    for (const [id, s] of sessions) {
      if (s.expiresAt <= t) sessions.delete(id)
    }
  }

  return {
    ttlMs: opts.ttlMs,
    create(chatId, user, displayName) {
      sweep()
      const t = now()
      const session: OpsSession = { id: randomId(), chatId, user, displayName, createdAt: t, expiresAt: t + opts.ttlMs }
      sessions.set(session.id, session)
      return session
    },
    get(id) {
      const s = sessions.get(id)
      if (!s) return null
      if (s.expiresAt <= now()) {
        sessions.delete(id)
        return null
      }
      return s
    },
    delete(id) {
      sessions.delete(id)
    },
    size() {
      return sessions.size
    },
  }
}
