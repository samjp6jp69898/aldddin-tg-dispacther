# telegram-dispatcher

透過 Telegram bot 讓白名單內的技術人員認領 Bug 工單，認領後在背景觸發既有
的 `/create-mr` pipeline（詳見 `tasks.json` 的 `architecture_summary` 與
`HOW-TO-CONTINUE.md`）。本檔只講「怎麼部署/操作這支服務」，不重複那兩份
文件已有的架構/開發規則說明。

## 系統組成

三支獨立 launchd job（互不依賴對方的 process 存活）：

1. **webhook server**（`bun run server.ts`）：接 Telegram 送來的訊息/按鈕，
   查 Notion、觸發背景 pipeline。process 內部另有兩個 setInterval 週期任務：
   T19 tunnel 健康檢查（見下方「已知操作風險」）與 T26 逾時鎖回收（見「工單
   鎖卡住時如何手動排除」）。
2. **Cloudflare tunnel**（`cloudflared`，2026-08-22 起取代 ngrok）：把上面的
   server 對外暴露成 Telegram 打得到的 HTTPS 網址，`mcp.aladdin-assistant.cc`
   （自有網域，Cloudflare Registrar 註冊）。
3. **外部健康守門員（watchdog，2026-08-23 新增，預設未啟用）**：跟第 1 點
   webhook server 內部的健康檢查不同層次——它是 process「自己裡面」的定時
   任務，若 process 本身卡死（event loop 卡住，不是被殺掉），連這個定時任務
   自己都不會觸發，等於完全偵測不到。watchdog 是完全獨立的 launchd
   `StartInterval` job（`launchd/health-watchdog.sh`，每 120 秒觸發一次，不是
   常駐 process），從外部定期打 `/health`，連續 2 次打不到才判定掛掉（避免
   單次慢請求誤報），翻轉那一刻通知維運者並嘗試 `launchctl kickstart -k`
   自我修復一次（不會每次都重啟造成迴圈），持續掛著不重複通知，恢復時另外
   報一次恢復。**這支 job 目前只是把 plist／腳本寫好放著，尚未 bootstrap
   上線**（比照下方 webhook server／tunnel 的部署方式，需要另外手動啟用，
   見下一節）。

## 啟動 / 停止 / 查狀態

### 本機手動跑（開發、除錯用，不透過 launchd）

```bash
# 啟動 server（會一直佔用這個 terminal，Ctrl-C 停止）
zsh /Users/user/aladdin/telegram-dispatcher/launchd/run-server.sh

# 啟動 tunnel（另開一個 terminal；一旦執行就會真的對外開放，見下方風險）
zsh /Users/user/aladdin/telegram-dispatcher/launchd/run-cloudflared-tunnel.sh
```

兩支 wrapper script 都會自動從根目錄 `.env` 讀必要的環境變數，不需要自己
先 export。

### 透過 launchd 常駐（正式模式）

plist 定義檔放在 `telegram-dispatcher/launchd/`，**要先複製一份到
`~/Library/LaunchAgents/`**（launchd 只認這個目錄下的檔案，不會直接讀 repo
裡的路徑；`ProgramArguments` 裡的腳本路徑仍指回 repo，複製的只有 plist 本身）：

```bash
cp /Users/user/aladdin/telegram-dispatcher/launchd/com.aladdin.tg-dispatch-server.plist \
   /Users/user/aladdin/telegram-dispatcher/launchd/com.aladdin.tg-dispatch-tunnel-cloudflare.plist \
   ~/Library/LaunchAgents/
```

啟動（`bootstrap`，macOS 現行語法；舊語法 `launchctl load <path>` 也還能用）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-dispatch-server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-dispatch-tunnel-cloudflare.plist
```

停止（`bootout`；舊語法 `launchctl unload <path>`）：

```bash
launchctl bootout gui/$(id -u)/com.aladdin.tg-dispatch-server
launchctl bootout gui/$(id -u)/com.aladdin.tg-dispatch-tunnel-cloudflare
```

查狀態：

```bash
launchctl list | grep tg-dispatch
# 或看單一 job 的詳細狀態（PID、上次結束碼等）：
launchctl print gui/$(id -u)/com.aladdin.tg-dispatch-server
launchctl print gui/$(id -u)/com.aladdin.tg-dispatch-tunnel-cloudflare
```

### （可選）啟用外部健康守門員 watchdog

見上方「系統組成」第 3 點——這支 job 預設不會跟著上面兩支一起啟用，要另外
手動裝：

```bash
cp /Users/user/aladdin/telegram-dispatcher/launchd/com.aladdin.tg-dispatch-watchdog.plist \
   ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-dispatch-watchdog.plist

