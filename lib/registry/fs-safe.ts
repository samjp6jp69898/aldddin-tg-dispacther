// lib/registry/fs-safe.ts — 名冊寫入面的共用檔案安全 helper（§5.8 / m-9 / BL-D2）。
//
// 三條硬規則的單一實作點：
//   1. 備份一律寫到 repo 之外的 ~/.aladdin-backups/<type>/（目錄 0700、檔 0600），
//      修剪由備份函式自己做（m-9：寫完新檔立刻修剪同目錄，不依賴外部清理排程）。
//   2. 名冊檔改寫一律 tmp + rename 原子替換（同目錄 tmp，避免跨檔系統 rename 失去原子性）。
//   3. 備份根目錄不得位於任何 git 工作區內（BL-D2 反向驗證的執行期版本）。

import { chmodSync, copyFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const BACKUP_ROOT = join(homedir(), '.aladdin-backups')

/** 備份根目錄不得在任何 git 工作區內（§5.8 驗證第 1 段的執行期斷言）。 */
export function assertBackupRootOutsideRepos(root: string = BACKUP_ROOT): void {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' })
  } catch {
    return // rev-parse 失敗 ＝ 不在任何 git 工作區內，正確
  }
  throw new Error(`[fs-safe] 備份根目錄位於 git 工作區內，拒絕備份：${root}`)
}

/**
 * 備份一個檔案到 ~/.aladdin-backups/<type>/<basename>.<ISO>，並修剪同目錄至最近 keep 份。
 * 回傳備份檔完整路徑。來源檔不存在時丟例外（呼叫端要備份的一定是「即將被覆寫的現行檔」）。
 */
export function backupOutsideRepo(srcPath: string, type: string, keep = 10): string {
  assertBackupRootOutsideRepos()
  const dir = join(BACKUP_ROOT, type)
  mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(BACKUP_ROOT, 0o700)
  chmodSync(dir, 0o700)
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `${basename(srcPath)}.${iso}`)
  copyFileSync(srcPath, dest)
  chmodSync(dest, 0o600)
  // m-9：寫完立刻修剪（同一 basename 的歷史備份保留最近 keep 份）
  const prefix = `${basename(srcPath)}.`
  const siblings = readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  for (const s of siblings.slice(keep)) unlinkSync(join(dir, s.n))
  return dest
}

/** tmp + rename 原子寫（同目錄 tmp；沿用既有 writeRegistryFileAtomic 慣例，0600）。 */
export function writeFileAtomic(destPath: string, content: string, mode = 0o600): void {
  const tmp = join(dirname(destPath), `.${basename(destPath)}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, content, { mode })
  renameSync(tmp, destPath)
}
