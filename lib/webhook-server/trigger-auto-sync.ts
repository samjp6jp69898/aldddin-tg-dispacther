import { join } from 'node:path'
import { spawnDetachedProcess } from '../pipeline-runner/spawn-create-mr.ts'

// 收到「第一次見過」的白名單外私聊訊息時，fire-and-forget 觸發
// obsidian/scripts/tg-auto-sync.sh：HIGH confidence 自動寫回 tech-users.csv、
// ASK confidence 通知維運者手動用 /tg-chatid-sync 決定（該腳本自己的邏輯與
// 紀律見其檔頭註解）。複用 spawn-create-mr.ts 的 spawnDetachedProcess——同一
// 套 detached+unref／stdout-stderr 落地 log／'error' event 防炸 server 的
// 保護，不重新發明一遍。
const AUTO_SYNC_SH = '/Users/user/aladdin/obsidian/scripts/tg-auto-sync.sh'
const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'

export function triggerTgAutoSync(): void {
  spawnDetachedProcess('bash', [AUTO_SYNC_SH], {
    cwd: '/Users/user/aladdin',
    stdoutPath: join(LOG_DIR, 'tg-auto-sync-trigger.stdout.log'),
    stderrPath: join(LOG_DIR, 'tg-auto-sync-trigger.stderr.log'),
  })
}
