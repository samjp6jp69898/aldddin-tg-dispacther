/**
 * kit-resend.ts — 重發某企劃的 starter kit：重簽（rotate）指定環境的 token、
 * 打包 dist/<id>/、把 zip + 使用說明直送 kit 管理者（TG_KIT_ADMIN_CHAT_ID，
 * 即 Landon）的 Telegram，由他轉交企劃。
 *
 * 供 tg-monitor「Token 權限」頁的「重發 token」按鈕經行程邊界呼叫（比照
 * spawn-create-mr.ts 的 CLI 模式：monitor 不 import dispatcher 內部模組，
 * 介面只有 argv + stdout + exit code）：
 *
 *   bun kit-resend.ts --id <id> --name <顯示名> --grants <env1,env2|all>            # 重發：rotate 後交付
 *   bun kit-resend.ts --fresh --id <id> --name <顯示名> --grants <env1,env2|all>    # 新核發：不 rotate，id 已存在會被 make-starter-kit 拒絕
 *   bun kit-resend.ts --rebuild --id <id> --name <顯示名>                           # 純重建：不核發/重簽任何 kit 環境，只重新打包既有 .mcp.json（例如 toolsmith 名冊剛核發/重簽了新 token，要併進這個人已有的 kit）
 *
 * 簽發邏輯完全交給 runKitScript（包裝 make-starter-kit.ts，理由見
 * spawn_kit_script.ts 檔頭）；發送統一走 scripts/tg-notify.sh（bot token 由
 * 它自己從根目錄 .env 讀，這裡只讀 TG_KIT_ADMIN_CHAT_ID，不碰 token）；
 * 使用說明文字 import kit-issue.ts 的 buildKitUsageText/readDistAliases，
 * 不另抄一份——標籤一律依實際寫進 .mcp.json 的別名反推，不是這次請求了
 * 什麼環境（--rebuild 完全不請求任何環境，也要能組出正確的標籤清單）。
 *
 * 注意：--rotate 語意=指定環境全部換新 token，舊 token 即刻失效（名冊
 * fail-closed 現讀檔案）——這正是「重發」要的效果，呼叫端 UI 必須先向
 * 操作者確認過才呼叫。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { runKitScript } from '/Users/user/aladdin/obsidian/mcps/aladdin-kit-admin/src/spawn_kit_script.ts'
import { buildKitUsageText, readDistAliases } from './kit-issue.ts'

const KIT_DIST_DIR = '/Users/user/aladdin/obsidian/mcps/aladdin-ai-assistant-kit/dist'
// 2026-08-31：obsidian/scripts/ 已被拆分掉、tg-notify.sh 實際搬到 aladdin_ai/scripts/。
const TG_NOTIFY_SCRIPT = '/Users/user/aladdin/aladdin_ai/scripts/tg-notify.sh'
const ROOT_ENV_FILE = '/Users/user/aladdin/telegram-dispatcher/.env'

/** 從 telegram-dispatcher/.env 讀 TG_KIT_ADMIN_CHAT_ID（2026-08-31 前是根目錄 .env；比照 tg-notify.sh 對 token 的手法），不寫死。 */
function readKitAdminChatId(): string {
  const line = readFileSync(ROOT_ENV_FILE, 'utf8').split('\n').find(l => l.startsWith('TG_KIT_ADMIN_CHAT_ID='))
  const v = line ? line.slice('TG_KIT_ADMIN_CHAT_ID='.length).trim() : ''
  if (!v) throw new Error(`.env 缺 TG_KIT_ADMIN_CHAT_ID（${ROOT_ENV_FILE}）`)
  return v
}

/** tg-notify.sh 紀律是一律 exit 0、結果印一行，成功與否要看輸出是否為 TG_SENT。 */
function sendViaTgNotify(args: string[]): string {
  const out = execFileSync('bash', [TG_NOTIFY_SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 }).trim()
  if (!out.startsWith('TG_SENT')) throw new Error(`tg-notify.sh 發送失敗：${out}`)
  return out
}

function main(): void {
  const { values } = parseArgs({
    options: {
      id: { type: 'string' },
      name: { type: 'string' },
      grants: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
    },
  })
  const { id, name, grants } = values
  const fresh = values.fresh === true
  const rebuild = values.rebuild === true
  if (!id || !name || (!grants && !rebuild)) {
    console.error('用法：bun kit-resend.ts [--fresh] --id <id> --name <顯示名> --grants <env1,env2|all>')
    console.error('      bun kit-resend.ts --rebuild --id <id> --name <顯示名>   # 不核發/重簽任何 kit 環境，只重新打包既有的 .mcp.json（例如撈最新 toolsmith token）')
    process.exit(1)
  }

  const chatId = readKitAdminChatId()

  const result = runKitScript(
    rebuild ? ['--rebuild', '--id', id]
    : fresh ? ['--id', id, '--name', name, '--grants', grants!]
    : ['--id', id, '--name', name, '--grants', grants!, '--rotate'])
  if (!result.success) {
    console.error(result.stderr || `${rebuild ? '重建' : fresh ? '核發' : '重簽'}失敗（腳本無輸出，僅回傳非 0 exit code）`)
    process.exit(1)
  }
  console.log(result.stdout.trim())

  const distDir = join(KIT_DIST_DIR, id)
  if (!existsSync(distDir)) {
    console.error(`${rebuild ? '重建' : '重簽'}似乎成功但找不到輸出目錄：${distDir}，未打包傳送`)
    process.exit(1)
  }

  // 打包成 zip 再傳送：workDir 是獨立 tmp 目錄，傳送完（不論成功與否）立刻整個
  // 刪掉——裡面的 .mcp.json 含真實 Bearer token，不留在磁碟上（同 kit-issue.ts）。
  const workDir = mkdtempSync(join(tmpdir(), `kit-resend-${id}-`))
  try {
    const zipPath = join(workDir, `${id}-kit.zip`)
    execFileSync('zip', ['-qr', zipPath, id], { cwd: KIT_DIST_DIR })
    const caption = rebuild
      ? `更新：${id}（${name}）的 kit（環境未變動，只是重新整理設定——例如併入最新的 toolsmith token）。請把這個 zip 連同下一則使用說明轉交對方。`
      : fresh
      ? `新核發：${id}（${name}）的 kit。請把這個 zip 連同下一則使用說明轉交對方。`
      : `重發：${id}（${name}）的新 kit。舊 token 已全部失效，請把這個 zip 連同下一則使用說明轉交對方。`
    console.log(sendViaTgNotify(['--chat-id', chatId, '--file', zipPath, '--text', caption]))
    // 標籤依實際寫進 .mcp.json 的別名反推，不是這次 --grants 請求了什麼
    // （既有環境「一併帶入」、或 --rebuild 完全沒動任何環境時都要準確反映）。
    console.log(sendViaTgNotify(['--chat-id', chatId, '--text', buildKitUsageText(name, readDistAliases(id))]))
    console.log(`已${rebuild ? '重建' : fresh ? '核發' : '重發'}並送達 kit 管理者 TG（chat_id 讀自 .env TG_KIT_ADMIN_CHAT_ID）。`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main()
