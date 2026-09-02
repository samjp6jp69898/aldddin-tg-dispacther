// lib/log-shipper/redaction.ts — log 送出前的遮罩規則表（canonical，單一來源）。
//
// plan §7.3（BLOCKER-4）：任何 log 在離開本機、送往 VictoriaLogs 之前都必須先
// 遮罩。本檔是規則表的唯一定義處；deploy/monitor-db/backfill/lib/redaction.ts
// 是先前 Phase 6 回填階段的先行版，Phase 7 落地後已收斂為對本檔的 re-export，
// 不再維護第二份規則表。
//
// §7.3 三層驗收架構（本模組只負責 L1，L2/L3 見下）：
//
//   L1 regression（本模組內，redaction.test.ts）：
//     用固定的合成樣本（notion token、bearer、mysql 密碼等）跑過全部規則，
//     確保「規則被改壞」這件事能被單元測試立刻抓到。這是防退化的安全網，
//     不是驗收關卡——通過 L1 只代表規則沒有比之前更差，不代表遮罩本身足夠。
//
//   L2 關門（驗收活動，不在本模組內）：
//     真實 log 樣本過完遮罩後，由獨立的人或 agent 逐字掃描確認沒有殘留機密。
//     這一步無法用單元測試自動化取代（真實 log 的格式多樣性遠超合成樣本），
//     必須是「跑過本模組 → 產出結果 → 另一方獨立檢視」的人工/agent 關門動作。
//
//   L3 已知繞過（明列，不假裝解決）：
//     遮罩是縱深防禦（defense in depth），不是密不透風的保證。目前已知、
//     且刻意不在本模組規則表範圍內解決的繞過面：
//       - 裸值 echo：`echo hunter2`、`echo $MYSQL_PWD` 這類沒有 key= 或
//         Bearer 之類固定前綴的裸值輸出，規則表無從辨識「這是密鑰」。
//       - base64 / xxd 等編碼包裝：密鑰被編碼過一層後，pattern 比對不到
//         明文特徵（例如 `ntn_xxx` base64 後不再含 `ntn_` 字串）。
//       - 無鍵名的純字串本身就是密鑰：例如密碼恰好是 `iamroot`，沒有任何
//         `password=` 之類的 key-value 結構可以掛鉤。
//       - API response body 內嵌的機密欄位：第三方回應 JSON 裡巢狀在業務
//         欄位中的 token/secret，沒有本規則表認得的固定 key 名稱。
//     以上四類需要靠 L2 人工/agent 逐字掃描、或上游（呼叫端不要把密鑰放進
//     會被記錄的欄位）來補，本模組不嘗試也不宣稱解決。
//
// 規則逐行套用、依表順序疊加（後面規則可能作用在前面規則已替換過的文字上，
// 目前 11 條 pattern 彼此不重疊、無此疑慮，但新增規則時要留意順序）。

export interface RedactionRule {
  name: string
  pattern: RegExp
  replace: string
}

/**
 * §7.3 十一條規則，逐條附出處：
 *  1. notion_token — Notion internal integration token。
 *  2. bearer — 泛用 Authorization: Bearer header。
 *  3. mysql_pwd — MYSQL_PWD 環境變數注入（test-schema.sh / migrate.sh 慣例）。
 *  4. mysql_cli_p — mysql CLI 的 -pXXXX（收窄版，MAJOR-D9：不誤傷
 *     `docker run -p 8080:80` 的 port mapping、`mkdir -p /tmp/x` 的旗標）。
 *  5. generic_password_kv — 泛用 password/passwd/pwd 的 key=value 或 key:value。
 *  6. tg_bot_token — Telegram bot token（<digits>:<35 chars>）。
 *  7. anthropic_key — Anthropic API key。
 *  8. gitlab_pat — GitLab personal access token。
 *  9. github_pat — GitHub personal access token（ghp_/gho_/ghu_/ghs_/ghr_）。
 * 10. mon_secrets — 本案監控 DB 專用密鑰環境變數（含 MON_BIDX_KEY、
 *     CLUSTER_SHARED_SECRET）。
 * 11. enc_blob — 欄位加密密文（enc:v1: 前綴）。
 */
export const REDACTION_RULES: RedactionRule[] = [
  { name: 'notion_token', pattern: /ntn_[A-Za-z0-9]+/g, replace: '[REDACTED_NOTION]' },
  { name: 'bearer', pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, replace: '$1[REDACTED]' },
  { name: 'mysql_pwd', pattern: /(MYSQL_PWD=)\S+/g, replace: '$1[REDACTED]' },
  // (?<=\s) 而非把空白納入 match：避免吃掉前導空白改變行的其餘結構。
  { name: 'mysql_cli_p', pattern: /(?<=\s)-p(?=[^\s/])(?!\d+:\d+)\S+/g, replace: '-p[REDACTED]' },
  { name: 'generic_password_kv', pattern: /((?:password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, replace: '$1[REDACTED]' },
  { name: 'tg_bot_token', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, replace: '[REDACTED_TG_TOKEN]' },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]+/g, replace: '[REDACTED_ANTHROPIC]' },
  { name: 'gitlab_pat', pattern: /glpat-[A-Za-z0-9_-]+/g, replace: '[REDACTED_GITLAB]' },
  { name: 'github_pat', pattern: /gh[pousr]_[A-Za-z0-9]+/g, replace: '[REDACTED_GITHUB]' },
  {
    name: 'mon_secrets',
    pattern: /((?:MON_DB_PASSWORD|MON_DB_ROOT_PASSWORD|MON_FIELD_KEY_V1|MON_BIDX_KEY|MON_VL_PASSWORD|CLUSTER_SHARED_SECRET)=)\S+/g,
    replace: '$1[REDACTED]',
  },
  { name: 'enc_blob', pattern: /enc:v1:[A-Za-z0-9_-]+/g, replace: 'enc:v1:[REDACTED]' },
]

/** 對一行文字依序套用全部規則，回傳遮罩後的字串。 */
export function redactLine(line: string): string {
  let out = line
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}