# 查狀態 / 停用
launchctl print gui/$(id -u)/com.aladdin.tg-dispatch-watchdog
launchctl bootout gui/$(id -u)/com.aladdin.tg-dispatch-watchdog
```

log 檔：`logs/health-watchdog.log`（腳本自己的判斷紀錄）、
`logs/launchd-watchdog.{out,err}.log`（launchd 層級）、
`logs/watchdog-state`（目前記的健康狀態，純文字 `state=`/`consecutive_failures=`
兩行，人工可直接看，不需要工具解析）。

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
3. **cloudflared**（2026-08-22 起取代 ngrok）：安裝後執行 `cloudflared tunnel login`
   （互動式瀏覽器授權，只有帳號擁有者能做）建立 `~/.cloudflared/cert.pem`。
   但**新機器不需要重新 `login` + `tunnel create`**——那會建出一條全新、不同 id
   的 tunnel。正確做法是把既有 tunnel 的 credentials-file
   （`~/.cloudflared/6906f8e7-e46e-43f3-abd5-b43bbaa96e3e.json`，等同私鑰）從
   原本那台機器安全複製過來（AirDrop/`scp`/USB，不要走任何會落地存放的通道），
   完整說明見 `mcps/_hosted-rollout/DEPLOY-TO-NEW-MACHINE.md` §4.1。網域
   `mcp.aladdin-assistant.cc` 是自有網域（Cloudflare Registrar 註冊），不像
   ngrok reserved domain 那樣綁在帳號的免費方案配額上。
4. **`telegram-dispatcher/.env`**（`/Users/user/aladdin/telegram-dispatcher/.env`）：至少要有下面「需要的
   環境變數」章節列的四個 `TG_*`/`PORT` 變數；`/create-mr` pipeline 本身還
   需要 aladdin 主線既有的其他環境變數（Notion token 等），隨 aladdin 主線
   走，不在本文件重複列。

### 路徑是寫死的，換機器前務必核對

目前這幾處**硬編碼絕對路徑**，假設帳號叫 `user`、aladdin 就在
`/Users/user/aladdin`：

| 檔案 | 寫死的內容 |
|---|---|
| `launchd/com.aladdin.tg-dispatch-server.plist` | `ProgramArguments`、`WorkingDirectory`、`StandardOutPath`、`StandardErrorPath`、`PATH`（含 `/Users/user/.bun/bin`） |
| `launchd/com.aladdin.tg-dispatch-tunnel-cloudflare.plist` | 同上四項 |
| `launchd/com.aladdin.tg-dispatch-watchdog.plist`（2026-08-23 新增，見下方「啟用外部健康守門員」）| 同上四項 |
| `launchd/run-server.sh` | `ALADDIN="/Users/user/aladdin"`、`BUN="/Users/user/.bun/bin/bun"` |
| `launchd/run-cloudflared-tunnel.sh` | `CLOUDFLARED="/opt/homebrew/bin/cloudflared"`（Apple Silicon 的 Homebrew 路徑；Intel Mac 通常是 `/usr/local/bin/cloudflared`，裝之前先 `which cloudflared` 確認） |
| `launchd/cloudflared-config.yml` | `credentials-file` 指到 `~/.cloudflared/<tunnel-id>.json`（見上方前置安裝第 3 點） |
| `launchd/health-watchdog.sh` | `HEALTH_URL`（組出 `http://127.0.0.1:8787/health`，跟 `PORT` 一致即可不用改）、`TG_NOTIFY_SH="/Users/user/aladdin/scripts/tg-notify.sh"`、`SERVICE_LABEL` |

- **新機器帳號同樣叫 `user`、aladdin 也 clone 在完全一樣的 `/Users/user/aladdin`**
  → 以上檔案不用改，直接把整個 repo（連同 `.env`）搬過去即可。
- **帳號或路徑不一樣** → 上面幾個檔案都要對應改成新路徑，改完才能
  `cp ... ~/Library/LaunchAgents/` 並 `launchctl bootstrap`（見上一節）。
- **watchdog 是獨立的第三支 job，不會跟著 server/tunnel 自動一起裝**：換機器
  時如果也要它，記得額外照著「（可選）啟用外部健康守門員 watchdog」那節的
  三個指令（`cp` → `bootstrap` → 用 `launchctl print` 確認）另外裝一次，不在
  上面 server/tunnel 的啟動流程裡。

### 換機器時「要不要重新 `setWebhook`」

**不需要**——只要新機器用的是同一個 Cloudflare 帳號、同一個網域
（`mcp.aladdin-assistant.cc`），Telegram 端登記的 webhook 網址完全不變
（`getWebhookInfo` 查到的 `url` 不會變），換機器只是換了「誰在背後接手機請求」。

