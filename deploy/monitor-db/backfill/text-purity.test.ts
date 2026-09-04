// text-purity.test.ts — 釘住「本目錄所有 .ts 原始碼是純文字（無裸 NUL 位元組）」。
//
// 由來（review-final-A，2026-09-03）：precheck-events-dedup.ts 曾含兩個裸 NUL
// （Set 鍵分隔符寫成了真 NUL 字元而非 \0 逸出），git 視整檔為 binary——diff 不可讀、
// review 看不到內容、一切以文字為前提的檢查（含 set-diff 型關卡）對它失效。
// 一個為了保證回填正確性而寫的探針，自己不可審查，是「表面完好實則空轉」家族成員。
// 本測試讓這類問題在寫入當下就紅，不等 reviewer 撞見。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = import.meta.dir

describe('backfill 目錄 .ts 原始碼純文字', () => {
  const files: string[] = []
  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entry.name)
    if (entry.isDirectory() && entry.name === 'lib') {
      for (const f of readdirSync(join(DIR, 'lib'))) {
        if (f.endsWith('.ts')) files.push(join('lib', f))
      }
    }
  }

  test('至少掃到 precheck-events-dedup.ts', () => {
    expect(files).toContain('precheck-events-dedup.ts')
  })

  for (const f of files) {
    test(`${f} 不含裸 NUL 位元組`, () => {
      const bytes = readFileSync(join(DIR, f))
      expect(bytes.includes(0)).toBe(false)
    })
  }
})
