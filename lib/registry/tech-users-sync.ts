// lib/registry/tech-users-sync.ts — tech_users 名冊的唯一寫入者與唯一對外
// 查詢管道，bun CLI。bash 端（aladdin_ai/scripts/tg-map-chatids.sh、
// tg-notify.sh、resolve-reviewer.sh）與其他 repo（tg-monitor）都經本檔取得
// 名冊，不自行連 DB、不再有任何檔案來源。
//
// 2026-09-16（Phase 6：tech-users.csv 完全退役，使用者定案）：
//   - `aladdin_ai/commands/create-mr/references/tech-users.csv` 已刪檔。本檔
//     連同所有下游不再有 CSV 讀寫路徑，`--csv` 參數與 `--reconcile`
//     （CSV→DB 同步）一併移除——沒有 CSV 就沒有要同步的來源。
//   - 名冊查詢不再看 `MON_DB_ENABLED`：這個旗標原本的意義是「DB 軌還沒上線
//     時退回舊檔案軌」，舊軌已經不存在，留著只會讓「旗標沒設」變成靜默走到
//     一條不存在的路。本檔所有指令一律走 DB（`--dry-run` 除外，它本來就零
//     DB 讀寫）。旗標本身仍服務其他模組（runs/agent_runs 寫入等），不在此
//     移除。
//   - 原本「人工編輯 CSV 一列、再 --reconcile 推進 DB」的名冊增修途徑，由
//     `--upsert-user` / `--remove-user` 取代；讀取端由 `--list-roster` 取代
//     「下游各自讀同一份 CSV」。
//   - **`--remove-user` 目前會被 DB 權限擋下**：`mon_head` 的授權是
//     `SELECT, INSERT, UPDATE ON pipeline_monitor.*`，刻意不含 DELETE
//     （deploy/monitor-db/migrate.sh 的帳號建立段）。要啟用這條路徑需要
//     `GRANT DELETE ON pipeline_monitor.tech_users TO 'mon_head'@'%'`
//     ——擴大權限範圍屬使用者裁定事項，未核准前本指令會以 MySQL 的
//     `DELETE command denied` 明確失敗（不會靜默成功、也不會改成「清空欄位」
//     這種看起來成功、實際上人還留在白名單裡的假動作）。
//
// 契約：
//   - notion_user_name / notion_user_id / pushed_repos：`--upsert-user` 寫入，
//     `--list-roster` 讀出。email 是主鍵，不可改（改信箱＝`--upsert-user` 新
//     信箱 + `--move` 換綁 + `--remove-user` 舊信箱）。
//   - tg_chat_id：`--set`/`--unset`/`--move` 寫入，加密 + 盲索引存放；
//     `--list-connected`/`--check-connected` 只回布林語意，
//     `--resolve-chat-id` 是唯一刻意回傳明碼的指令（見下方說明）。
//   - `--set`/`--unset`/`--move` 的 email 在 DB 不存在 → 明確報錯，不自創列
//     （先用 `--upsert-user` 建列）。
//   - `--repair-bidx`：一次性資料修復工具（見下方說明）。平時不需要跑；留著
//     是為了未來真的發生金鑰輪替時有現成工具可用。
//   - `--dry-run`：印將發生的動作摘要，零 DB 讀寫（executor 零呼叫）。
//   - 空值一律 NULL（tg_chat_id_enc/_bidx/bidx_key_ver 三欄同進退）。
//   - chat_id 明文不得出現在任何 CLI 輸出（本專案對 tg_chat_id 全面視為需
//     加密的 PII，見 lib/crypto/field-crypto.ts／roster-decrypt.ts）。**唯一
//     例外：--resolve-chat-id**——它的整個存在理由就是把明碼回傳給
//     tg-notify.sh 去打 Telegram sendMessage API（送 pipeline 通知），這件事
//     從 CSV 仍是權威來源的年代就一直是這樣（tg-notify.sh 直接讀 CSV 明碼
//     欄位），DB 收斂唯一權威後這支指令是等價的替代管道，不是新增的洩漏
//     面。呼叫端拿到值後只用來組 API 參數，從不記錄／回顯。
//
// bidx scope — HKDF info，改動會讓既有密文的等值查詢全部失效（換字串等於換
// 子金鑰）。lib/user-resolution/tech-user.ts 重新宣告了同一字串常數（刻意不
// cross-import，避免白名單查詢耦合到本模組）。