**跟 ngrok 版的關鍵差異**：ngrok 免費方案同時間只允許 1 個 tunnel session，
換機器必須先關舊的才能開新的，中間必然有空窗；cloudflared **可以同時在多台
機器上為同一條 tunnel 跑多個 connector**（Cloudflare 官方支援的高可用模式，
邊緣會在多個 connector 之間分流），理論上兩台機器**可以同時開著**、逐步把
流量切過去。但這不代表隨便兩台機器同時開就是安全的：兩台機器各自跑的
`aladdin-admin`/`aladdin-platform` hosted server 是**各自獨立的行程**，各自
有獨立的 per-token 登入態容器（`sessions: Map`）與 `tokens.json` 名冊拷貝——
如果兩台機器的 `tokens.json` 內容不同步，同一個企劃打進來可能隨機落在
兩台不同的機器上、拿到不一致的登入態或名冊判定結果。**除非刻意要做多機
高可用（目前沒有這個設計），否則同一時間應該只有一台機器在跑完整的四個
launchd job**，只是「切換 tunnel connector」這一步本身不再需要製造空窗。

切換完務必**實際驗證一次**（比照 T21/T22 的收尾方式，不能只憑 process 有
在跑就判定成功）：`curl /health`、`getWebhookInfo` 確認網址與 `last_error_message`
正常、再用真實白名單 Telegram 帳號發 `/menu` 走一次完整流程確認收得到回覆。

## 多機擴容（head / worker 派工，2026-08-31 新增）

單機吞吐不夠時，可以把其他同網段的 Mac 加進來當 **worker**：目前跑
server.ts + tunnel + hosted MCP 的這台是 **head**（唯一入口——Telegram
webhook、Notion 查詢、認領判斷、派工決策都在它身上；tunnel 與 MCP 完全
不用動，也只該有一份）。head 自己也能跑 pipeline，worker 只是多出來的
執行容量。

**預設關閉**：`.env` 沒有 `CLUSTER_SHARED_SECRET` 時，所有 cluster 程式碼
是 no-op，行為與純單機完全相同。要啟用才需要做下面的事。

### 資料流

```
Telegram → head（webhook、白名單、Notion 重驗、per-ticket 鎖）
             ├─ 本機名額較多 → 本機 spawn（跟單機一模一樣）
             └─ 某台 worker 名額較多 → POST worker:8801 /jobs
                    worker 用同一套 submitCreateMr/submitDemandPipeline
                    在自己機器 spawn（鎖、佇列、stale-lock 回收、
                    TG 通知、Notion 回寫全部沿用單機機制，跑在 worker 上）
                    → pipeline 結束 → worker POST head /cluster/job-done
```

- 派工選擇：認領當下即時打各 worker `/capacity?ticket=<單號>` 比剩餘名額
  （順路問這張單在該機有無活動），取名額最多者，**平手本機優先**；只嘗試
  最佳一台（把最壞耗時鎖在 grammy webhook 的 10 秒預算內），失敗或全滿就
  進 head 本機的既有 FIFO 佇列。
- 重複防護：head 維護「派到哪台」登記表（`logs/cluster-dispatched.json`），
  跟本機鎖/佇列 running 集合互補；worker 端以「本機活動三合一」判定
  （in-memory queue ∪ `/tmp/bug-analysis-locks` 鎖目錄 ∪ ps 掃 wrapper
  行程，見 `lib/cluster/local-activity.ts`）——timeout 自動重試、
  stale-lock-reaper 重跑、人工終端這些 **out-of-band run** 也看得到，
  接單前撞到就回 already_running 讓 head 回填登記，絕不起第二條。
- 回報遺失自癒：worker 的 job-done 打不到 head、或 head 在交涉中重啟時，
  head 的 remote sweeper（每 10 分鐘）會向 worker 查證該單實況。原則是
  **寧可暫時卡住、絕不製造雙跑**：查證確認「已無任何活動」才清登記；
  worker **失聯不清登記**（登記在就擋得住重複認領），只告警一次等恢復，
  26 小時絕對上限才強制清除；需求單清除時依情境處理 Notion AI分析
  （見 `lib/cluster/remote-sweeper.ts` 檔頭）。
- 認證：所有 head↔worker 請求帶 `x-cluster-token`（常數時間比較）；head 的
  `/cluster/*` 額外擋掉帶 `CF-Connecting-IP` 的請求——經 tunnel 從公網進來
  的一律 401，這組路由只在 LAN 上存在。

### head 啟用步驟

1. `.env` 加 `CLUSTER_SHARED_SECRET=$(openssl rand -hex 32)`（≥32 字元，
   太短會被視同未設定）。
