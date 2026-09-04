import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractLastJsonObject, findJsonObjectCandidates } from './extract-json-object.ts'

const FIXTURES = join(import.meta.dir, '__fixtures__')

describe('extractLastJsonObject', () => {
  test('純 JSON、無前後文字（既有正常路徑的迴歸保護）', () => {
    expect(extractLastJsonObject('{"sufficient": true}')).toEqual({ sufficient: true })
  })

  test('真實案例：2026-09-04 ALDREQ-835，模型在 JSON 前多寫一整段中文推理（fixture 是從 logs/agent-traces/ALDREQ-835/*-spec-gate.json 的 result 欄位逐字複製，未經任何加工）', () => {
    const raw = readFileSync(join(FIXTURES, 'aldreq-835-spec-gate-raw.txt'), 'utf8')
    expect(extractLastJsonObject(raw)).toEqual({ sufficient: true })
  })

  test('推理文字在 JSON 之後（前後都可能出現，不是只處理前置）', () => {
    const raw = '{"status": "success"}\n\n以上是分析結論，補充說明：這張需求單已經確認規格完整。'
    expect(extractLastJsonObject(raw)).toEqual({ status: 'success' })
  })

  test('JSON 字串值本身含大括號，不可誤判成兩個物件', () => {
    const raw = '推理過程...\n\n{"sufficient": false, "missing": "缺少 {config.json} 裡的欄位定義"}'
    expect(extractLastJsonObject(raw)).toEqual({
      sufficient: false,
      missing: '缺少 {config.json} 裡的欄位定義',
    })
  })

  test('JSON 字串值含跳脫的雙引號與反斜線', () => {
    const raw = String.raw`前言。{"missing": "欄位 \"foo\" 需要 C:\\path\\to\\file"}`
    expect(extractLastJsonObject(raw)).toEqual({ missing: '欄位 "foo" 需要 C:\\path\\to\\file' })
  })

  test('markdown code fence 包住的 JSON（既有 fence 剝除邏輯剝不乾淨時的二次防線）', () => {
    const raw = '這是我的判斷：\n```json\n{"sufficient": true}\n```\n完畢。'
    expect(extractLastJsonObject(raw)).toEqual({ sufficient: true })
  })

  test('文字裡出現多個合法 JSON 物件，取最後一個（對應「先推理、最後才收斂成結論」的真實觀察模式）', () => {
    const raw = '舉例來說，格式可能長這樣：{"example": "foo"}\n\n但實際判斷結果是：{"sufficient": true}'
    expect(extractLastJsonObject(raw)).toEqual({ sufficient: true })
  })

  test('嵌套物件與陣列可以正確配對大括號深度', () => {
    const raw = '分析如下。\n\n{"sufficient": false, "detail": {"reasons": ["A", "B"], "nested": {"x": 1}}}'
    expect(extractLastJsonObject(raw)).toEqual({
      sufficient: false,
      detail: { reasons: ['A', 'B'], nested: { x: 1 } },
    })
  })

  test('純文字裡剛好出現一對不成 JSON 的大括號，不當成候選、不拋錯，繼續往後找真正的 JSON', () => {
    const raw = '設定檔案格式是 {鍵值對} 這種樣子。真正的結論是 {"sufficient": true}'
    expect(extractLastJsonObject(raw)).toEqual({ sufficient: true })
  })

  test('完全沒有合法 JSON（截斷/破損）→ 回傳 undefined，呼叫端維持 fail-loud，不猜測補全', () => {
    const raw = '這段輸出被 timeout 砍斷，還沒寫完 {"sufficient": tr'
    expect(extractLastJsonObject(raw)).toBeUndefined()
  })

  test('空字串 → undefined', () => {
    expect(extractLastJsonObject('')).toBeUndefined()
  })

  test('純文字、完全沒有大括號 → undefined', () => {
    expect(extractLastJsonObject('抱歉，我沒有辦法完成這個判斷。')).toBeUndefined()
  })

  test('只有不成對的大括號 → undefined（不會把半個物件硬拼成候選）', () => {
    expect(extractLastJsonObject('這裡 } 那裡 {')).toBeUndefined()
  })

  test('repo-scope-gate 的實際 schema（repos 陣列欄位）也能正確抽取', () => {
    const raw = '探索完 codebase 後，判斷這張需求單涉及以下 repo：\n\n{"repos": ["agrabah", "abu"]}'
    expect(extractLastJsonObject(raw)).toEqual({ repos: ['agrabah', 'abu'] })
  })

  test('demand-plan classify 的實際 schema（status 列舉欄位）也能正確抽取', () => {
    const raw = '綜合以上分析，這張需求單已經被既有功能滿足。\n\n{"status": "already-satisfied"}'
    expect(extractLastJsonObject(raw)).toEqual({ status: 'already-satisfied' })
  })
})

describe('findJsonObjectCandidates', () => {
  test('依出現順序回傳全部合法候選', () => {
    const raw = '{"a": 1} 中間文字 {"b": 2}'
    expect(findJsonObjectCandidates(raw)).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('沒有候選時回傳空陣列', () => {
    expect(findJsonObjectCandidates('沒有任何 JSON')).toEqual([])
  })
})
