import { describe, expect, test } from 'bun:test'
import { createReplayGuard } from './replay-guard.ts'

describe('createReplayGuard', () => {
  test('第一次看到某個 updateId：回 false（不是重複），並記住它', () => {
    const guard = createReplayGuard(10)
    expect(guard.isDuplicate(1)).toBe(false)
  })

  test('同一個 updateId 第二次進來：回 true（是重複）', () => {
    const guard = createReplayGuard(10)
    expect(guard.isDuplicate(1)).toBe(false)
    expect(guard.isDuplicate(1)).toBe(true)
    expect(guard.isDuplicate(1)).toBe(true) // 持續判定為重複，不會意外放行
  })

  test('不同 updateId 互不影響，各自只有第一次是 false', () => {
    const guard = createReplayGuard(10)
    expect(guard.isDuplicate(1)).toBe(false)
    expect(guard.isDuplicate(2)).toBe(false)
    expect(guard.isDuplicate(1)).toBe(true)
    expect(guard.isDuplicate(2)).toBe(true)
    expect(guard.isDuplicate(3)).toBe(false)
  })

  // acceptance criteria：「去重集合有上限，不會無限增長造成記憶體洩漏」——
  // 驗證超過上限後最舊的那筆會被淘汰，讓它可以再被視為「新」的一次。
  test('超過上限：最舊的一筆被淘汰，之後重放同一個舊 updateId 不再被判定為重複', () => {
    const guard = createReplayGuard(3)
    expect(guard.isDuplicate(1)).toBe(false)
    expect(guard.isDuplicate(2)).toBe(false)
    expect(guard.isDuplicate(3)).toBe(false)
    // 加入第 4 筆，超過上限 3，應該把最舊的 1 淘汰掉
    expect(guard.isDuplicate(4)).toBe(false)

    // 1 已經被淘汰，理論上重放它會被當成「新的」——這是 bounded set 的
    // 已知/可接受行為（用上限換記憶體安全，不是完美無漏洞的去重），驗證
    // 集合本身確實有在淘汰、不會無限增長。
    //
    // 注意：這次呼叫本身會把 1 重新插入集合，觸發連鎖淘汰（這次換最舊的
    // 2 被擠出）——這是實作本身的正確行為（isDuplicate 一律「查完就記
    // 一筆」），不是本測試要驗證的重點，所以下面只檢查目前確定還在追蹤
    // 範圍內的 3、4，不去檢查已經被連鎖擠出的 2。
    expect(guard.isDuplicate(1)).toBe(false)
    expect(guard.isDuplicate(3)).toBe(true)
    expect(guard.isDuplicate(4)).toBe(true)
  })

  test('多個 guard 互相獨立，不共用狀態', () => {
    const a = createReplayGuard(10)
    const b = createReplayGuard(10)
    expect(a.isDuplicate(1)).toBe(false)
    expect(b.isDuplicate(1)).toBe(false) // b 沒被 a 影響
    expect(a.isDuplicate(1)).toBe(true)
  })

  // review 發現的真實 bug 對應測試：isDuplicate 是「查完立刻記」，若呼叫端
  // 業務邏輯之後才失敗，得靠 forget() 把這個 updateId 退回「未處理」狀態，
  // 讓 Telegram 之後真正的重試可以重新跑一次業務邏輯，不會被永久吞掉。
  test('forget：業務邏輯失敗後呼叫，讓同一個 updateId 之後可以再被當成「新的」一次', () => {
    const guard = createReplayGuard(10)
    expect(guard.isDuplicate(1)).toBe(false) // 第一次進來，準備處理
    guard.forget(1) // 業務邏輯失敗，退回未處理狀態
    expect(guard.isDuplicate(1)).toBe(false) // Telegram 重試：視為新的一次，不會被吞掉
  })

  test('forget 對從未 isDuplicate 過的 updateId 呼叫：安全的 no-op，不影響其他已追蹤的 id', () => {
    const guard = createReplayGuard(10)
    expect(guard.isDuplicate(1)).toBe(false)
    guard.forget(999) // 從沒出現過的 id
    expect(guard.isDuplicate(1)).toBe(true) // 1 不受影響，仍然是重複
  })
})
