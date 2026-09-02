// import 邊界靜態測試（BL-C4 / MJ-E9，計畫 §4.1 兩段式白名單）。
//
// 段 1（既有）：掃 telegram-dispatcher 全 repo 的 import 圖，
//   `roster-decrypt.ts` 的 importer 集合必須恰好等於白名單 `lib/registry/*`。
//   `*.test.ts` 除外——直接測試模組（如本目錄的 `field-crypto.test.ts`）
//   是合法用途，不計入「production import」的邊界。
//
// 段 2（v3.2 新增，MJ-E9）：掃 `aladdin_mcps` 全 repo，斷言沒有任何檔案
//   （絕對或相對路徑皆然）import `telegram-dispatcher/lib/crypto/**` 之下
//   的任何東西；只允許 import `lib/registry/**` 與 `lib/monitor-db/load-env.ts`
//   （後兩者不屬本模組所有權，本測試只斷言「沒有人直接戳穿 lib/crypto」）。
//   依賴 aladdin_mcps 存在於同機固定絕對路徑；不存在時 SKIP 並印警告（不是 PASS）。

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const MCPS_ROOT = resolve(REPO_ROOT, '..', 'aladdin_mcps')
const ROSTER_DECRYPT_NOEXT = normalizeNoExt(join(REPO_ROOT, 'lib', 'crypto', 'roster-decrypt.ts'))
const CRYPTO_DIR_MARKER = '/telegram-dispatcher/lib/crypto/'

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'logs', 'data', 'dist', 'build', '.claude'])

function normalizeNoExt(p: string): string {
  return resolve(p).replace(/\.ts$/, '')
}

/** 遞迴列出 root 下所有 .ts 檔（略過 EXCLUDE_DIRS 與符號連結目錄的無限遞迴風險交由 statSync 保護）。 */
function listTsFiles(root: string): string[] {
  const out: string[] = []
  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (EXCLUDE_DIRS.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile() && name.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

/** 從檔案內容抽出 import/require/dynamic-import 的模組 specifier（純字串匹配，不做完整 AST 解析）。 */
function extractImportSpecifiers(content: string): string[] {
  const specs: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) {
      specs.push(m[1])
    }
  }
  return specs
}

describe('roster-decrypt.ts import 邊界（段 1：telegram-dispatcher 內）', () => {
  test('importer 集合（測試檔除外）必須全部落在 lib/registry/*', () => {
    const files = listTsFiles(REPO_ROOT)
    const importers: string[] = []
    for (const file of files) {
      const rel = relative(REPO_ROOT, file)
      if (rel.endsWith('.test.ts')) continue
      if (normalizeNoExt(file) === ROSTER_DECRYPT_NOEXT) continue
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const spec of extractImportSpecifiers(content)) {
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue // 忽略 bare import（第三方套件）
        const resolved = spec.startsWith('/') ? spec : resolve(dirname(file), spec)
        if (normalizeNoExt(resolved) === ROSTER_DECRYPT_NOEXT) {
          importers.push(rel)
        }
      }
    }
    const violations = importers.filter(p => !p.startsWith('lib/registry/'))
    expect(violations).toEqual([])
  })
})

describe('roster-decrypt.ts import 邊界（段 2：aladdin_mcps 跨 repo）', () => {
  const mcpsExists = existsSync(MCPS_ROOT)
  if (!mcpsExists) {
    console.warn(
      `[import-boundary.test] aladdin_mcps 不存在於預期路徑 ${MCPS_ROOT}，段 2 測試 SKIP（非 PASS）——` +
        'depends on 同機固定絕對路徑，見計畫 §4.1 MJ-E9 誠實記錄的前提。',
    )
  }

  test.skipIf(!mcpsExists)('aladdin_mcps 內沒有任何檔案直接 import telegram-dispatcher/lib/crypto/**', () => {
    const files = listTsFiles(MCPS_ROOT)
    const violations: string[] = []
    for (const file of files) {
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const spec of extractImportSpecifiers(content)) {
        let resolvedPath: string | null = null
        if (spec.startsWith('.')) {
          resolvedPath = resolve(dirname(file), spec)
        } else if (spec.startsWith('/')) {
          resolvedPath = spec
        } else {
          continue // bare import，非路徑，與本邊界無關
        }
        if (resolvedPath.includes(CRYPTO_DIR_MARKER)) {
          violations.push(`${relative(MCPS_ROOT, file)} -> ${spec}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
