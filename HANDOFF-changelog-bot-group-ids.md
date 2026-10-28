# 交接：changelog 允許群組改由後台動態設定（記錄在 DB）

> 建立：2026-10-28。給 head 機（跑 server.ts / ops-ui 的那台）接手實作。

## 背景（已完成、已在 repo 裡）

- `/changelog` 已從 bug_analyst_bot 移除，改掛在**獨立的 aladdin operation bot**：
  - 入口 `changelog-bot.ts`（grammy long polling，不用 webhook / tunnel），token：`.env` 的 `TG_ALADDIN_OPERATION_BOT_TOKEN`
  - launchd 服務 `com.aladdin.tg-changelog-bot`（`launchd/run-changelog-bot.sh`、`launchd/com.aladdin.tg-changelog-bot.plist`）
  - 路由與執行：`lib/webhook-server/changelog-command.ts`、`changelog-job.ts`
  - 測試：`lib/security/changelog-bot-routing.test.ts`
- 觸發方式：
  - 私訊：`/changelog <repo> <branch> <tag> ...`，只限 `TG_BUG_REPORT_ADMIN_CHAT_ID`
  - 群組：`@<operation bot> /changelog <repo> <branch> <tag> ...`，**群組內任何人**都可觸發，權限只看「群組是否在允許清單」
- 允許清單**不放 .env**，由後台動態設定、記錄在 DB。唯一讀取點：
  `lib/webhook-server/changelog-group-allowlist.ts` 的 `isChangelogGroupChat(chatId): Promise<boolean>`。
  **目前是 stub，一律回 false**（群組觸發關閉，私訊不受影響）。

## 要實作的事

1. **DB**：新增存放 changelog 允許群組的資料表（至少 group chat_id；建議附群組名稱、建立者、建立時間、啟用狀態）。
2. **後台**：在 ops-ui（`lib/ops-ui/`）新增設定頁／API：列出、新增、刪除（或停用）允許群組。
3. **bot 端**：實作 `changelog-group-allowlist.ts` 的 `isChangelogGroupChat`，改查 DB。

### 硬約束

1. **operation bot 是獨立程序**（`changelog-bot.ts`），跟 server.ts（ops-ui 所在）不共用記憶體，只能透過 DB 共享設定。
2. **每則訊息都重新查、不快取**：後台改完不必重啟 bot 即生效。呼叫端已是 `await`，只需替換函式本體；
   `groupChangelogCommand` 先比對「@本bot /changelog」格式才查清單，群組閒聊不會打 DB，請保持這個順序。
3. DB 連線若需要環境變數，在 `launchd/run-changelog-bot.sh` 比照既有寫法逐一 `grep` + `export`（該腳本不 source 整份 `.env`）。
4. 後台權限沿用 ops-ui 既有認證（Telegram login + IP allowlist），不要開新的未驗證端點。
5. 群組 chat_id 是負數（supergroup 形如 `-100xxxxxxxxxx`），輸入要驗證格式。
6. DB 查詢失敗時視同「不允許」（回 false 並記 log），不要讓例外中斷 bot 的 polling。

### 取得群組 chat_id 的方式（後台介面可順便說明）

未允許的群組有人 `@bot /changelog` 時，bot 不回覆，只在
`logs/launchd-changelog-bot.err.log` 印出：

```
changelog: 未允許的群組 @ 了 bot，忽略（chat_id=-100xxxx title=群組名稱）；要開放請到後台加入此群組
```

### 驗收

- 後台新增一個群組後，**不重啟 bot**，該群組 `@bot /changelog ...` 即可觸發；刪除／停用後即失效。
- 未允許的群組仍然靜默、只留 log；DB 斷線時群組觸發失敗但 bot 不崩潰，私訊照常可用。
- `bun test lib/security/changelog-bot-routing.test.ts` 全過（路由測試以 mock 控制允許清單，已不依賴 env）；
  為 `isChangelogGroupChat` 的 DB 實作另補測試。測試不得用 sleep 等待。

## operation bot 首次部署（可與上面的實作並行）

1. BotFather 建立 bot，取得 token；`/setprivacy` 選該 bot → **Disable**（或之後把 bot 設為群組管理員）。
2. `telegram-dispatcher/.env` 加 `TG_ALADDIN_OPERATION_BOT_TOKEN=<token>`。
3. 把 bot 加進群組（若先加群組才關 privacy，要移出再加回）。
4. 安裝並啟動服務：
   ```bash
   cp /Users/user/aladdin/telegram-dispatcher/launchd/com.aladdin.tg-changelog-bot.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-changelog-bot.plist
   launchctl print gui/$(id -u)/com.aladdin.tg-changelog-bot | grep -E 'state|pid'
   tail -20 /Users/user/aladdin/telegram-dispatcher/logs/launchd-changelog-bot.err.log   # 應出現 "changelog-bot: initialized as @..."
   ```
5. 重啟 bug_analyst_bot 讓它的「/」選單拿掉 `/changelog`：`launchctl kickstart -k gui/$(id -u)/com.aladdin.tg-dispatch-server`。
6. 私訊驗證：管理員私訊 operation bot `/changelog abu feature/20261008 abu_admin_1.10.46` 應收到「收到…」與最後的 HTML。