import type { MonitorDbExecutor } from '../monitor-db/writes.ts'

export const TECH_USER_BIDX_SCOPE = 'tech_users.tg_chat_id'
const BIDX_KEY_VER = 1
const CHAT_ID_RE = /^-?\d+$/

// ─────────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────────

export interface TechUserRosterRow {
  notion_user_name: string
  notion_user_id: string
  email: string
  pushed_repos: string
}

export interface RunDeps {
  dryRun: boolean
  /** !dryRun 時必須非 null（其餘情況不會被呼叫）。 */
  executor: MonitorDbExecutor | null
}

// ─────────────────────────────────────────────────────────────────────────
// 名冊讀寫（--list-roster / --upsert-user / --remove-user）
//
// `--list-roster` 的輸出格式刻意沿用已退役的 tech-users.csv 的四個非敏感欄位
// 與欄位順序（notion_user_name,notion_user_id,email,pushed_repos），讓下游
// （tg-notify.sh、resolve-reviewer.sh、notion-bug-query-v2.ts、
// bug-assignee-report.ts、tg-monitor）沿用既有的「純逗號切分」解析不必重寫。
// tg_chat_id 不在輸出內（PII，見檔頭）。
//
// 同一個理由，寫入端 `--upsert-user` 拒絕值內含逗號／雙引號／CR／LF——這是
// 舊 CSV 的格式防呆搬到寫入端，讓「輸出永遠可被純逗號切分解析」由結構保證，
// 而不是靠讀取端每次自己防。
// ─────────────────────────────────────────────────────────────────────────

