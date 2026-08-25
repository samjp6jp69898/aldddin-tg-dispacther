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
 * spawn_kit_script.ts 檔頭註解）。這裡只多做三件事：(1) 解析 Telegram 指令
 * 文字 (2) 核發成功後把 dist/<id>/ 打包成 zip 用 sendDocument 傳回
 * (3) 補發一則可直接轉傳給企劃的使用說明文字。
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

/**
 * grants key → 給企劃看的中文環境標籤。key 對應 make-starter-kit.ts 的
 * ALLOWED_GRANTS；沒對照到的 key 原樣顯示（理論上不會發生——能走到組訊息
 * 這一步表示 runKitScript 已成功，不合法的 grants 在腳本那關就被擋下了）。
 */
const GRANT_LABELS: Record<string, string> = {
  'admin-dev': '後台管理（dev）',
  'admin-pre': '後台管理（pre/cqa）',
  'admin-evi': '後台管理（evi）',
  'platform-dev-pk': '平台管理（dev × PK）',
}

/** 與 make-starter-kit.ts 的 DEFAULT_GRANTS 對齊：--grants 未指定時腳本用的預設值。 */
const DEFAULT_GRANT_KEYS = ['admin-dev', 'platform-dev-pk']

/**
 * 組一段可以直接轉傳給企劃的使用說明（純文字；Telegram 訊息本身就能轉傳，
 * 不需要特殊格式）。內容是 kit README.md 的濃縮版——完整手冊就在 kit
 * 資料夾裡，這裡只放對方拿到 zip 當下最需要知道的幾件事。
 */
function buildKitUsageText(name: string, grants?: string): string {
  const keys = grants ? grants.split(',').map((g) => g.trim()).filter(Boolean) : DEFAULT_GRANT_KEYS
  const labels = keys.map((k) => GRANT_LABELS[k] ?? k).join('、')
  return [
    `${name} 你好，這個壓縮檔是你的 agrabah 後台 AI 助理工具包（kit）。`,
    '',
    `你被授權的環境：${labels}`,
    '',
    '安裝重點（完整步驟見 kit 資料夾裡的 README.md）：',
    '1. 解壓縮後，整個資料夾放在「不會被雲端同步」的位置——不要放進',
    '   OneDrive、iCloud Drive、Dropbox、Google Drive 底下的任何資料夾。',
    '2. 把資料夾裡的 .env.example 複製一份、改名成 .env，',
    '   用文字編輯器打開，填入你登入後台的帳號密碼。',
    '3. 之後每次要用，雙擊 GUI 啟動腳本即可開始',
    '   （Mac 用 MAC-GUI-啟動腳本.command；Windows 用 Windows-GUI-啟動腳本.bat）。',
    '4. 第一次使用，先跟 Claude 說「幫我登入」。',
    '',
    '重要提醒：這份 kit 等同你的完整後台帳號。',
    '不要把它轉寄給別人、不要截圖它的內容、不要放進共用資料夾。',
    '',
    '遇到權限不足、登入失敗或任何看不懂的錯誤訊息，直接找工程師處理即可。',
  ].join('\n')
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
    // zip 之後補一則給企劃的使用說明：Landon 直接把這則訊息＋zip 轉傳給
    // 對方即可，不用每次自己重打一份「怎麼裝」。
    await ctx.reply(buildKitUsageText(parsed.name, parsed.grants))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
