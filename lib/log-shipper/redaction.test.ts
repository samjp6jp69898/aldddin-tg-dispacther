// lib/log-shipper/redaction.test.ts — §7.3 十一條遮罩規則的單元測試（canonical，禁 sleep，純字串比對）。
//
// 本檔涵蓋 §7.3 三層驗收架構中的 L1（regression，見 redaction.ts 檔頭）：
// 用固定合成樣本防止規則被改壞。L2（真實 log 逐字掃描）是驗收活動，不在
// 本檔範圍內。L3（已知繞過）在本檔以「文件化測試」的形式明確斷言其存在，
// 不是要修掉它們——測試名已標明「已知限制，非 bug」。
import { describe, expect, test } from 'bun:test'
import { redactLine, REDACTION_RULES } from './redaction.ts'

describe('redaction rules table', () => {
  test('恰好 11 條規則', () => {
    expect(REDACTION_RULES.length).toBe(11)
  })
})

describe('notion_token', () => {
  test('遮罩 ntn_ 開頭的 token', () => {
    expect(redactLine('NOTION_TOKEN=ntn_abc123XYZ789')).toBe('NOTION_TOKEN=[REDACTED_NOTION]')
  })

  test('review B E7：真實格式 ntn_ 開頭長 token 逐字命中', () => {
    const line = 'export NOTION_TOKEN=ntn_1234567890abcdefGHIJKLMNOPqrstuvwxyz0123'
    expect(redactLine(line)).toBe('export NOTION_TOKEN=[REDACTED_NOTION]')
  })
})

describe('bearer', () => {
  test('遮罩 Authorization: Bearer 後的值，保留前綴', () => {
    const line = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc-def_123~+/='
    expect(redactLine(line)).toBe('Authorization: Bearer [REDACTED]')
  })

  test('review B E7：真實格式 Bearer <長串 JWT-like token> 逐字命中', () => {
    const line = 'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig-abc_123" https://api.example.com'
    expect(redactLine(line)).toBe(
      'curl -H "Authorization: Bearer [REDACTED]" https://api.example.com',
    )
  })
})

describe('mysql_pwd', () => {
  test('遮罩 MYSQL_PWD= 環境變數注入', () => {
    expect(redactLine('MYSQL_PWD=SuperSecret123')).toBe('MYSQL_PWD=[REDACTED]')
  })

  test('review B E7：真實格式 MYSQL_PWD=... 逐字命中', () => {
    const line = 'MYSQL_PWD=P@ssw0rd!2026 mysql -uroot mydb < schema.sql'
    expect(redactLine(line)).toBe('MYSQL_PWD=[REDACTED] mysql -uroot mydb < schema.sql')
  })
})

describe('mysql_cli_p（收窄版，MAJOR-D9）', () => {
  test('遮罩 mysql CLI 的 -pXXXX 密碼', () => {
    expect(redactLine('mysql -uroot -pSecretPass123 mydb')).toBe('mysql -uroot -p[REDACTED] mydb')
  })

  test('不誤傷 docker run -p 8080:80 port mapping', () => {
    const line = 'docker run -p 8080:80 image'
    expect(redactLine(line)).toBe(line)
  })

  test('不誤傷 mkdir -p /tmp/x 旗標', () => {
    const line = 'mkdir -p /tmp/x'
    expect(redactLine(line)).toBe(line)
  })
})

describe('generic_password_kv', () => {
  test('遮罩 password: \'value\' 形式（含引號）', () => {
    expect(redactLine("password: 'hunter2'")).toBe("password: '[REDACTED]'")
  })

  test('遮罩 password=value 形式，case-insensitive', () => {
    expect(redactLine('PASSWORD=Sup3rSecr3t;next=val')).toBe('PASSWORD=[REDACTED];next=val')
  })

  test('遮罩 pwd: 形式', () => {
    expect(redactLine('pwd: hunter2')).toBe('pwd: [REDACTED]')
  })
})

describe('tg_bot_token', () => {
  test('遮罩 Telegram bot token（<8-10位數字>:<35碼>）', () => {
    const token = `123456789:${'A'.repeat(35)}`
    expect(redactLine(`TG_BOT_TOKEN=${token}`)).toBe('TG_BOT_TOKEN=[REDACTED_TG_TOKEN]')
  })
})

