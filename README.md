# telegram-dispatcher

透過 Telegram bot 讓白名單內的技術人員認領 Bug 工單，認領後在背景觸發既有
的 `/create-mr` pipeline（詳見 `tasks.json` 的 `architecture_summary` 與
`HOW-TO-CONTINUE.md`）。本檔只講「怎麼部署/操作這支服務」，不重複那兩份
文件已有的架構/開發規則說明。

## 系統組成

兩支獨立常駐行程（各自一支 launchd job，互不依賴對方的 process 存活）：

1. **webhook server**（`bun run server.ts`）：接 Telegram 送來的訊息/按鈕，
   查 Notion、觸發背景 pipeline。
2. **ngrok tunnel**：把上面的 server 對外暴露成 Telegram 打得到的 HTTPS
   網址。

## 啟動 / 停止 / 查狀態

### 本機手動跑（開發、除錯用，不透過 launchd）

```bash
# 啟動 server（會一直佔用這個 terminal，Ctrl-C 停止）
zsh /Users/user/aladdin/telegram-dispatcher/launchd/run-server.sh

# 啟動 tunnel（另開一個 terminal；一旦執行就會真的對外開放，見下方風險）
zsh /Users/user/aladdin/telegram-dispatcher/launchd/run-tunnel.sh
```

兩支 wrapper script 都會自動從根目錄 `.env` 讀必要的環境變數，不需要自己
先 export。

### 透過 launchd 常駐（正式模式）

plist 定義檔放在 `telegram-dispatcher/launchd/`，**要先複製一份到
`~/Library/LaunchAgents/`**（launchd 只認這個目錄下的檔案，不會直接讀 repo
裡的路徑；`ProgramArguments` 裡的腳本路徑仍指回 repo，複製的只有 plist 本身）：

```bash
cp /Users/user/aladdin/telegram-dispatcher/launchd/com.aladdin.tg-dispatch-server.plist \
   /Users/user/aladdin/telegram-dispatcher/launchd/com.aladdin.tg-dispatch-tunnel.plist \
   ~/Library/LaunchAgents/
```

