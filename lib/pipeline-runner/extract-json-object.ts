// lib/pipeline-runner/extract-json-object.ts — 從模型自由文字回應裡抽取結尾的
// JSON 物件，作為嚴格 JSON.parse 失敗時的救援步驟。
//
// 適用範圍（僅限「模型自己生成的自由文字」這一層）：
//   spec-sufficiency-gate.ts / repo-scope-gate.ts / demand-plan-pipeline.ts
//   這三處要求模型「只回一段 JSON」的 prompt，實測會出現模型在真正的 JSON
//   前面多寫一段推理文字才收尾（2026-09-04 ALDREQ-835 真實案例：模型判斷
//   完全正確，`{"sufficient": true}`，但前面多了一整段中文分析，導致既有的
//   `JSON.parse(raw)` 整段解析失敗）。
//
// 不適用範圍（刻意不擴大）：`classify-result.ts` 的 `extractResultEvent()`
// 解析的是 claude -p CLI 自己印出的 --output-format json/stream-json event
// envelope——那是機器產生的結構化輸出，不是模型自由文字，理論上永遠乾淨；
// 這個 codebase 過去對那一層明確拒絕用正則猜邊界（見該檔案註解），已用
// 「stdout/stderr 分檔案」從結構上根治過一次真實 bug，不應該在這裡重蹈覆轍
// 混用同一套救援邏輯到不同性質的資料。
//
// 安全邊界（不是「猜測破損 JSON 的邊界」）：
//   - 只接受掃描到的候選字串本身就是完整、合法的 JSON（`JSON.parse` 對那段
//     子字串成功），不對破損/截斷的 JSON 做任何修補嘗試。
//   - 不修改、不補全任何欄位值——找不到合法候選就回傳 undefined，呼叫端維持
//     原本的 fail-loud 錯誤路徑，行為與救援步驟加入前完全一致。
//   - 掃描時正確跳過字串字面值內的 `{`/`}`（含跳脫字元），避免
//     `{"missing": "缺少 {config.json} 的定義"}` 這種內容被誤判成兩個物件。
//   - 多個候選時取「最後一個」——觀察到的真實失敗模式是「先寫推理過程、
//     最後才收斂成 JSON 結論」，跟 prompt 要求的『最終輸出一段 JSON』語意
//     一致；不做啟發式排序、不嘗試「挑看起來最合理的那個」。

/**
 * 掃描 `raw`，回傳字串裡由左而右出現、且能被 `JSON.parse` 成功解析的完整
 * 頂層 JSON 物件字面值（`{...}`），依出現順序排列。只找物件（不找陣列/純值），
 * 因為三個呼叫端的 prompt 都要求輸出一個 JSON object。
 */
export function findJsonObjectCandidates(raw: string): unknown[] {
  const candidates: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }

    if (ch === '}') {
      if (depth === 0) continue // 沒有配對的 `}`，忽略（不是候選開端）
      depth--
      if (depth === 0 && start !== -1) {
        const candidate = raw.slice(start, i + 1)
        try {
          candidates.push(JSON.parse(candidate))
        } catch {
          // 這段大括號內容不是合法 JSON（例如純文字裡剛好出現配對的大括號），
          // 略過，不當成候選，也不中斷後續掃描。
        }
        start = -1
      }
    }
  }

  return candidates
}

/**
 * 取得字串裡最後一個能被解析成合法 JSON 物件的候選；找不到回傳 `undefined`
 * （呼叫端維持原本的 fail-loud 錯誤，不是這個函式的職責）。
 */
export function extractLastJsonObject(raw: string): unknown | undefined {
  const candidates = findJsonObjectCandidates(raw)
  return candidates.length > 0 ? candidates[candidates.length - 1] : undefined
}