describe('anthropic_key', () => {
  test('遮罩 sk-ant- 開頭的 Anthropic API key', () => {
    expect(redactLine('ANTHROPIC_API_KEY=sk-ant-api03-abcDEF123_-xyz')).toBe('ANTHROPIC_API_KEY=[REDACTED_ANTHROPIC]')
  })
})

describe('gitlab_pat', () => {
  test('遮罩 glpat- 開頭的 GitLab PAT', () => {
    expect(redactLine('token=glpat-abcDEF123456_-xyz')).toBe('token=[REDACTED_GITLAB]')
  })
})

describe('github_pat', () => {
  test('遮罩 ghp_ 開頭的 GitHub PAT', () => {
    expect(redactLine('token=ghp_abcDEF123456xyz')).toBe('token=[REDACTED_GITHUB]')
  })

  test('遮罩 gho_ 開頭的 GitHub OAuth token', () => {
    expect(redactLine('token=gho_abcDEF123456xyz')).toBe('token=[REDACTED_GITHUB]')
  })
})

describe('mon_secrets', () => {
  test('遮罩 MON_DB_PASSWORD=', () => {
    expect(redactLine('MON_DB_PASSWORD=abc123')).toBe('MON_DB_PASSWORD=[REDACTED]')
  })

  test('遮罩 MON_BIDX_KEY=', () => {
    expect(redactLine('MON_BIDX_KEY=bidxSecretValue')).toBe('MON_BIDX_KEY=[REDACTED]')
  })

  test('遮罩 MON_VL_PASSWORD=', () => {
    expect(redactLine('MON_VL_PASSWORD=vlSecret')).toBe('MON_VL_PASSWORD=[REDACTED]')
  })

  test('遮罩 CLUSTER_SHARED_SECRET=', () => {
    expect(redactLine('CLUSTER_SHARED_SECRET=xyz789')).toBe('CLUSTER_SHARED_SECRET=[REDACTED]')
  })
})

describe('enc_blob', () => {
  test('遮罩 enc:v1: 前綴的加密密文，保留前綴', () => {
    expect(redactLine('field=enc:v1:aGVsbG93b3JsZA-_abc123')).toBe('field=enc:v1:[REDACTED]')
  })
})

describe('複合行', () => {
  test('一行內多個密鑰同時被遮罩', () => {
    const line = 'MYSQL_PWD=abc123 Authorization: Bearer xyz.abc token=ntn_notion123'
    const out = redactLine(line)
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('xyz.abc')
    expect(out).not.toContain('ntn_notion123')
  })
})