啟動（`bootstrap`，macOS 現行語法；舊語法 `launchctl load <path>` 也還能用）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-dispatch-server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-dispatch-tunnel.plist
```

停止（`bootout`；舊語法 `launchctl unload <path>`）：

```bash
launchctl bootout gui/$(id -u)/com.aladdin.tg-dispatch-server
launchctl bootout gui/$(id -u)/com.aladdin.tg-dispatch-tunnel
```

查狀態：

```bash
launchctl list | grep tg-dispatch
# 或看單一 job 的詳細狀態（PID、上次結束碼等）：
launchctl print gui/$(id -u)/com.aladdin.tg-dispatch-server
launchctl print gui/$(id -u)/com.aladdin.tg-dispatch-tunnel
```

log 檔位置：`telegram-dispatcher/logs/launchd-server.{out,err}.log`、
`launchd-tunnel.{out,err}.log`（兩支 plist 各自指定，見 T18）。

另外可以打 `/health`（不需要任何驗證）快速確認 server process 本身有沒有在
回應：

```bash
curl http://localhost:8787/health
# {"status":"ok","uptime_seconds":123}
```

> **hosted MCP 後端（8788-8792）的存活探測一律走本機，不要經公網。** 這支
> server 同時是五條 hosted MCP path 的 proxy（`/mcp-admin-dev`、`/mcp-platform`
> 等，見 `lib/webhook-server/mcp-proxy.ts`），而各 hosted server 自己的
> `/health` 是刻意不驗證 Bearer token 的。先前這條路徑經 proxy 對公網可達，
> 等於任何人塞一個假 `Authorization` header 就能問出「哪些前綴存在、後面的
> 服務活著沒、上次重啟在多久以前」——proxy 現在會直接攔掉 `/<前綴>/health`
> 不轉發，公網打過去跟猜錯前綴一樣只拿到 401 空 body。
>
> 要確認某支 hosted server 有沒有在跑，改用本機直連（launchd 與人工排查本來
> 就走這條）：
>
> ```bash
> curl http://127.0.0.1:8789/health   # agrabah-admin (dev)
> curl http://127.0.0.1:8790/health   # agrabah-platform
> ```

> T22（正式上線）已於 2026-08-16／17 由使用者本人在場確認完成，`setWebhook`
> 已呼叫過一次（見下方「查目前 Telegram 端實際登記的 webhook 狀態」）。以上
> launchd 啟動指令目前可以正常操作；唯一仍需要使用者在場確認的情境是**換
> 一台新機器重新上線**，見下一節「在另一台機器部署」。

## 在另一台機器部署

這支服務**不是獨立可攜的服務**：它觸發的 `/create-mr` pipeline 依賴整個
aladdin/obsidian 生態系（`obsidian/commands/create-mr/references/tech-users.csv`、
`scripts/bug-lock.sh`／`notion.sh`／`pipeline-status.sh`／`setup-worktree.sh`、
`.claude/commands/create-mr` 這支指令本身、以及 `agrabah`／`abu`／`lago`／`rajah`
等子專案的 git checkout），換機器等於要把整個 aladdin 開發環境搬過去，不是
只複製 `telegram-dispatcher/` 這個資料夾就好。

### 前置安裝 checklist

1. **整份 aladdin monorepo**（含 `obsidian/` 子 repo、`agrabah`/`abu`/`lago`/
   `rajah` 等 `/create-mr` pipeline 實際會用到的子專案、`.claude/` 底下的
   commands/agents/skills）與 Claude Code CLI 本身（已登入、且能正常執行
   `/create-mr:create-mr` 這個 slash command）。
2. **bun**（跟原機器同版本或相容版本）：`cd telegram-dispatcher && bun install`
   （目前依賴只有 `grammy`/`hono`，見 `package.json`，很輕量）。
3. **ngrok**：安裝後執行 `ngrok config add-authtoken <token>`——**必須是同一個
   ngrok 帳號**才能沿用既有的 reserved domain
   `unrefreshing-trudy-subsequently.ngrok-free.dev`；帳號不同這個 domain 用
   不了，換新 domain 或轉移 domain 的擁有權都超出本文件範圍，另外處理。
4. **根目錄 `.env`**（`/Users/user/aladdin/.env`）：至少要有下面「需要的
   環境變數」章節列的四個 `TG_*`/`PORT` 變數；`/create-mr` pipeline 本身還
   需要 aladdin 主線既有的其他環境變數（Notion token 等），隨 aladdin 主線
   走，不在本文件重複列。

### 路徑是寫死的，換機器前務必核對

目前這幾處**硬編碼絕對路徑**，假設帳號叫 `user`、aladdin 就在
`/Users/user/aladdin`：

| 檔案 | 寫死的內容 |
|---|---|
| `launchd/com.aladdin.tg-dispatch-server.plist` | `ProgramArguments`、`WorkingDirectory`、`StandardOutPath`、`StandardErrorPath`、`PATH`（含 `/Users/user/.bun/bin`） |
| `launchd/com.aladdin.tg-dispatch-tunnel.plist` | 同上四項 |
| `launchd/run-server.sh` | `ALADDIN="/Users/user/aladdin"`、`BUN="/Users/user/.bun/bin/bun"` |
| `launchd/run-tunnel.sh` | `NGROK="/opt/homebrew/bin/ngrok"`（Apple Silicon 的 Homebrew 路徑；Intel Mac 通常是 `/usr/local/bin/ngrok`，裝之前先 `which ngrok` 確認） |

- **新機器帳號同樣叫 `user`、aladdin 也 clone 在完全一樣的 `/Users/user/aladdin`**
  → 以上檔案不用改，直接把整個 repo（連同 `.env`）搬過去即可。
- **帳號或路徑不一樣** → 上面四個檔案都要對應改成新路徑，改完才能
  `cp ... ~/Library/LaunchAgents/` 並 `launchctl bootstrap`（見上一節）。

### 換機器時「要不要重新 `setWebhook`」

**不需要**——只要新機器用的是同一個 ngrok 帳號、同一個 reserved domain，
Telegram 端登記的 webhook 網址完全不變（`getWebhookInfo` 查到的 `url` 不會
變），換機器只是換了「誰在背後接手機請求」。**但兩台機器不能同時開著**
（ngrok 免費方案同時間只允許 1 個 tunnel session，見「已知操作風險」）：
正確順序是先在舊機器 `launchctl bootout` 兩支服務（或直接關機/停用），確認
舊 tunnel 真的斷了，再到新機器 `launchctl bootstrap` 啟動。中間會有一段
webhook 完全收不到訊息的空窗，選一個沒人在用的時段切換。

切換完務必**實際驗證一次**（比照 T21/T22 的收尾方式，不能只憑 process 有
在跑就判定成功）：`curl /health`、`getWebhookInfo` 確認網址與 `last_error_message`
正常、再用真實白名單 Telegram 帳號發 `/menu` 走一次完整流程確認收得到回覆。

## Telegram 端使用方式（技術人員視角）

前提：使用者的 `tg_chat_id` 必須已登記在
`obsidian/commands/create-mr/references/tech-users.csv`（新技術第一次 DM bot
之後，用 `/tg-chatid-sync` skill 把 chat_id 回填 CSV）；白名單外的 chat_id
發什麼都會被**靜默忽略**（不回覆、不報錯，見 T3）。

1. 對 bot（`@bug_analyst_bot`）發送斜線指令（T30，大小寫不敏感；2026-08-17
   改為指令必須帶 `/`，裸文字 `bug`/`req` 不再觸發，避免閒聊訊息剛好整句
   撞到指令字而誤觸）：
   - `/bug` → 直接依 Notion「當前指派」列出你名下的候選工單按鈕；沒有可認
     領單時明確回覆「目前沒有可認領工單」。
   - `/req` → 依 Notion『總需求池資料庫』列出你名下的候選需求單按鈕（T31/T32：
     判準是『技術處理人員』欄位含你本人 ∩ 狀態∈{文件完成待處理, 需求仍有問題}）；
     沒有可認領單時明確回覆「目前沒有可認領需求單」。點需求單按鈕會真的
     上鎖＋更新 Notion『AI分析』為『分析中』＋觸發背景 pipeline（T33/T36，
     見下方第 3 點）。
   - `/menu` → 頂層選單（`BUG` / `需求池` 兩顆按鈕，按鈕行為同上）。
   - 其他文字（含不帶 `/` 的 `bug`/`req`）→ 回覆用法提示（白名單內不靜默）。
2. 點清單中的 Bug 工單按鈕（`claim:{ticket}`）→ 上鎖防重複認領 → 背景觸發
   `/create-mr` pipeline（單張約 20–40 分鐘）。同一時間全域最多 5 條背景
   流程（T26），超過會明確回覆請稍後再試。結果通知：pipeline 正常結束時
   依 create-mr 自己的出口規則發 TG／留 Notion 留言（`already_fixed`／
   `i18n`／`failed` 只留 Notion 不發 TG）；只有流程**異常結束**（infra／
   CLI 層炸掉、無法辨識結果）才由 dispatcher 補發「⚠️ 需人工檢查」訊息附
   log 路徑（T13）。
3. 點需求單按鈕（`demand-claim:{ticket}`）→ 上鎖＋更新 Notion AI分析為
   『分析中』後，背景依序：(a) 判斷 Notion 規格內容夠不夠完整（T34 gate；
   2026-08-21 使用者定案改成給 Read/Grep/Glob 唯讀工具，先探索 codebase
   既有邏輯／同類欄位再判斷，不再只憑 Notion 文字表面判斷——不夠會直接
   通知你「規格不足，缺什麼」，不會硬做）(b) 判斷這張單會動到哪些 repo
   （T36 範圍偵測）——單一 repo 或跨多個 repo 都會繼續往下跑（2026-08-21
   使用者定案：原本跨 ≥2 個 repo 會直接標「需人工複核」不自動分析，2026-08-17
   定案的理由是 T35 回溯測試證實跨 repo 範圍窮盡性不可靠，但實測發現這個
   關卡連「明確知道要動哪三個 repo」的小需求都會擋，太保守；範圍窮盡性
   不可靠的風險本身沒有消失，改成一樣產出 plan.md 交人工複核把關，不再用
   「repo 數量」提前攔截）(c) 交給 demand-plan-pipeline.ts：判斷到的每個
   repo 各自建一個唯讀 worktree，draft×2→review×3→synthesize×1→classify×1，
   產出一份 plan.md，**不改任何 repo 程式碼**。同一時間全域最多 **2** 條
   需求 pipeline（獨立於上面 Bug 的 N=5，不共用計數器，見「已知操作風險」）。
   **這整條路徑目前是輔助草稿性質，不是自動完成**——不管哪個分支結束都會
   發 Telegram 通知，成功產出的情況下通知會附工作目錄路徑，**產出的內容
   不會自動 commit/push，必須人工複核**（T36）。

## 需要的環境變數（都放在根目錄 `/Users/user/aladdin/.env`）

| 變數 | 說明 |
|---|---|
| `TG_DISPATCH_BOT_TOKEN` | Telegram bot token（BotFather 核發） |
| `TG_WEBHOOK_PATH` | 隨機 hex 字串，webhook 路徑的一部分（見 T14），不是固定的 `/webhook` |
| `TG_WEBHOOK_SECRET` | grammy `secretToken`，Telegram 呼叫 webhook 時會帶在 header 裡驗證 |
| `PORT` | 選填，webhook server 監聽的本機 port，預設 `8787`；改動時記得 `launchd/run-tunnel.sh` 裡的 `PORT` 也要同步改，兩者必須一致 |

這幾個變數只透過 `process.env` 在啟動時讀（wrapper script 用
`grep '^KEY=' .env` 手法匯出，比照 `cron/bug-report-run.sh`），不會出現在
log 或任何被 git 追蹤的檔案裡（見 T15）。

## 已知操作風險

- **MacBook 睡眠會讓 webhook 漏接**：launchd 的 `KeepAlive` 只保證「process
  被殺掉會自動重啟」，不保證電腦本身沒睡眠。這台機器要插電、且系統設定要
  關掉「插電時允許進入睡眠」（系統設定 → 電池/節能 → 關閉螢幕後防止自動
  睡眠），否則整台機器睡著時 Telegram 送過來的更新會直接送達失敗，不會排隊
  等醒來後補送。
- **ngrok 免費方案同時間只允許 1 個 agent session**：如果有人在別台機器或
  同一台機器手動另外開一個 `ngrok http ...`，會把這支常駐的 tunnel 直接踢
  下線，且 `bun run server.ts` process 本身完全不會發現（它只是本機 port 沒
  人連得到，process 照樣活著）——**不要手動另開 ngrok session**。T19 的
  健康檢查（每分鐘查一次本機 ngrok admin API）會在這個情境發生時發 Telegram
  告警給維運者，但這是事後偵測，不是預防；最好的做法就是不要手動開第二個。
- **log 沒有 rotation，需要自行規劃**：`telegram-dispatcher/logs/` 底下的
  `*.log`（含 `launchd-*.log`、`post-run-notify.log`、`health-monitor.log`、
  以及每次觸發 `/create-mr` 產生的 `FAQ-*.stdout.log`/`.stderr.log`）會一直
  累積，沒有內建的自動清理或輪替機制。長期跑建議定期手動清（或另外排一個
  簡單的 cron 清舊檔），不清也不會讓服務壞掉，只是磁碟空間會一直長。
- **ngrok request inspector（本機 4040 web UI）不可對外開放**：`run-tunnel.sh`
  刻意沒有加任何會改變 `--web-addr` 綁定位址的旗標，維持 ngrok 預設只
  bind `127.0.0.1`（見 T18）。之後如果有人想改這支腳本，**不要**加
  `--web-addr 0.0.0.0:4040` 之類的設定對外開放——4040 admin API 沒有任何
  認證機制，對外開放等於任何人都能看到即時流量內容。
- **全域併發上限 N=5（T26），in-memory、webhook server 重啟會歸零**：同一時間
  最多 5 個 `claude -p /create-mr:create-mr` 背景流程在跑，第 6 個觸發會被
  明確拒絕（Telegram 回覆「已達全域併發上限，請稍後再試」），不會安靜排隊
  或卡住。計數器只活在 process 記憶體裡，重啟服務會歸零——如果重啟前真的
  還有背景流程在跑，重啟後的新計數器不會知道它們存在（這些舊流程本身不受
  影響，仍會照常跑完，只是不再被新的計數器算進去），是刻意接受的 trade-off
  （見 `lib/pipeline-runner/concurrency-limiter.ts` 檔頭註解）。
- **需求 pipeline 的全域併發上限 N=2，跟上面 Bug 的 N=5 是兩個獨立計數器**
  （T36，使用者 2026-08-17 定案）：需求 pipeline 是全新、範圍完整性還沒被
  充分驗證的 pipeline（T35 回溯測試已證實跨 repo 需求有真實遺漏風險），
  刻意跟已穩定運作的 Bug pipeline 分開、給更保守的上限，兩者不會互相搶
  額度也不會互相拖累。達到上限時該張需求單**不會自動排隊重跑**，回覆會
  明確告知需要稍後重新認領一次（`lib/pipeline-runner/spawn-demand-pipeline.ts`）。
- **需求 pipeline 的 worktree 不會自動清理**（`worktrees/{ALDREQ-ticket}/`）：
  跟 Bug pipeline（T28 完成後自動清理）不同，需求單的產出**就是**
  worktree 裡未 commit 的改動本身，人工複核完之前不能清掉，所以刻意不
  自動清。長期累積會佔用磁碟空間（每個都是完整 repo checkout，可能還帶
  `node_modules`），需要人工定期盤點、複核完之後手動清理：
  ```bash
  # 手動清理某張需求單的 worktree（ALDREQ-* 也支援，不是只有 FAQ-*）
  bun /Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/cleanup-worktree.ts ALDREQ-1234
  ```
- **需求 pipeline 的 draft/review/synthesize agent 給了唯讀工具權限
  （`--tools Bash,Read,Grep,Glob` + `--permission-mode bypassPermissions`，
  不含 Edit/Write/MultiEdit）**，這點跟 T36 的範圍偵測（`--tools ""
  --strict-mcp-config` 結構性清空工具）不同——給工具權限是這一步的必要
  條件（它真的要讀程式碼調查範圍與細節），風險跟既有 `/create-mr` 面對
  真實 bug report 外部內容時承擔的是同一類，但需求池內容的可編輯人員範圍
  可能比 Bug List 更廣，尚未逐一核實兩者信任等級是否真的對等，先如實記錄
  這個未驗證的假設。T34 的規格判斷（`spec-sufficiency-gate.ts`）
  2026-08-21 起也改成唯讀工具（`Read,Grep,Glob`，比上面更窄、不含 Bash），
  同一套理由。

## 工單鎖卡住時如何手動排除

> **這個鎖不是認領資格的權威來源。** 一張工單能不能被認領，一律只看 Notion
> 的狀態欄位（`queryCandidateTickets`），跟這個鎖存不存在無關——鎖只是防
> 「兩個 Telegram 使用者幾乎同時點同一張單」這個瞬間 race，claim 成功後
> spawn 背景流程前就立刻釋放（見 T11）。也**不要**跟 aladdin 主線的
> `bug_analysis_tracker.md`／`scripts/tracker.sh`（那套認領池）搞混，是完全
> 不同的兩件事——這個區隔是專案明文要求（見 `HOW-TO-CONTINUE.md`）。

`bug-lock.sh` 用 `mkdir` 做這個短暫的 race-condition mutex（見
`scripts/bug-lock.sh`）。正常情況下 `/create-mr` 自己的 Step 8（所有出口
路徑必經）與 T13 的 EXIT trap 安全網會確保鎖一定被釋放；如果懷疑某張單的
鎖卡住了（例如 `claim:{ticket}` 按鈕一直回「已被其他 session 認領」，但
實際上沒有任何背景流程真的在跑）：

```bash
# 查某張單目前鎖的狀態
bash /Users/user/aladdin/scripts/bug-lock.sh status FAQ-1234

