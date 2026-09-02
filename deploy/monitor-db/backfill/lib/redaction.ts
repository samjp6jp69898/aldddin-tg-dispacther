// backfill/lib/redaction.ts — 歷史 log 回填送 VictoriaLogs 前的遮罩規則表。
//
// 這是 plan §7.3（BLOCKER-4）11 條初始規則的「回填先行版」——只給
// backfill-logs-vl.ts 這支一次性離線回填腳本用。Phase 7 落地正式的
// log shipper（`lib/log-shipper/redaction.ts`）後，兩份規則表應收斂為單一
// 來源（本檔屆時應改為 re-export 或直接刪除），現況先各自獨立、避免
// Phase 6 回填卡在等 Phase 7 落地。
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
 * 10. mon_secrets — 本案監控 DB 專用密鑰環境變數。
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
