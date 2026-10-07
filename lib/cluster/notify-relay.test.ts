import { describe, expect, test } from 'bun:test'
import { relayNotify } from './notify-relay.ts'

describe('relayNotify', () => {
  test('email 合法 → 以 --email 呼叫並回傳最後一行', async () => {
    let got: string[] = []
    const r = await relayNotify({ email: 'a@x.com', text: 'hi' }, async a => { got = a; return 'noise\nTG_SENT: a@x.com\n' })
    expect(got).toEqual(['--email', 'a@x.com', '--text', 'hi'])
    expect(r).toBe('TG_SENT: a@x.com')
  })
  test('notionUserIds 合法、dryRun 傳遞', async () => {
    let got: string[] = []
    await relayNotify({ notionUserIds: 'id-1 id-2', text: 'hi', dryRun: true }, async a => { got = a; return 'x' })
    expect(got).toEqual(['--notion-user-ids', 'id-1 id-2', '--text', 'hi', '--dry-run'])
  })
  test.each([
    [null],
    [{ text: 'hi' }],
    [{ email: 'a@x.com' }],
    [{ email: 'a@x.com', text: '' }],
    [{ email: 'not-an-email', text: 'hi' }],
    [{ email: 'a@x.com,b@x.com', text: 'hi' }],
    [{ email: 'a@x.com', text: 'x'.repeat(4001) }],
    [{ notionUserIds: 'id; rm -rf', text: 'hi' }],
  ])('不合法 body → null 且不執行', async body => {
    let called = false
    const r = await relayNotify(body as never, async () => { called = true; return '' })
    expect(r).toBeNull()
    expect(called).toBe(false)
  })
})