# 確認過真的沒有任何背景流程在跑之後，手動釋放單一張單的鎖
bash /Users/user/aladdin/scripts/bug-lock.sh release FAQ-1234

# 或列出目前所有鎖，人工核對後決定要不要清
bash /Users/user/aladdin/scripts/bug-lock.sh list

# 極端情況（確定沒有任何流程在跑）：清掉全部鎖
bash /Users/user/aladdin/scripts/bug-lock.sh cleanup
```

`release`/`cleanup` 對沒上鎖的 ticket 是 no-op（不會因為鎖本來就沒上而報
錯），但釋放一個「其實還在跑」的鎖可能導致兩個流程同時處理同一張單——動手
前務必先用 `pipeline-status.sh`（`bash /Users/user/aladdin/scripts/pipeline-status.sh`）
或直接看 `worktrees/{ticket}/` 目錄是不是還在變動，確認真的沒有流程在跑。

## 查目前 Telegram 端實際登記的 webhook 狀態

收到 T19 健康檢查告警、或懷疑 webhook 沒收到訊息時，可以唯讀查 Telegram 端
目前登記的網址與 secret 是否跟 `.env` 一致（`getWebhookInfo` 不會動到任何
設定，安全隨時可查）：

```bash
BOT_TOKEN=$(grep '^TG_DISPATCH_BOT_TOKEN=' /Users/user/aladdin/.env | cut -d= -f2- | tr -d '\r\n')
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

