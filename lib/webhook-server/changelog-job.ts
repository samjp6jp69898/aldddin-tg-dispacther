/**
 * changelog-job.ts — `/changelog` 的背景執行本體（由 changelog-command.ts 以
 * fire-and-forget 呼叫，不在 webhook handler 裡 await：grammy webhook 預設 10
 * 秒逾時，git fetch 四個 repo 加上 20–40 分鐘的 skill 執行都遠超過）。
 *
 * 流程：resolve-tag-ranges.ts（確定性：fetch、驗證 tag 在指定分支上、依 tag
 * 前綴算子專案路徑與 commit 清單、抽 abu menu 來源、--src-root 從 origin 建唯讀
 * worktree 給 method-call-graph 等工具讀，不動本機 repo 的工作目錄）→ 全部範圍 0 commit 就直接
 * 回覆不跑 → 否則 claude -p 跑 changelog-html skill 的「TG tag 模式」→ 以
 * OUTPUT_HTML 是否存在判定成敗，成功用 sendDocument 回傳 → 不論成敗都清掉 worktree。
 *
 * 執行在 dispatcher 行程內（非 detached）：dispatcher 重啟會中斷進行中的產生，
 * 使用者重送指令即可（每次都是非增量從零產生，沒有半成品狀態要接續）。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { InputFile, type Api } from 'grammy'
import type { Range, RepoCommits } from '/Users/user/aladdin/aladdin_ai/skills/changelog-html/resolve-tag-ranges.ts'
import { execClaudeWithStdin } from '../pipeline-runner/claude-exec.ts'

const execFileAsync = promisify(execFile)

const RESOLVER = '/Users/user/aladdin/aladdin_ai/skills/changelog-html/resolve-tag-ranges.ts'
const SKILL_MD = '/Users/user/aladdin/aladdin_ai/skills/changelog-html/SKILL.md'
const RUN_ROOT = '/Users/user/aladdin/telegram-dispatcher/logs/changelog'
const RESOLVE_TIMEOUT_MS = 5 * 60 * 1000
const CLAUDE_TIMEOUT_MS = 2 * 60 * 60 * 1000

type ResolveResult = { ok: true; ranges: Range[]; repos: RepoCommits; srcRoots: Record<string, string> } | { ok: false; errors: string[] }

async function runResolver(tokens: string[], runDir: string): Promise<ResolveResult> {
  const args = [RESOLVER, '--out', join(runDir, 'ranges.json'), '--menu-src', join(runDir, 'menu-src'), '--src-root', join(runDir, 'src'), ...tokens]
  try {
    const { stdout } = await execFileAsync('bun', args, { encoding: 'utf8', timeout: RESOLVE_TIMEOUT_MS })
    return JSON.parse(stdout) as ResolveResult
  } catch (err) {
    // exit 2（驗證不通過）也會走到這裡，stdout 仍是 resolver 的 JSON。
    const stdout = String((err as { stdout?: string }).stdout ?? '')
    try {
      return JSON.parse(stdout) as ResolveResult
    } catch {
      return { ok: false, errors: [`範圍解析執行失敗：${(err as Error).message.split('\n')[0]}`] }
    }
  }
}

function summarize(ranges: Range[]): string {
  return ranges.map(r => `• ${r.repo} ${r.tag} → ${r.branch}（${r.commits.length} 個 commit）`).join('\n')
}

/** 同 repo 多組範圍會重疊（common/、rajah 多組 tag），另列去重後的實際數量。 */
function summarizeRepos(repos: RepoCommits): string {
  return Object.entries(repos).map(([repo, v]) => `${repo} ${v.commits.length}`).join('、')
}

function buildPrompt(runDir: string, outputHtml: string): string {
  return [
    `請產生 changelog HTML：先完整讀 ${SKILL_MD}，依其中「TG tag 模式」一節的硬規則執行（其餘章節是各階段細節）。`,
    `RUN_DIR=${runDir}`,
    `OUTPUT_HTML=${outputHtml}`,
    'ranges.json 與 menu-src/ 已備妥於 RUN_DIR，不要重算範圍。這是無人值守執行，不要詢問任何問題。',
  ].join('\n')
}

export async function runChangelogJob(api: Api, chatId: number, tokens: string[]): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(RUN_ROOT, stamp)
  mkdirSync(runDir, { recursive: true })
  try {
    await generate(api, chatId, tokens, runDir, stamp)
  } finally {
    await execFileAsync('bun', [RESOLVER, '--cleanup-src', join(runDir, 'src')]).catch(err => console.error(`changelog worktree 清理失敗（${runDir}）: ${err}`))
  }
}

async function generate(api: Api, chatId: number, tokens: string[], runDir: string, stamp: string): Promise<void> {

  const resolved = await runResolver(tokens, runDir)
  if (!resolved.ok) {
    await api.sendMessage(chatId, `❌ 檢查未通過：\n${resolved.errors.join('\n')}`)
    return
  }
  const summary = `${summarize(resolved.ranges)}\n去重後：${summarizeRepos(resolved.repos)}`
  if (resolved.ranges.every(r => r.commits.length === 0)) {
    await api.sendMessage(chatId, `以下範圍在 tag 之後都沒有新的 commit，不產生 changelog：\n${summary}`)
    return
  }
  await api.sendMessage(chatId, `開始產生 changelog（約 20–40 分鐘，完成後會傳 HTML 給你）：\n${summary}`)

  const outputHtml = join(runDir, `changelog-${stamp.slice(0, 10)}.html`)
  let execError: string | null = null
  try {
    await execClaudeWithStdin(
      ['-p', '--model', 'opus', '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      buildPrompt(runDir, outputHtml),
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, cwd: '/Users/user/aladdin', trace: { ticket: 'changelog', stage: stamp } },
    )
  } catch (err) {
    const e = err as { killed?: boolean; code?: unknown }
    execError = e.killed ? '執行逾時（2 小時）' : `claude 執行失敗（exit ${String(e.code)}）`
  }

  if (existsSync(outputHtml)) {
    await api.sendDocument(chatId, new InputFile(outputHtml), { caption: `Changelog\n${summary}`.slice(0, 1024) })
    return
  }
  const failedMd = join(runDir, 'FAILED.md')
  const reason = existsSync(failedMd) ? readFileSync(failedMd, 'utf8').slice(0, 1500) : (execError ?? '未產生 HTML，原因不明')
  await api.sendMessage(chatId, `❌ changelog 產生失敗：\n${reason}\n\n執行目錄：${runDir}`)
}