2. 重啟 server：`launchctl kickstart -k gui/$(id -u)/com.aladdin.tg-dispatch-server`。
   啟動 log 出現 `cluster: head 模式啟用` 即生效。
3. **從 head 遠端體檢任何一台 worker**（日常也可隨時重跑，唯讀無副作用）：

```bash
# 不需要在 worker 上放檔案，腳本走 stdin 過去
ssh user@<worker_ip> 'bash -s' < /Users/user/aladdin/telegram-dispatcher/deploy/doctor-worker.sh

# 只看紅燈與警告
ssh user@<worker_ip> 'bash -s' < /Users/user/aladdin/telegram-dispatcher/deploy/doctor-worker.sh | grep -E "❌|⚠️|體檢"
```

   判讀：`❌` 代表這台不能用，修完再上線；`⚠️` 代表能接單、但某類收尾要人工
   補（目前唯一一項是 glab 未認證 ⇒ 開不了 MR，分析與推分支不受影響）。
   離開退出碼只計 `❌`，警告不會讓它非零。

   ⚠️ 這支腳本以前對執行方式很敏感：非互動 shell 的 `PATH` 只有
   `/usr/bin:/bin:/usr/sbin:/sbin`，會把裝在 `/opt/homebrew/bin` 的 `timeout`、
   `glab` 全部誤報成缺失（2026-09-03 據此誤判 worker 沒裝 glab，實際上裝著、
   缺的只是認證）。腳本開頭現在會自行補上 Homebrew 路徑，上面兩種寫法都安全。

### worker 部署步驟（新機）

前提跟「在另一台機器部署」一節相同：帳號叫 `user`、整個 aladdin 生態系
放在一模一樣的 `/Users/user/aladdin`（**約定同路徑**，不做路徑參數化）。
worker **不需要** cloudflared/tunnel/webhook——那些是 head 專屬。

1. `bash telegram-dispatcher/deploy/bootstrap-worker.sh`：冪等引導腳本，
   能自動做的（symlink 重建、bun install、目錄、plist 複製）自動做，需要
   人工的（repo clone、.env 安全複製、claude 登入、glab auth）印成待辦
   清單。重跑到 0 待辦為止。
   ⚠️ 待辦清單裡有一組**非 git 資產**（第 6 節）特別容易被忽略，因為缺了
   不會讓任何東西報錯，只會讓 pipeline 靜默地做錯事——2026-08-31 建 landon2
   時三項全漏、體檢當時也沒檢查，結果兩天內 7 張派過去的單全部白跑：
   `~/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md`
   （缺 → 每張單在 `/create-mr` Step 0.1 判 not claimable、幾十秒 SKIPPED）、
   `~/.claude/gdrive.sh` + `gdrive_token.json`（缺 → 文件上傳全失敗、Notion
   留言沒有連結）、`cqa-e2e/`（缺 → grounding 畫面取證降級 DEGRADED）。
   三項都要從 head 推過去，指令印在待辦裡。
2. `.env` 補四個 worker 變數（值的說明見 `launchd/run-worker-agent.sh`
   檔頭）：`CLUSTER_SHARED_SECRET`（與 head 同值）、`CLUSTER_HEAD_URL`、
   `CLUSTER_WORKER_NAME`、`CLUSTER_WORKER_URL`。head/worker 都建議在
   路由器上做 DHCP 固定 IP。