回應裡的 `url` 欄位就是目前 Telegram 端實際打的網址——ngrok 這邊的網址是
**固定 reserved domain**（`launchd/run-tunnel.sh` 裡的 `TUNNEL_URL` 常數，
不會因為 tunnel 重啟而變），所以正常情況下 `url` 應該長期不變，跟
`launchd/run-tunnel.sh` 裡寫的網址 + `.env` 的 `TG_WEBHOOK_PATH` 兜起來要
完全一致；不一致或 `last_error_message` 不是空的，代表要重新呼叫
`setWebhook`（見下一節）。

## `TG_WEBHOOK_SECRET` 懷疑外洩時的手動輪替程序

1. **重新產生 secret**（跟 T14 當初產生的方式一致，32 bytes、base64url 編碼）：
   ```bash
   bun -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. **更新 `.env`**：把 `/Users/user/aladdin/.env` 裡 `TG_WEBHOOK_SECRET=` 那一行
   換成新值（新舊值只差在這一行，不要動到 `TG_WEBHOOK_PATH`——路徑要不要
   一起換是另一個決定，通常只有懷疑 secret 外洩時只需要換 secret；如果連
   路徑本身都懷疑外洩了，`TG_WEBHOOK_PATH` 也要用同樣方式重新產生一個純
   hex 字串，見 T14）。
3. **重啟 server**：讓新值生效（wrapper script 每次啟動都重新從 `.env`
   讀取，不會自己 reload）。
   ```bash
   launchctl bootout gui/$(id -u)/com.aladdin.tg-dispatch-server
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-dispatch-server.plist
   ```
4. **重新呼叫 `setWebhook`**：Telegram 端也要知道新的 secret，否則舊 secret
   失效後 Telegram 送來的請求全部會被新 server 判定為 secret_token 錯誤而
   拒絕（401）。比照其他 wrapper script 的手法從 `.env` 現讀現用，不要把值
   貼在指令歷史裡：
   ```bash
   ENV_FILE=/Users/user/aladdin/.env
   BOT_TOKEN=$(grep '^TG_DISPATCH_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
   WEBHOOK_PATH=$(grep '^TG_WEBHOOK_PATH=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
   WEBHOOK_SECRET=$(grep '^TG_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
   # ngrok 網址是固定 reserved domain（launchd/run-tunnel.sh 裡的
   # TUNNEL_URL 常數，不會因 tunnel 重啟而變），不是每次要另外去查的值。
   NGROK_URL="https://unrefreshing-trudy-subsequently.ngrok-free.dev"

   curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
     -d "url=${NGROK_URL}/${WEBHOOK_PATH}" \
     -d "secret_token=${WEBHOOK_SECRET}"
   ```
   （正式上線本身 `setWebhook` 只在 T22 執行一次，這裡只是輪替 secret 時要
   重跑同一個呼叫；換完可以用上一節的 `getWebhookInfo` 確認真的生效）。