const ROSTER_HEADER = 'notion_user_name,notion_user_id,email,pushed_repos'
const UNSAFE_FIELD_RE = /[,"\r\n]/

export async function runListRoster(deps: RunDeps): Promise<string[]> {
  if (deps.dryRun) return ['LIST_ROSTER_DRYRUN: 將讀取 tech_users 名冊四欄；本次不讀取 DB']

  const executor = deps.executor
  if (!executor) throw new Error('runListRoster: executor is required')

  const [rows] = await executor.execute<TechUserRosterRow[]>(
    'SELECT notion_user_name, notion_user_id, email, pushed_repos FROM tech_users ORDER BY email',
    [],
  )
  const out = [ROSTER_HEADER]
  for (const r of rows as TechUserRosterRow[]) {
    const fields = [r.notion_user_name ?? '', r.notion_user_id ?? '', r.email ?? '', r.pushed_repos ?? '']
    // 寫入端已擋掉這些字元；真的出現代表有人繞過本 CLI 直接改 DB，此時
    // 輸出已不可被下游安全解析——fail loud，不吐一份會被默默切錯欄的名冊。
    if (fields.some((f) => UNSAFE_FIELD_RE.test(f))) {
      throw new Error(`tech_users 欄位含逗號／雙引號／換行，名冊輸出無法安全切分（email=${r.email}）`)
    }
    out.push(fields.join(','))
  }
  return out
}

export async function runUpsertUser(row: TechUserRosterRow, deps: RunDeps): Promise<string[]> {
  if (row.email === '') return ['UPSERT_ERR_ARGS: need <email> <notion_user_name> <notion_user_id> [pushed_repos]']
  const bad = ([['email', row.email], ['notion_user_name', row.notion_user_name], ['notion_user_id', row.notion_user_id], ['pushed_repos', row.pushed_repos]] as const).find(
    ([, v]) => UNSAFE_FIELD_RE.test(v),
  )
  if (bad) return [`UPSERT_ERR_BAD_FIELD: ${bad[0]} 不得含逗號／雙引號／換行`]

  if (deps.dryRun) {
    return [`UPSERT_DRYRUN: email=${row.email}（將 upsert name/notion_user_id/pushed_repos；不動 tg_chat_id 三欄）；本次不讀取 DB、不寫入`]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runUpsertUser: executor is required')

  // tg_chat_id 三欄刻意不在 ON DUPLICATE KEY UPDATE 內：名冊增修與「誰連了
  // Telegram」是兩件獨立的事，改名冊不該把既有連接清掉（新列則三欄本來就
  // 是 NULL，由 --set 之後補）。
  await executor.execute(
    'INSERT INTO tech_users (email, notion_user_name, notion_user_id, pushed_repos) VALUES (?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE notion_user_name = VALUES(notion_user_name), notion_user_id = VALUES(notion_user_id), pushed_repos = VALUES(pushed_repos)',
    [row.email, row.notion_user_name, row.notion_user_id, row.pushed_repos],
  )
  return [`UPSERT_OK: ${row.email}`]
}

export async function runRemoveUser(email: string, force: boolean, deps: RunDeps): Promise<string[]> {
  if (email === '') return ['REMOVE_ERR_ARGS: need <email>']

  if (deps.dryRun) return [`REMOVE_DRYRUN: email=${email}（將刪除整列）；本次不讀取 DB、不寫入`]

  const executor = deps.executor
  if (!executor) throw new Error('runRemoveUser: executor is required')

  const [rows] = await executor.execute<Array<{ tg_chat_id_enc: string | null }>>(
    'SELECT tg_chat_id_enc FROM tech_users WHERE email = ?',
    [email],
  )
  const row = (rows as Array<{ tg_chat_id_enc: string | null }>)[0]
  if (!row) return [`REMOVE_ERR_NO_EMAIL: ${email}`]
  // 刪掉仍連接中的列會連同 Telegram 綁定一起消失（且無從復原明碼）——離職
  // 這種真的要刪的情境帶 --force，手滑打錯 email 的情境擋下來。
  if (row.tg_chat_id_enc !== null && !force) return [`REMOVE_CONFLICT: ${email} 目前仍連接 Telegram；需 --force`]

  await executor.execute('DELETE FROM tech_users WHERE email = ?', [email])
  return [`REMOVE_OK: ${email}`]
}

// ─────────────────────────────────────────────────────────────────────────
// tg_chat_id 寫入（--set / --unset）
// ─────────────────────────────────────────────────────────────────────────

async function fetchTechUserExists(executor: MonitorDbExecutor, email: string): Promise<boolean> {
  const [rows] = await executor.execute<Array<{ email: string }>>('SELECT email FROM tech_users WHERE email = ?', [
    email,
  ])
  return Array.isArray(rows) && rows.length > 0
}

export async function runSet(email: string, chatId: string, force: boolean, deps: RunDeps): Promise<string[]> {
  if (!CHAT_ID_RE.test(chatId)) return [`SET_ERR_BAD_CHATID: ${email}`]

  if (deps.dryRun) {
    return [`SET_DRYRUN: email=${email}（將加密寫入 tech_users.tg_chat_id；本次不讀取 DB、不寫入）`]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runSet: executor is required when 非 --dry-run')

  const { encryptField, blindIndex } = await import('../crypto/field-crypto.ts')
  const ctx = `tech_users.tg_chat_id:${email}`
  const enc = encryptField(ctx, chatId)
  const bidx = blindIndex(TECH_USER_BIDX_SCOPE, chatId)

  // 名冊列必須先存在（--upsert-user）：本指令只管 tg_chat_id，不自創名冊列
  // ——自創會產生一列沒有 notion_user_id 的殘缺列，白名單查得到人卻查不到
  // 他的 Notion 身分，比查不到更難察覺。
  const exists = await fetchTechUserExists(executor, email)
  if (!exists) return [`SET_ERR_NO_EMAIL: ${email}（DB 名冊無此 email，請先 --upsert-user）`]

  // 既有連接不會被靜默換掉（對齊退役前 bash 版 do_set 的 CONFLICT 語意）。
  const [curRows] = await executor.execute<Array<{ tg_chat_id_enc: string | null }>>(
    'SELECT tg_chat_id_enc FROM tech_users WHERE email = ?',
    [email],
  )
  const cur = (curRows as Array<{ tg_chat_id_enc: string | null }>)[0]
  if (cur?.tg_chat_id_enc != null && !force) {
    const { decryptField } = await import('../crypto/roster-decrypt.ts')
    let same = false
    try {
      same = decryptField(ctx, cur.tg_chat_id_enc) === chatId
    } catch {
      same = false
    }
    if (same) return [`SET_NOOP: ${email}（chat_id 未變）`]
    return [`SET_CONFLICT: ${email} 已有不同的 chat_id；需 --force`]
  }

  await executor.execute(
    'UPDATE tech_users SET tg_chat_id_enc = ?, tg_chat_id_bidx = ?, bidx_key_ver = ? WHERE email = ?',
    [enc, bidx, BIDX_KEY_VER, email],
  )

  return [`SET_OK: ${email}`]
}

export async function runUnset(email: string, deps: RunDeps): Promise<string[]> {
  if (deps.dryRun) {
    return [`UNSET_DRYRUN: email=${email}（將清空 tech_users.tg_chat_id_enc/_bidx/bidx_key_ver；本次不讀取 DB、不寫入）`]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runUnset: executor is required when 非 --dry-run')

  const [rows] = await executor.execute<Array<{ tg_chat_id_enc: string | null }>>(
    'SELECT tg_chat_id_enc FROM tech_users WHERE email = ?',
    [email],
  )
  const row = (rows as Array<{ tg_chat_id_enc: string | null }>)[0]
  if (!row) return [`UNSET_ERR_NO_EMAIL: ${email}（DB 名冊無此 email）`]
  if (row.tg_chat_id_enc === null) return [`UNSET_NOOP: ${email}（已經沒有 chat_id）`]

  // §8：空值一律 NULL，enc/bidx/bidx_key_ver 三欄同進退（釋出 UNIQUE 位）。
  await executor.execute(
    'UPDATE tech_users SET tg_chat_id_enc = NULL, tg_chat_id_bidx = NULL, bidx_key_ver = NULL WHERE email = ?',
    [email],
  )
  return [`UNSET_OK: ${email}`]
}

// ─────────────────────────────────────────────────────────────────────────
// --list-connected：列出「哪些 email 已連接」——只給不該看到明碼 chat_id 的
// 下游（tg-monitor）用，輸出只有 email，絕不含 chat_id。
// ─────────────────────────────────────────────────────────────────────────

export async function runListConnected(deps: RunDeps): Promise<string[]> {
  const executor = deps.executor
  if (!executor) throw new Error('runListConnected: executor is required')
  const [rows] = await executor.execute<Array<{ email: string; tg_chat_id_enc: string | null }>>(
    'SELECT email, tg_chat_id_enc FROM tech_users',
    [],
  )
  return (rows as Array<{ email: string; tg_chat_id_enc: string | null }>)
    .filter((r) => r.tg_chat_id_enc !== null)
    .map((r) => `CONNECTED: ${r.email}`)
}

// ─────────────────────────────────────────────────────────────────────────
// --check-connected <chatId...>：對每個給定的 chat_id 依輸入順序回報一行
// CONNECTED / NOT_CONNECTED，不迴響 chat_id 本身（呼叫端自己按順序 zip 回
// 自己手上已經有的 chat_id 清單）。格式不合法的 chat_id 一律當 NOT_CONNECTED
// （不中止整批——待處理清單裡任何一筆髒資料都不該卡住其他筆的判斷）。
// ─────────────────────────────────────────────────────────────────────────

export async function runCheckConnected(chatIds: string[], deps: RunDeps): Promise<string[]> {
  if (chatIds.length === 0) return []
  const executor = deps.executor
  if (!executor) throw new Error('runCheckConnected: executor is required')
  const { blindIndex } = await import('../crypto/field-crypto.ts')
  const out: string[] = []
  for (const id of chatIds) {
    if (!CHAT_ID_RE.test(id)) {
      out.push('NOT_CONNECTED')
      continue
    }
    const bidx = blindIndex(TECH_USER_BIDX_SCOPE, id)
    const [rows] = await executor.execute<Array<{ x: number }>>(
      'SELECT 1 AS x FROM tech_users WHERE tg_chat_id_bidx = ? LIMIT 1',
      [bidx],
    )
    out.push((rows as unknown[]).length > 0 ? 'CONNECTED' : 'NOT_CONNECTED')
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// --move <oldEmail> <newEmail>：把 tg_chat_id 從舊 email 換綁到新 email。
// 必須先解密（拿到明碼）才能用新 email 的 AAD 重新加密——這正是本檔屬於
// lib/registry/*（roster-decrypt.ts 的 import 白名單）才能做的事，明碼全程
// 留在本行程記憶體內，不回傳給呼叫端。
// ─────────────────────────────────────────────────────────────────────────

export async function runMove(oldEmail: string, newEmail: string, deps: RunDeps): Promise<string[]> {
  if (oldEmail === newEmail) return ['MOVE_ERR_ARGS: 新舊信箱相同']

  if (deps.dryRun) {
    return [`MOVE_DRYRUN: ${oldEmail} -> ${newEmail}（本次不讀取 DB、不寫入）`]
  }

  const executor = deps.executor
  if (!executor) throw new Error('runMove: executor is required when 非 --dry-run')

  const [oldRows] = await executor.execute<Array<{ tg_chat_id_enc: string | null }>>(
    'SELECT tg_chat_id_enc FROM tech_users WHERE email = ?',
    [oldEmail],
  )
  const oldRow = (oldRows as Array<{ tg_chat_id_enc: string | null }>)[0]
  if (!oldRow) return [`MOVE_ERR_NO_EMAIL: ${oldEmail}`]
  if (oldRow.tg_chat_id_enc === null) return [`MOVE_ERR_NOT_CONNECTED: ${oldEmail}`]

  const newExists = await fetchTechUserExists(executor, newEmail)
  if (!newExists) return [`MOVE_ERR_NO_EMAIL: ${newEmail}`]
  const [newRows] = await executor.execute<Array<{ tg_chat_id_enc: string | null }>>(
    'SELECT tg_chat_id_enc FROM tech_users WHERE email = ?',
    [newEmail],
  )
  if ((newRows as Array<{ tg_chat_id_enc: string | null }>)[0]?.tg_chat_id_enc != null) {
    return [`MOVE_ERR_TARGET_CONNECTED: ${newEmail}`]
  }

  const { decryptField } = await import('../crypto/roster-decrypt.ts')
  const { encryptField, blindIndex } = await import('../crypto/field-crypto.ts')
  // 一致於 runRepairBidx 的哲學：解密失敗（密文損毀/AAD 不符）回結構化錯誤，
  // 不讓例外往外傳到 runCli/main() 變成整支 CLI 中止——此時還沒發生任何
  // 寫入（兩個 UPDATE 都在這之後），所以不會有資料損壞，只是行為改成優雅
  // 回報而不是硬中止。
  let plaintext: string
  try {
    plaintext = decryptField(`tech_users.tg_chat_id:${oldEmail}`, oldRow.tg_chat_id_enc)
  } catch {
    return [`MOVE_ERR_DECRYPT_FAILED: ${oldEmail}`]
  }
  const newEnc = encryptField(`tech_users.tg_chat_id:${newEmail}`, plaintext)
  const bidx = blindIndex(TECH_USER_BIDX_SCOPE, plaintext)

  await executor.execute('UPDATE tech_users SET tg_chat_id_enc = NULL, tg_chat_id_bidx = NULL, bidx_key_ver = NULL WHERE email = ?', [
    oldEmail,
  ])
  await executor.execute('UPDATE tech_users SET tg_chat_id_enc = ?, tg_chat_id_bidx = ?, bidx_key_ver = ? WHERE email = ?', [
    newEnc,
    bidx,
    BIDX_KEY_VER,
    newEmail,
  ])
  return [`MOVE_OK: ${oldEmail} -> ${newEmail}`]
}

// ─────────────────────────────────────────────────────────────────────────
// --resolve-chat-id <email>：**唯一**刻意在輸出裡回傳明碼 chat_id 的指令
// ——例外於本檔「chat_id 明文不得出現在任何 CLI 輸出」的一般紀律，理由：
// tg-notify.sh（pipeline 收尾通知的唯一送出管道）本來就是直接讀已退役的
// tech-users.csv 的 tg_chat_id 欄拿明碼去打 Telegram sendMessage API，這件
// 事從未受那條紀律約束（tg-notify.sh 自己的 log 從不印 chat_id，只是需要
// 明碼才能完成「送出通知」這個操作本身）。這支指令是那條路的等價替代管道，
// 不是新增的洩漏面。
// ─────────────────────────────────────────────────────────────────────────

export async function runResolveChatId(email: string, deps: RunDeps): Promise<string[]> {
  const executor = deps.executor
  if (!executor) throw new Error('runResolveChatId: executor is required')

  const [rows] = await executor.execute<Array<{ tg_chat_id_enc: string | null }>>(
    'SELECT tg_chat_id_enc FROM tech_users WHERE email = ?',
    [email],
  )
  const row = (rows as Array<{ tg_chat_id_enc: string | null }>)[0]
  if (!row) return [`RESOLVE_ERR_NOT_TECH: ${email}`]
  if (row.tg_chat_id_enc === null) return [`RESOLVE_ERR_NO_CHATID: ${email}`]

  const { decryptField } = await import('../crypto/roster-decrypt.ts')
  try {
    const plaintext = decryptField(`tech_users.tg_chat_id:${email}`, row.tg_chat_id_enc)
    return [`RESOLVE_OK: ${plaintext}`]
  } catch {
    return [`RESOLVE_ERR_DECRYPT_FAILED: ${email}`]
  }
}

// ─────────────────────────────────────────────────────────────────────────
// --repair-bidx：一次性資料修復（2026-09-15 事故）。對每一列 tg_chat_id_enc
// 非 NULL 的列：用目前的 MON_FIELD_KEY_V1 解密、用目前的 MON_BIDX_KEY 重算
// bidx；已經正確（跟重算值相同）的列跳過不寫。明碼全程不離開這個函式，CLI
// 輸出只回報 email + 狀態，絕不印明碼或 bidx 本身（沿用 chat_id 不得出現在
// CLI 輸出的既有紀律）。
// 單列解密失敗（例如密文本身損毀）不中止整批、記下該 email 繼續下一列——
// 資料修復要盡量修好修得到的，不該因為一列壞資料就整批放棄。
// ─────────────────────────────────────────────────────────────────────────

export async function runRepairBidx(deps: RunDeps): Promise<string[]> {
  // 跟本檔其餘路徑同一個慣例：--dry-run 零 DB 讀寫（executor 零呼叫），在真的
  // 建 executor／發任何查詢之前就先回。
  if (deps.dryRun) {
    return ['REPAIR_BIDX_DRYRUN: 將逐列解密 tg_chat_id_enc、用目前的 MON_BIDX_KEY 重算 bidx；本次不讀取 DB、不寫入']
  }

  const executor = deps.executor
  if (!executor) throw new Error('runRepairBidx: executor is required when 非 --dry-run')

  const [rows] = await executor.execute<Array<{ email: string; tg_chat_id_enc: string | null; tg_chat_id_bidx: Buffer | null }>>(
    'SELECT email, tg_chat_id_enc, tg_chat_id_bidx FROM tech_users WHERE tg_chat_id_enc IS NOT NULL',
    [],
  )
  const candidates = rows as Array<{ email: string; tg_chat_id_enc: string | null; tg_chat_id_bidx: Buffer | null }>

  const { decryptField } = await import('../crypto/roster-decrypt.ts')
  const { blindIndex } = await import('../crypto/field-crypto.ts')

  let repaired = 0
  let unchanged = 0
  const failed: string[] = []

  for (const row of candidates) {
    let plaintext: string
    try {
      plaintext = decryptField(`tech_users.tg_chat_id:${row.email}`, row.tg_chat_id_enc!)
    } catch {
      failed.push(row.email)
      continue
    }
    const freshBidx = blindIndex(TECH_USER_BIDX_SCOPE, plaintext)
    if (freshBidx && row.tg_chat_id_bidx && freshBidx.equals(row.tg_chat_id_bidx)) {
      unchanged++
      continue
    }
    await executor.execute('UPDATE tech_users SET tg_chat_id_bidx = ?, bidx_key_ver = ? WHERE email = ?', [freshBidx, BIDX_KEY_VER, row.email])
    repaired++
  }

  const out = [`REPAIR_BIDX_OK: checked=${candidates.length} repaired=${repaired} unchanged=${unchanged} failed=${failed.length}`]
  for (const email of failed) out.push(`REPAIR_BIDX_DECRYPT_FAILED: ${email}`)
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// CLI 參數解析 + 入口
// ─────────────────────────────────────────────────────────────────────────

export interface ParsedCliArgs {
  mode:
    | 'set'
    | 'unset'
    | 'list-roster'
    | 'upsert-user'
    | 'remove-user'
    | 'list-connected'
    | 'check-connected'
    | 'move'
    | 'repair-bidx'
    | 'resolve-chat-id'
    | null
  email?: string
  chatId?: string
  /** mode === 'move' 時的目的信箱。 */
  newEmail?: string
  /** mode === 'upsert-user' 時的名冊三欄（email 走 args.email）。 */
  rosterName?: string
  rosterNotionId?: string
  rosterRepos?: string
  /** mode === 'check-connected' 時的候選 chat_id 清單（依輸入順序）。 */
  checkChatIds?: string[]
  dryRun: boolean
  force: boolean
  errors: string[]
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let mode: ParsedCliArgs['mode'] = null
  let email: string | undefined
  let chatId: string | undefined
  let newEmail: string | undefined
  let rosterName: string | undefined
  let rosterNotionId: string | undefined
  let rosterRepos: string | undefined
  let checkChatIds: string[] | undefined
  let dryRun = false
  let force = false
  const errors: string[] = []
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--set') {
      mode = 'set'
      email = argv[i + 1]
      chatId = argv[i + 2]
      i += 3
      continue
    }
    if (a === '--unset') {
      mode = 'unset'
      email = argv[i + 1]
      i += 2
      continue
    }
    if (a === '--list-roster') {
      mode = 'list-roster'
      i += 1
      continue
    }
    if (a === '--upsert-user') {
      mode = 'upsert-user'
      email = argv[i + 1]
      rosterName = argv[i + 2]
      rosterNotionId = argv[i + 3]
      // pushed_repos 可省略（等同空字串：這個人不負責任何 repo 的 MR 指派）。
      rosterRepos = argv[i + 4]
      i += 5
      continue
    }
    if (a === '--remove-user') {
      mode = 'remove-user'
      email = argv[i + 1]
      i += 2
      continue
    }
    if (a === '--list-connected') {
      mode = 'list-connected'
      i += 1
      continue
    }
    if (a === '--check-connected') {
      mode = 'check-connected'
      // 其餘所有後續 args 都當作 chat_id 候選清單（不再解析成其他旗標）。
      checkChatIds = argv.slice(i + 1)
      i = argv.length
      continue
    }
    if (a === '--move') {
      mode = 'move'
      email = argv[i + 1]
      newEmail = argv[i + 2]
      i += 3
      continue
    }
    if (a === '--repair-bidx') {
      mode = 'repair-bidx'
      i += 1
      continue
    }
    if (a === '--resolve-chat-id') {
      mode = 'resolve-chat-id'
      email = argv[i + 1]
      i += 2
      continue
    }
    if (a === '--dry-run') {
      dryRun = true
      i += 1
      continue
    }
    if (a === '--force') {
      force = true
      i += 1
      continue
    }
    errors.push(`未知參數: ${a}`)
    i += 1
  }
  return { mode, email, chatId, newEmail, rosterName, rosterNotionId, rosterRepos, checkChatIds, dryRun, force, errors }
}

export async function runCli(argv: string[], opts: { executor: MonitorDbExecutor | null }): Promise<string[]> {
  const args = parseCliArgs(argv)
  if (args.errors.length > 0) return args.errors

  const deps: RunDeps = { dryRun: args.dryRun, executor: opts.executor }

  switch (args.mode) {
    case 'set':
      if (!args.email || args.chatId === undefined || args.chatId === '') return ['SET_ERR_ARGS: need <email> <chat_id>']
      return runSet(args.email, args.chatId, args.force, deps)
    case 'unset':
      if (!args.email) return ['UNSET_ERR_ARGS: need <email>']
      return runUnset(args.email, deps)
    case 'list-roster':
      return runListRoster(deps)
    case 'upsert-user':
      if (!args.email || !args.rosterName || !args.rosterNotionId) {
        return ['UPSERT_ERR_ARGS: need <email> <notion_user_name> <notion_user_id> [pushed_repos]']
      }
      return runUpsertUser(
        {
          email: args.email,
          notion_user_name: args.rosterName,
          notion_user_id: args.rosterNotionId,
          pushed_repos: args.rosterRepos ?? '',
        },
        deps,
      )
    case 'remove-user':
      if (!args.email) return ['REMOVE_ERR_ARGS: need <email>']
      return runRemoveUser(args.email, args.force, deps)
    case 'list-connected':
      return runListConnected(deps)
    case 'check-connected':
      if (!args.checkChatIds || args.checkChatIds.length === 0) return ['CHECK_ERR_ARGS: need at least one chat_id']
      return runCheckConnected(args.checkChatIds, deps)
    case 'move':
      if (!args.email || !args.newEmail) return ['MOVE_ERR_ARGS: need <oldEmail> <newEmail>']
      return runMove(args.email, args.newEmail, deps)
    case 'repair-bidx':
      return runRepairBidx(deps)
    case 'resolve-chat-id':
      if (!args.email) return ['RESOLVE_ERR_ARGS: need <email>']
      return runResolveChatId(args.email, deps)
    default:
      return [
        'usage: tech-users-sync.ts --set <email> <chat_id> [--force] | --unset <email> | ' +
          '--list-roster | --upsert-user <email> <notion_user_name> <notion_user_id> [pushed_repos] | ' +
          '--remove-user <email> [--force] | --list-connected | ' +
          '--check-connected <chatId...> (放最後，會吞掉後面所有 args) | --move <oldEmail> <newEmail> | ' +
          '--resolve-chat-id <email> | --repair-bidx  [--dry-run]',
      ]
  }
}

async function main(): Promise<void> {
  // 短命 CLI 通常不經 launchd wrapper，process.env 裡沒有監控 DB 連線資訊與
  // 欄位金鑰——loadRegistryEnv 從 head 的 .env 補進來（只補缺的，不覆寫）。
  const { loadRegistryEnv } = await import('./env-load.ts')
  loadRegistryEnv()

  const argv = process.argv.slice(2)
  const args = parseCliArgs(argv)

  let pool: import('mysql2/promise').Pool | null = null
  let executor: MonitorDbExecutor | null = null
  if (!args.dryRun && args.mode !== null) {
    const { createMonitorPool } = await import('../monitor-db/pool.ts')
    // 2026-09-16 修正（FAQ-5094 事故：與 ALDREQ-834 同一種錯誤——見
    // env.ts declareMonitorRoleFromLocalEnv 的說明）：本檔原本寫死
    // createMonitorPool('mon_head', ...)，假設這支 CLI 只會在 head 上跑；
    // 但 resolve-reviewer.sh（/create-mr Step 0.5）會在 worker 上呼叫本
    // CLI 讀名冊，worker 的 .env 是 MON_DB_USER=mon_exec，寫死值必然觸發
    // loadMonitorEnv() 的角色不符斷言。改用 declareMonitorRoleFromLocalEnv()
    // + monitorRoleForThisHost()，讓角色由呼叫端機器的 .env 自己決定。
    const { declareMonitorRoleFromLocalEnv } = await import('../monitor-db/env.ts')
    const { monitorRoleForThisHost } = await import('../monitor-db/runtime.ts')
    declareMonitorRoleFromLocalEnv()
    pool = createMonitorPool(monitorRoleForThisHost(), { connectionLimit: 1 })
    executor = pool
  }

  try {
    const lines = await runCli(argv, { executor })
    for (const line of lines) console.log(line)
  } catch (err) {
    console.error(`[tech-users-sync] 中止：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    if (pool) await pool.end()
  }
}

if (import.meta.main) {
  await main()
}