3. `bash telegram-dispatcher/deploy/doctor-worker.sh`：唯讀體檢（工具鏈、
   repo 遠端連通、symlink、**非 git 資產**、.env、head 連通性、電源設定），
   **沒有 `❌` 才上線**。也可以不登入這台、直接從 head 遠端跑（見「head 啟用
   步驟」第 3 項）。兩種等級的差別：
   - `❌` = 這台不能用（推拉不通、.env 缺、tracker 缺⋯⋯），修完再跑一次。
   - `⚠️` = 能接單，但某類收尾要人工補。目前唯一一項是 **glab 未認證**：
     git 推拉走 SSH key（含 `.ppk`）沒問題，但開 MR 走的是 GitLab **API
     token**，兩者是不同憑證——2026-09-03 三張單全部分析成功、分支也推上
     origin，卻卡在 `glab mr create`，就是這個差別。缺這項的 worker 跑出來的
     單會停在 `failed`（或 MR 內容不更新），要有人事後在 head 補開/補更新。
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-worker-agent.plist`。
   worker agent 啟動時會自動向 head 登記（其後每 30 分鐘冪等重送），不用
   手動改 head 的任何檔案。**worker 退役**：先 `launchctl bootout` 該機的
   worker agent，再刪 head 上 `logs/cluster-workers.json` 對應行並
   **重啟 head server**（名冊在 head 記憶體有快取，只改檔案不重啟不生效；
   不重啟也無害——派工探測打不通會自動跳過，只是多一次 2.5 秒的失敗探測）。
5. 驗收：對 bot 認領一張測試單，確認 head log 出現派工紀錄、worker 上
   pipeline 真的跑起來、結束後 TG 通知照常送達。

### head → worker 程式碼派送（`deploy/sync-workers.sh`，2026-09-01 新增）

`aladdin_ai`（commands/agents/skills/scripts）、`telegram-dispatcher` 與 `aladdin_mcps`
改了之後，worker 不會自己更新——之前得逐台登入 `git pull`。現在在 head 上跑一支即可：

```bash
# 1. 人先 push（腳本不代推；head 本機 main 領先 origin/main 會直接拒跑）
# 2. 派送到名冊裡全部 worker
bash telegram-dispatcher/deploy/sync-workers.sh              # 全部
bash telegram-dispatcher/deploy/sync-workers.sh --worker landon2   # 只一台（名稱或 IP）
bash telegram-dispatcher/deploy/sync-workers.sh --dry-run    # 只看會做什麼
```

每台 worker 上做的事：三個 repo `git pull --ff-only origin main`（有未 commit 的已追蹤
變更或分岔 commit 就拒絕並回報，不 stash、不 reset）→ `telegram-dispatcher` 的
`package.json`/`bun.lock` 有變才 `bun install --frozen-lockfile` → `sync-mirrors.sh --check`
symlink 健檢 → `launchctl kickstart -k` 重啟 worker agent → 回報三個 repo 的 HEAD、
head 端比對是否等於 `origin/main`。

- **進行中的 pipeline**：worker 上 `/tmp/bug-analysis-locks/` 有 ticket 鎖時**預設跳過重啟**
  （回報 `restart=skipped(N jobs)`，pull 仍會做），等單跑完再跑一次或 `--force-restart`。
  重啟 agent 不會殺掉已 spawn 的 pipeline，但那些單的 `/cluster/job-done` 回報會丟，
  由 head 的 remote sweeper 10 分鐘內補查——所以能等就等。
- **一次性前提（每台 worker）**：系統設定 → 一般 → 共享 → 開「遠端登入」允許 `user`；
  從 head 執行 `ssh-copy-id user@<worker_ip>`；`doctor-worker.sh` 已加「Remote Login」
  檢查（22 port 監聽 + `authorized_keys` 非空）。
- 名冊來自 `logs/cluster-workers.json`（`disabled: true` 跳過）；ssh 用 `BatchMode`
  免密連線，連不上／權限不足會回 `WORKER_FAIL <name> ...` 並 exit 1，不會半途卡住。
- 主程式碼 repo（agrabah/abu/lago/rajah）**不在派送範圍**——pipeline 自己每次
  `fresh-pull.sh` + `setup-worktree.sh` 會拉，不需要預先同步。

### 已知限制（v1，刻意的取捨）

- **Claude 帳號額度是共享的**：多台機器若共用同一個 Claude 訂閱/帳號，
  rate limit 與用量池不會因為加機器而變大——擴容解的是單機 CPU/記憶體
  瓶頸；若瓶頸在帳號額度，要搭配各機獨立帳號或 API billing 才有意義。
- （2026-09-01 起已解除，保留紀錄）舊版限制：head 本機 FIFO 佇列裡的單只會
  在**本機**名額釋放時遞補，不會在 worker 釋放名額時撿去遠端跑。現在改成
  cluster-wide 遞補（`lib/cluster/backlog-dispatcher.ts`）：head 佇列只在全
  cluster（本機 + 全部 worker）滿員時才累積，之後不管本機或哪一台 worker
  先釋放名額，都會把隊頭遞補過去——worker 端 `/cluster/job-done` 回報是主要
  觸發點（事件驅動），該回報是 best-effort（worker 打不到 head 時無法送達），
  所以另外有一顆跟 remote sweeper 共用的 10 分鐘週期性掃描當安全網，逐台探測
  名額補救漏接的回報。
- tg-monitor 只看得到自己機器上的 pipeline；派去 worker 的單要去 worker
  的 logs/ 看。tg-monitor 的重試按鈕也只影響本機，且看不到遠端登記表——
  避免對「派在別台跑的單」按重試。
- `bug_analysis_tracker.md`（2026-09-03 起改為 head 唯一權威，取代舊的「每台
  各一份、事後靠 `/sync-bug-tracker` 補正」策略）：worker 接單前向 head 抓一份
  完整覆蓋本機（`GET /cluster/tracker`），跑完把該單終態隨 `job-done` 回寫
  head。全程降級不阻斷——head 打不到、回應格式不對、或本機正有人在寫（搶不到
  `tracker.sh` 那把檔級鎖）都只記 log、沿用本機那份繼續接單。新舊版本雙向
  相容，任一端單獨上線都不會壞。細節見 `lib/pipeline-runner/tracker-sync.ts`
  的「整檔同步」段落。`/sync-bug-tracker` 仍有用，但範圍縮到「head 與 Notion
  之間」這一層。**新機器仍需先人工複製一份**（worker-agent 起來之前就得存在，
  見上面建置步驟第 1 項與 `doctor-worker.sh` 的「非 git 資產」節）。
- worker 機同樣要插電、關閉「插電時允許進入睡眠」（doctor 會檢查），睡著
  等於這台從派工池消失（head 探測不到會自動跳過，不會壞流程，只是少一台）。
- worker agent 的 8801 只該存在於受信任的 LAN；不要在路由器上對它做任何
  port forwarding。

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

## 需要的環境變數（都放在 `/Users/user/aladdin/telegram-dispatcher/.env`）

| 變數 | 說明 |
|---|---|
| `TG_DISPATCH_BOT_TOKEN` | Telegram bot token（BotFather 核發） |
| `TG_WEBHOOK_PATH` | 隨機 hex 字串，webhook 路徑的一部分（見 T14），不是固定的 `/webhook` |
| `TG_WEBHOOK_SECRET` | grammy `secretToken`，Telegram 呼叫 webhook 時會帶在 header 裡驗證 |
| `PORT` | 選填，webhook server 監聽的本機 port，預設 `8787`；改動時記得 `launchd/run-tunnel.sh` 裡的 `PORT` 也要同步改，兩者必須一致 |
| `CLUSTER_SHARED_SECRET` | 選填（多機派工用，≥32 字元）。設定後 head 啟用 cluster 模式；worker 機另需 `CLUSTER_HEAD_URL`/`CLUSTER_WORKER_NAME`/`CLUSTER_WORKER_URL`，見「多機擴容」一節與 `launchd/run-worker-agent.sh` 檔頭 |

這幾個變數只透過 `process.env` 在啟動時讀（wrapper script 用
`grep '^KEY=' .env` 手法匯出，比照 `cron/bug-report-run.sh`），不會出現在
log 或任何被 git 追蹤的檔案裡（見 T15）。

## 已知操作風險

- **MacBook 睡眠會讓 webhook 漏接**：launchd 的 `KeepAlive` 只保證「process
  被殺掉會自動重啟」，不保證電腦本身沒睡眠。這台機器要插電、且系統設定要
  關掉「插電時允許進入睡眠」（系統設定 → 電池/節能 → 關閉螢幕後防止自動
  睡眠），否則整台機器睡著時 Telegram 送過來的更新會直接送達失敗，不會排隊
  等醒來後補送。
- **（2026-08-22 起已改善，保留紀錄）ngrok 免費方案同時間只允許 1 個 agent
  session**：舊版風險——如果有人手動另外開一個 `ngrok http ...`，會把常駐的
  tunnel 直接踢下線，且 `bun run server.ts` process 本身完全不會發現。改用
  cloudflared 後這個限制不存在（同一條 tunnel 可以有多個 connector 同時連
  Cloudflare 邊緣，見上方「換機器時要不要重新 setWebhook」一節），但 T19 的
  健康檢查（每分鐘查一次本機 cloudflared metrics `/ready`）如果偵測到
  `readyConnections` 掉到 0，仍然是事後偵測、不是預防——本機 process 或
  網路本身出問題時，這個風險依然存在，只是觸發原因不再是「別人搶了 session」。
  這個內建健康檢查本身還有一個範圍缺口：它跑在 webhook server process
  「自己裡面」，若 process 本身卡死（event loop 卡住，不是被殺掉），連這個
  檢查自己都不會觸發——2026-08-23 新增的外部 watchdog（見上方「系統組成」
  第 3 點）就是補這個缺口，但預設未啟用，需要另外手動 bootstrap。
- **啟用外部 watchdog 前建議先知道的風險（2026-08-23 對抗性 review 發現）**：
  `stale-lock-reaper.ts`（T26）真的抓到逾時鎖時，回收動作（release／清
  worktree／通知）全程同步、跟 webhook server 共用同一條主 event loop，
  最壞情況（單一 repo 就要跑到 4 段各 30 秒上限的 git 操作）理論上可以讓
  event loop 卡住到數分鐘，同一段時間內 webhook 完全無回應。日常沒有逾時
  鎖時無感，只在真的觸發回收（斷電重開機、kill -9 這類 T26 本來就要處理的
  情境）才會發生。**若這段時間剛好碰上外部 watchdog 的偵測窗口**（連續 2 次
  ×120 秒 = 4 分鐘），`/health` 答不出來可能被誤判成「掛了」，觸發不必要的
  `launchctl kickstart -k`，反而中斷正在進行的回收流程。目前 watchdog 還沒
  上線，這個交互作用不會發生；之後真的要啟用 watchdog，建議先把
  `reapStaleLocks` 的回收動作改成非同步，或至少知悉這個風險存在
  （`lib/pipeline-runner/stale-lock-reaper.ts` 檔頭有對應註解）。
- **log 沒有 rotation，需要自行規劃**：`telegram-dispatcher/logs/` 底下的
  `*.log`（含 `launchd-*.log`、`post-run-notify.log`、`health-monitor.log`、
  `stale-lock-reaper.log`、`health-watchdog.log`，以及每次觸發 `/create-mr`
  產生的 `FAQ-*.stdout.log`/`.stderr.log`）會一直累積，沒有內建的自動清理或
  輪替機制。長期跑建議定期手動清（或另外排一個簡單的 cron 清舊檔），不清也
  不會讓服務壞掉，只是磁碟空間會一直長。
- **push/MR 建立失敗會通知維運者，不是這張 ticket 的指派人**（2026-08-23）：
  `/create-mr` 內部 Step 6 review PASSED 就會把完成報告的 Pipeline status 定
  為 success，即使後續 mr-pusher 的 `git push` 成功但 `glab mr create` 全數
  失敗、把 Notion「AI分析」改回「分析失敗」也不會回頭改那份報告。
  `post-run-notify.ts` 對每個回報 success 的 ticket 都會額外查一次 Notion 的
  AI分析 真實值，兩者不一致時直接 TG 通知維運者（不是走一般 ticket 指派人
  補發通知那條路——這是基礎設施層級的異常，指派人不一定有權限排查
  push/MR 失敗原因）。
- **cloudflared metrics server（本機 20241）不可對外開放**（2026-08-22 起，
  取代 ngrok 4040 admin/inspector 的同類風險）：預設只 bind `127.0.0.1`（見
  `run-cloudflared-tunnel.sh` 啟動時的 log「Starting metrics server on
  127.0.0.1:20241」）。之後如果有人想改 `cloudflared-config.yml` 或啟動參數，
  **不要**加任何會讓 metrics server 綁到 `0.0.0.0` 的設定對外開放——`/metrics`
  沒有任何認證機制，對外開放等於任何人都能看到 tunnel 連線/流量統計。
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
路徑必經）與 T13 的 EXIT trap 安全網會確保鎖一定被釋放。

**2026-08-23 起大多數情況不需要手動處理了**：webhook server 內建
`lib/pipeline-runner/stale-lock-reaper.ts`，每 10 分鐘掃一次所有鎖，持有
超過 130 分鐘（遠高於 WRAPPER_SCRIPT 的 `timeout 7200` 上限，見該檔案檔頭
註解）的鎖會被自動釋放並清理對應 worktree，Bug 工單（`FAQ-*`）額外自動重試
一次（`ALDREQ-*` 需求單不自動重試，需人工重新認領，沿用 T36 既有的保守
政策），每次自動回收都會 Telegram 通知維運者。這涵蓋了 T26 已知操作風險
記錄的「手動 `kill -9` 整組砍掉背景流程」與「機器斷電重開機」這兩種 EXIT
trap 完全沒機會執行的情境——不必再手動判斷。

**只回收 dispatcher 自己 spawn 的鎖**（review 發現並修正的重要邊界）：
`bug-lock.sh` 是全 aladdin 共用的鎖，人工在終端機互動跑 `/create-mr`、
`/create-mrs` 批次、back-testing pipeline claim 的鎖跟 dispatcher 觸發的鎖
用的是**同一個**鎖目錄。stale-lock-reaper 靠 `lib/pipeline-runner/
active-pipeline-marker.ts`（dispatcher spawn 背景流程時另外寫的標記檔，跟
`bug-lock.sh` 完全分開）分辨「這個鎖是不是我 spawn 的」——沒有標記的鎖（人工
/批次觸發）完全不會被自動回收，就算持有超過 130 分鐘也一樣，避免打斷正在
合法進行中的人工 review/暫停查證。

以下手動排除方式保留給**逾時鎖回收還沒觸發（130 分鐘內）就想確認狀態**、或
自動回收本身失敗（見 `logs/stale-lock-reaper.log`）的情況：

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
BOT_TOKEN=$(grep '^TG_DISPATCH_BOT_TOKEN=' /Users/user/aladdin/telegram-dispatcher/.env | cut -d= -f2- | tr -d '\r\n')
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

回應裡的 `url` 欄位就是目前 Telegram 端實際打的網址——Cloudflare Tunnel 這邊
的網址是**自有固定網域**（`mcp.aladdin-assistant.cc`，由 `cloudflared tunnel
route dns` 建立 DNS route，不會因為 tunnel 重啟而變），所以正常情況下 `url`
應該長期不變，跟 `mcp.aladdin-assistant.cc` + `.env` 的 `TG_WEBHOOK_PATH` 兜
起來要完全一致；不一致或 `last_error_message` 不是空的，代表要重新呼叫
`setWebhook`（見下一節）。

## `TG_WEBHOOK_SECRET` 懷疑外洩時的手動輪替程序

1. **重新產生 secret**（跟 T14 當初產生的方式一致，32 bytes、base64url 編碼）：
   ```bash
   bun -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. **更新 `.env`**：把 `/Users/user/aladdin/telegram-dispatcher/.env` 裡 `TG_WEBHOOK_SECRET=` 那一行
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
   ENV_FILE=/Users/user/aladdin/telegram-dispatcher/.env
   BOT_TOKEN=$(grep '^TG_DISPATCH_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
   WEBHOOK_PATH=$(grep '^TG_WEBHOOK_PATH=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
   WEBHOOK_SECRET=$(grep '^TG_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
   # 網址是自有固定網域（2026-08-22 起，先前為 ngrok reserved domain），
   # 不會因 tunnel 重啟而變，不是每次要另外去查的值。
   TUNNEL_URL="https://mcp.aladdin-assistant.cc"

   curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
     -d "url=${TUNNEL_URL}/${WEBHOOK_PATH}" \
     -d "secret_token=${WEBHOOK_SECRET}"
   ```
   （正式上線本身 `setWebhook` 只在 T22 執行一次，這裡只是輪替 secret 時要
   重跑同一個呼叫；換完可以用上一節的 `getWebhookInfo` 確認真的生效）。

## ops-ui：技術同事的瀏覽器派工台（`/ops`，2026-09-08）

`https://mcp.aladdin-assistant.cc/ops/`——技術同事不用再靠 bot 的 `/status`，在瀏覽器就能看
**進行中／待處理／處理過**三個分頁，對「指派給自己」的待處理單直接按「啟動」觸發既有 pipeline，
每張單都有 Notion 連結，並即時顯示 Notion 的『狀態』／『AI分析』現值。程式碼在 `lib/ops-ui/`
（`routes.ts` 檔頭有完整防線說明），掛在同一支 webhook server（8787）上，經既有 cloudflared tunnel 對外。

- **兩道門檻，缺一不可**：
  1. 公司網路：`.env` 的 `OPS_ALLOWED_CIDRS`（逗號分隔 IP/CIDR）比對 Cloudflare 注入的
     `CF-Connecting-IP`；未設定＝全部拒絕（fail-closed），被拒的來源 IP 會記在
     `logs/launchd-server.err.log`（`ops-ui: 來源 IP 不在 OPS_ALLOWED_CIDRS 內 …`），要加白名單就從那裡抄。
  2. Telegram 身分：頁面用 Telegram Login Widget，回呼由 bot token 驗簽後比對
     `tech-users.csv` 的 `tg_chat_id`——只有 bot 白名單內的人登得進來，登入有效 24 小時，server 重啟即失效。
- **一次性設定（人工）**：到 BotFather 對 dispatcher bot 執行 `/setdomain`，填 `mcp.aladdin-assistant.cc`，
  否則 widget 會顯示 *Bot domain invalid*。`OPS_PUBLIC_ORIGIN` 通常不用填（經 tunnel 時由 Host 推導）。
- **啟動規則**：跟 TG bot 完全同一條決策核心（`lib/locking/claim.ts` 的 `claimBugTicket`／
  `demand-claim.ts` 的 `claimDemandTicket`），只能啟動 Notion『當前指派』（Bug）／『技術處理人員』
  （需求單）含本人的單；別人的單只能看與開 Notion。回覆文字與 TG 一字不差。
- **資料來源**：待處理＝Notion 候選單查詢（全隊，快取 15 秒）；進行中＝監控 DB `runs`（queued/running）
  ∪ 本機鎖目錄 ∪ 佇列快照 ∪ 遠端派工登記表，進度文字沿用 `/status` 的還原邏輯；處理過＝監控 DB `runs`
  終態列（`MON_DB_ENABLED` 關閉時該分頁只顯示未啟用）。
- **改完程式碼要重啟**：`launchctl kickstart -k gui/$(id -u)/com.aladdin.tg-dispatch-server`。
- 測試：`NODE_ENV=test bun test lib/ops-ui`。