// ── L1 regression：固定合成樣本，防規則表被改壞（非關門條件，見檔頭）──────────
// 每條規則配一個含獨特機密標記字串（secretMarker）的合成樣本；遮罩後掃描
// 輸出裡「殘留的機密標記數」必須為 0——這是可執行、會在規則被改壞時真的
// 變紅的判準，比單純比對固定輸出字串更貼近「防洩漏」這個目的本身。
describe('L1 regression：固定樣本跑全規則，殘留機密命中數必須為 0', () => {
  const SAMPLES: { rule: string; line: string; secretMarker: string }[] = [
    { rule: 'notion_token', line: 'NOTION_TOKEN=ntn_L1RegressionMarkerAAA111', secretMarker: 'ntn_L1RegressionMarkerAAA111' },
    { rule: 'bearer', line: 'Authorization: Bearer L1RegressionMarkerBBB222.abc-def_123~+/=', secretMarker: 'L1RegressionMarkerBBB222' },
    { rule: 'mysql_pwd', line: 'MYSQL_PWD=L1RegressionMarkerCCC333', secretMarker: 'L1RegressionMarkerCCC333' },
    { rule: 'mysql_cli_p', line: 'mysql -uroot -pL1RegressionMarkerDDD444 mydb', secretMarker: 'L1RegressionMarkerDDD444' },
    { rule: 'generic_password_kv', line: 'password: L1RegressionMarkerEEE555', secretMarker: 'L1RegressionMarkerEEE555' },
    { rule: 'tg_bot_token', line: `TG_BOT_TOKEN=123456789:${'F'.repeat(35)}`, secretMarker: `123456789:${'F'.repeat(35)}` },
    { rule: 'anthropic_key', line: 'ANTHROPIC_API_KEY=sk-ant-L1RegressionMarkerGGG666', secretMarker: 'sk-ant-L1RegressionMarkerGGG666' },
    { rule: 'gitlab_pat', line: 'token=glpat-L1RegressionMarkerHHH777', secretMarker: 'glpat-L1RegressionMarkerHHH777' },
    { rule: 'github_pat', line: 'token=ghp_L1RegressionMarkerIII888', secretMarker: 'ghp_L1RegressionMarkerIII888' },
    { rule: 'mon_secrets', line: 'MON_BIDX_KEY=L1RegressionMarkerJJJ999', secretMarker: 'L1RegressionMarkerJJJ999' },
    { rule: 'enc_blob', line: 'field=enc:v1:L1RegressionMarkerKKK000', secretMarker: 'L1RegressionMarkerKKK000' },
  ]

  test('每條規則的合成樣本遮罩後都不再殘留其機密標記', () => {
    for (const { rule, line, secretMarker } of SAMPLES) {
      const out = redactLine(line)
      expect(out.includes(secretMarker)).toBe(false)
    }
  })

  test('殘留機密命中總數為 0（規則表被改壞時本測試會變紅）', () => {
    const leftoverCount = SAMPLES.reduce((count, { line, secretMarker }) => {
      const out = redactLine(line)
      return out.includes(secretMarker) ? count + 1 : count
    }, 0)
    expect(leftoverCount).toBe(0)
  })

  test('規則表大小與名稱集合未被意外增刪（改表要同步改這條斷言才能過）', () => {
    const names = REDACTION_RULES.map((r) => r.name).sort()
    expect(names).toEqual(
      [
        'anthropic_key',
        'bearer',
        'enc_blob',
        'generic_password_kv',
        'github_pat',
        'gitlab_pat',
        'mon_secrets',
        'mysql_cli_p',
        'mysql_pwd',
        'notion_token',
        'tg_bot_token',
      ].sort(),
    )
  })
})

// ── L3 已知繞過：文件化測試（documented limitation，非 bug，見檔頭 L3 說明）───
describe('L3 已知繞過（documented，非 bug——不是要修掉，而是明確記錄現況）', () => {
  test('已知繞過：base64 包裝的秘密不會被現有規則攔截', () => {
    // 把一個會被 notion_token 規則攔截的明文秘密整行 base64 編碼後，
    // 編碼結果不再含 `ntn_` 特徵字串，現有 pattern 無從辨識。
    const secret = 'NOTION_TOKEN=ntn_abc123XYZ789'
    const encoded = Buffer.from(secret, 'utf8').toString('base64')
    expect(encoded).not.toContain('ntn_')
    // 遮罩後的輸出等於原始 base64 字串（完全沒被攔下）——這是已知限制。
    expect(redactLine(encoded)).toBe(encoded)
  })

  test('已知繞過：跨行拆開的 token 逐行處理時不會被攔截', () => {
    // redactLine 是逐行處理。bearer 規則要求「Bearer 」前綴與 token 值在
    // 同一行才能命中；若呼叫端把值拆成兩行輸出（例如終端機折行、或先印出
    // 前綴、下一行才印出 token 本體），兩行各自過規則都不構成完整 pattern，
    // 都不會命中——即使合併起來看仍是同一個機密。
    const line1 = 'Authorization: Bearer'
    const line2 = 'eyJhbGciOiJIUzI1NiJ9.L1RegressionMarkerZZZ999'
    expect(redactLine(line1)).toBe(line1)
    expect(redactLine(line2)).toBe(line2)
    // 兩行合併回單一字串（同一行內有完整的「Bearer <值>」）時規則才能命中，
    // 佐證「逐行處理、前綴與值被拆開」正是這個繞過面的成因。
    const merged = `${line1} ${line2}`
    expect(redactLine(merged)).not.toBe(merged)
  })
})
