import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, statSync, appendFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tailFile } from './tailer.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-shipper-tailer-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tailFile', () => {
  test('檔案不存在回傳 null', () => {
    expect(tailFile(join(dir, 'nope.log'), undefined)).toBeNull()
  })

  test('第一次見到的檔案（無 cursor）從 offset 0 讀起', () => {
    const p = join(dir, 'a.log')
    writeFileSync(p, 'line1\nline2\n')
    const r = tailFile(p, undefined)!
    expect(r.lines.map(l => l.text)).toEqual(['line1', 'line2'])
    expect(r.lines[0]!.offset).toBe(0)
    expect(r.lines[1]!.offset).toBe(6) // 'line1\n' = 6 bytes
    expect(r.newOffset).toBe(12)
    expect(r.rotated).toBe(false)
    expect(r.hasIncompleteTail).toBe(false)
  })

  test('半行（無換行結尾）留到下一輪：不出現在 lines，newOffset 停在上一個完整行邊界', () => {
    const p = join(dir, 'b.log')
    writeFileSync(p, 'line1\npartial')
    const r = tailFile(p, undefined)!
    expect(r.lines.map(l => l.text)).toEqual(['line1'])
    expect(r.newOffset).toBe(6)
    expect(r.hasIncompleteTail).toBe(true)

    // 續讀：從 newOffset=6 帶著舊 inode 再讀一次，內容還沒變 → 依然拿不到 partial
    const r2 = tailFile(p, { inode: r.inode, offset: r.newOffset })!
    expect(r2.lines).toEqual([])
    expect(r2.newOffset).toBe(6)

    // 補上剩餘內容 + 換行 → 下一輪應該完整讀到 partial 這行
    appendFileSync(p, '2\n')
    const r3 = tailFile(p, { inode: r.inode, offset: r.newOffset })!
    expect(r3.lines.map(l => l.text)).toEqual(['partial2'])
    expect(r3.newOffset).toBe(6 + 'partial2\n'.length)
  })

  test('續讀游標：從舊 offset 接著讀新追加的內容', () => {
    const p = join(dir, 'c.log')
    writeFileSync(p, 'line1\n')
    const r1 = tailFile(p, undefined)!
    expect(r1.lines.map(l => l.text)).toEqual(['line1'])

    appendFileSync(p, 'line2\nline3\n')
    const r2 = tailFile(p, { inode: r1.inode, offset: r1.newOffset })!
    expect(r2.lines.map(l => l.text)).toEqual(['line2', 'line3'])
    expect(r2.rotated).toBe(false)
  })

  test('沒有新內容時回傳空陣列', () => {
    const p = join(dir, 'd.log')
    writeFileSync(p, 'line1\n')
    const r1 = tailFile(p, undefined)!
    const r2 = tailFile(p, { inode: r1.inode, offset: r1.newOffset })!
    expect(r2.lines).toEqual([])
    expect(r2.newOffset).toBe(r1.newOffset)
  })

  test('rotate（inode 變更）：從 0 讀新檔，不接續舊 offset', () => {
    const p = join(dir, 'e.log')
    writeFileSync(p, 'old-line1\nold-line2\n')
    const r1 = tailFile(p, undefined)!
    const oldInode = r1.inode

    unlinkSync(p)
    writeFileSync(p, 'new-line1\n')
    const newInode = statSync(p).ino
    expect(newInode).not.toBe(oldInode) // 前提假設：同名新檔通常拿到新 inode

    const r2 = tailFile(p, { inode: oldInode, offset: r1.newOffset })!
    expect(r2.rotated).toBe(true)
    expect(r2.lines.map(l => l.text)).toEqual(['new-line1'])
    expect(r2.lines[0]!.offset).toBe(0) // 從 0 讀新檔，不是接續舊 offset
  })

  test('多位元組 UTF-8 字元不影響行邊界統計（換行是單位元組 ASCII，不會落在字元中間）', () => {
    const p = join(dir, 'f.log')
    const line1 = '中文測試一行'
    writeFileSync(p, `${line1}\nsecond\n`)
    const r = tailFile(p, undefined)!
    expect(r.lines.map(l => l.text)).toEqual([line1, 'second'])
    expect(r.lines[1]!.offset).toBe(Buffer.byteLength(line1, 'utf8') + 1)
  })
})
