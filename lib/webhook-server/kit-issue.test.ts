import { describe, expect, test } from 'bun:test'
import { parseKitCommand } from './kit-issue.ts'

// 純函式，不涉及任何 side effect（不呼叫 runKitScript/zip/Telegram API），
// 所以刻意不 mock 任何模組——跟這個檔案裡任何其他測試（或其他測試檔）共用
// module registry 都不會互相干擾。真正會碰 runKitScript/handleKitCommand
// 的測試在 whitelist-kit-routing.test.ts（那裡才需要 mock.module，理由見
// 該檔檔頭註解）。
describe('parseKitCommand', () => {
  test('基本 /kit <id> <name>', () => {
    expect(parseKitCommand('/kit angelo 信融')).toEqual({ ok: true, id: 'angelo', name: '信融', grants: undefined, rotate: false })
  })

  test('帶 rotate（不分大小寫）', () => {
    expect(parseKitCommand('/kit angelo 信融 ROTATE')).toEqual({ ok: true, id: 'angelo', name: '信融', grants: undefined, rotate: true })
  })

  test('帶 grants=（逗號分隔的值原樣帶出，不在這裡驗證合法性——交給 make-starter-kit.ts）', () => {
    expect(parseKitCommand('/kit angelo 信融 grants=admin-dev,admin-pre,admin-evi')).toEqual({
      ok: true,
      id: 'angelo',
      name: '信融',
      grants: 'admin-dev,admin-pre,admin-evi',
      rotate: false,
    })
  })

  test('grants= 與 rotate 同時出現，順序不拘', () => {
    expect(parseKitCommand('/kit angelo 信融 rotate grants=admin-dev,platform-dev-pk')).toEqual({
      ok: true,
      id: 'angelo',
      name: '信融',
      grants: 'admin-dev,platform-dev-pk',
      rotate: true,
    })
    expect(parseKitCommand('/kit angelo 信融 grants=admin-dev,platform-dev-pk rotate')).toEqual({
      ok: true,
      id: 'angelo',
      name: '信融',
      grants: 'admin-dev,platform-dev-pk',
      rotate: true,
    })
  })

  test('name 含空白：非選項 token 全部合併當 name', () => {
    expect(parseKitCommand('/kit chenmei H32 Test A')).toEqual({ ok: true, id: 'chenmei', name: 'H32 Test A', grants: undefined, rotate: false })
  })

  test('缺 name → 回用法提示（ok: false）', () => {
    const r = parseKitCommand('/kit angelo')
    expect(r.ok).toBe(false)
  })

  test('完全沒帶 id/name → 回用法提示（ok: false）', () => {
    const r = parseKitCommand('/kit')
    expect(r.ok).toBe(false)
  })
})
