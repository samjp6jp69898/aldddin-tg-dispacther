/**
 * kit-issue.ts — Telegram `/kit <id> <name> [grants=env1,env2] [rotate]` 指令。
 *
 * 只有 TG_KIT_ADMIN_CHAT_ID 這一個 chat_id 能觸發（見 isKitAdminChat；呼叫端
 * whitelist.ts 額外做這道檢查，不是靠 Telegram 的「/」選單 scope 隱藏就夠
 * ——scope 只影響 autocomplete 顯示，任何人手動打字仍能送出指令字串）。
 *
 * 核發邏輯完全交給 aladdin-kit-admin 既有的 runKitScript（包裝
 * make-starter-kit.ts）：那支腳本已經做好「先檢查、再寫入」、atomic 名冊
 * 寫入等正確性細節，這裡重寫一份等於製造兩份會漂移的實作（同一個理由見
 * spawn_kit_script.ts 檔頭註解）。這裡只多做兩件事：(1) 解析 Telegram 指令
 * 文字 (2) 核發成功後把 dist/<id>/ 打包成 zip 用 sendDocument 傳回。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputFile, type Context } from 'grammy'
import { runKitScript } from '/Users/user/aladdin/obsidian/mcps/aladdin-kit-admin/src/spawn_kit_script.ts'

const KIT_DIST_DIR = '/Users/user/aladdin/obsidian/mcps/aladdin-ai-assistant-kit/dist'

/** 只從根目錄 .env 的 TG_KIT_ADMIN_CHAT_ID 讀（比照 bot.ts 對 token 的手法），不寫死。 */
export function isKitAdminChat(chatId: string): boolean {
  const adminChatId = process.env.TG_KIT_ADMIN_CHAT_ID
  return !!adminChatId && chatId === adminChatId
}

type ParsedKitCommand = { ok: true; id: string; name: string; grants?: string; rotate: boolean } | { ok: false; error: string }

const USAGE = '用法：/kit <id> <name> [grants=env1,env2] [rotate]\n例：/kit angelo 信融\n例：/kit angelo 信融 grants=admin-dev,platform-dev-pk,admin-pre,admin-evi rotate'

/**
 * name 允許含空白（保險起見；實務上多是不含空白的中文/英文代稱）：從指令
 * 剩餘 token 裡先挑出 grants=.../rotate 這兩種選項 token，其餘全部合併當
 * name，選項出現順序不拘。
 */
export function parseKitCommand(text: string): ParsedKitCommand {
  const tokens = text.trim().split(/\s+/)
  tokens.shift() // 丟掉 '/kit'
  if (tokens.length < 2) return { ok: false, error: USAGE }

  const id = tokens.shift()!
  let rotate = false
  let grants: string | undefined
  const nameTokens: string[] = []
  for (const t of tokens) {
    if (t.toLowerCase() === 'rotate') {
      rotate = true
      continue
    }
    const grantsMatch = /^grants=(.+)$/i.exec(t)
    if (grantsMatch) {
      grants = grantsMatch[1]
      continue
    }
    nameTokens.push(t)
  }
  const name = nameTokens.join(' ')
  if (!name) return { ok: false, error: USAGE }

  return { ok: true, id, name, grants, rotate }
}

export async function handleKitCommand(ctx: Context, text: string): Promise<void> {
  const parsed = parseKitCommand(text)
  if (!parsed.ok) {
    await ctx.reply(parsed.error)
    return
  }

  await ctx.replyWithChatAction('upload_document')

  const args = ['--id', parsed.id, '--name', parsed.name]
  if (parsed.grants) args.push('--grants', parsed.grants)
  if (parsed.rotate) args.push('--rotate')

  const result = runKitScript(args)
  if (!result.success) {
    await ctx.reply(result.stderr || '核發失敗（腳本無輸出，僅回傳非 0 exit code）')
    return
  }

  const distDir = join(KIT_DIST_DIR, parsed.id)
  if (!existsSync(distDir)) {
    await ctx.reply(`${result.stdout}\n\n（核發似乎成功但找不到輸出目錄：${distDir}，未打包傳送）`)
    return
  }

  // 打包成 zip 再傳送：workDir 是獨立 tmp 目錄，傳送完（不論成功與否）立刻整個刪掉
  // ——裡面的 .mcp.json 含真實 Bearer token，不留在磁碟上。
  const workDir = mkdtempSync(join(tmpdir(), `tg-kit-${parsed.id}-`))
  try {
    const zipPath = join(workDir, `${parsed.id}-kit.zip`)
    execFileSync('zip', ['-qr', zipPath, parsed.id], { cwd: KIT_DIST_DIR })
    await ctx.reply(result.stdout.trim())
    await ctx.replyWithDocument(new InputFile(zipPath, `${parsed.id}-kit.zip`))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
