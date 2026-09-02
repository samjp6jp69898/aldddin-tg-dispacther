// backfill/redaction.test.ts — §7.3 十一條遮罩規則的單元測試（禁 sleep，純字串比對）。
import { describe, expect, test } from 'bun:test'
import { redactLine, REDACTION_RULES } from './lib/redaction.ts'

describe('redaction rules table', () => {
  test('恰好 11 條規則', () => {
    expect(REDACTION_RULES.length).toBe(11)
  })
})

describe('notion_token', () => {
  test('遮罩 ntn_ 開頭的 token', () => {
    expect(redactLine('NOTION_TOKEN=ntn_abc123XYZ789')).toBe('NOTION_TOKEN=[REDACTED_NOTION]')
  })
})

describe('bearer', () => {
  test('遮罩 Authorization: Bearer 後的值，保留前綴', () => {
    const line = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc-def_123~+/='
    expect(redactLine(line)).toBe('Authorization: Bearer [REDACTED]')
  })
})

describe('mysql_pwd', () => {
  test('遮罩 MYSQL_PWD= 環境變數注入', () => {
    expect(redactLine('MYSQL_PWD=SuperSecret123')).toBe('MYSQL_PWD=[REDACTED]')
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
