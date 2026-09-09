# pipeline_monitor 監控 DB（Phase 0）

見完整計畫：`scratchpad/plan-db-as-truth-v3.2.md`（修訂節）＋
`scratchpad/plan-db-as-truth-v3.md`（骨架全文）。本檔只記錄 Phase 0 落地後的操作事實。

## 容器

- 名稱 `mon-mysql`，image `mysql:8.4.6`（固定 tag），publish `127.0.0.1:3307:3306`。
- datadir：`/Users/user/aladdin/mysql_store/mysql-monitor-data`（repo 外，`git clean -xfd` 不會刪到）。
- 與 dev 用的 `db-mysql`（3306）完全獨立，本案不碰那顆。
- 建立：`./run-container.sh`（冪等）。套 schema + 建帳號：`./migrate.sh`（冪等）。

## 帳號（逐表最小權限）

| 帳號 | 用途 | 密碼存放位置 |
|---|---|---|
| `mon_head` | head `server.ts`、名冊 CLI、回填腳本 | `telegram-dispatcher/.env`（`MON_DB_PASSWORD`） |
| `mon_ui` | `tg-monitor` 讀取面 + cancel 旗標欄位級寫入 | 暫存於 `~/.aladdin-secrets/monitor-db/mon_ui.env`，**尚未寫入 `tg-monitor/.env`**（見下方「已知缺口」） |
| `mon_exec` | 每台 worker（Phase 3 才部署） | 暫存於 `~/.aladdin-secrets/monitor-db/mon_exec.env`，**尚未部署到任何 worker** |
| root | 只給 `migrate.sh` / `backup.sh` 用 | `telegram-dispatcher/.env`（`MON_DB_ROOT_PASSWORD`）＋ `~/.aladdin-secrets/monitor-db/root.env` |

`~/.aladdin-secrets/monitor-db/` 為 0700 目錄、內部檔案 0600，位於所有 repo 之外。

## 已知缺口（本輪未完成，需使用者裁定後續作）

- **`tg-monitor` 完全未觸碰**：`tg-monitor` 工作區在本輪開始前已有 5 個檔案的既有未 commit 改動
  （`lib/cluster-state.ts`、`lib/db.ts`、`lib/ingest.ts`、`public/index.html`、`server.ts`），
  且領先 origin/main 4 個 commit。v3.2 的 MAJOR-F7 修訂明文要求「先請使用者裁定這些既有改動
  （commit 或 stash），否則本案改動會與它們混在一起、`git revert` 失效」——這正是本次執行的
  硬性排除項之一。因此：
  - `tg-monitor/.env` / `.gitignore` / `.env.example` 未建立。
  - `tg-monitor/launchd/run-monitor.sh` 的 `MON_DB_ENABLED` 白名單未加。
  - `mon_ui` 帳號雖已在 DB 建好且通過 Phase 0 驗收（用暫存密碼直測），但密碼尚未落地到
    `tg-monitor/.env`，cancel 旗標與 UI 讀取面實際上還無法運作。
- **worker 部署與 SSH tunnel 完全未做**（Phase 3 工項，本輪明確排除）：`mon_exec` 密碼未 scp
  到任何 worker，`com.aladdin.monitor-tunnel.<worker>` 尚未建立。

## Schema

- `migrations/001-init.sql`：Phase 0 骨架，涵蓋 §11.1 全部 14 張表（含 `schema_migrations`）。
- 這是骨架，不是最終定案：`outcome_tier` 的 `TINYINT NULL` + 兩條 CHECK（裁定2）已落地並通過
  `doctor-monitor.sh` 驗證；其餘欄位的完整型別/索引/生成欄位細節仍待 Phase 1 依 §6.2.1 S1–S11
  的實測結果，以後續 migration（`002-*.sql` 起）校正——**不得回頭改 `001-init.sql`**。

## Token registry fail-safe（`lib/registry/token-registry.ts`，BL-C4 / §5.9）

七步流程（reconcile → 寫 DB → 投影 → 雙向差異閘門 → 備份 → 原子寫 → 投影後驗證）
的殘餘風險，Phase 5 對抗性覆核（`SIDE_EFFECT_VERDICT: ACCEPTABLE`）逐條記錄如下：

- **R1（守衛式 ODKU 落地後已消解）**：`issueToken()` 的 rotate 型撞上「檔案還有、
  DB 已撤銷」的列時，`ISSUE_UPSERT_SQL` 的 `ON DUPLICATE KEY UPDATE` 對
  `token_enc` / `token_bidx` / `issued_at` / `display_name` 四欄各自包一層
  `IF(revoked_at IS NULL, new.x, x)`——已撤銷列撞上 rotate 時四欄**維持原值**，
  舊密文、bidx、原核發時間**不再遺失**。行為方向不變：`revoked_at` 仍不重設、
  投影仍少這一筆、雙向差異閘門仍以「未預期 removed」中止並保留舊檔、`alert`
  仍恰發一次。（採納自審查報告 §B.2(4)(甲)；單元測試見
  `lib/registry/token-registry.test.ts` 的「守衛式 ODKU」案例。）
- **R2（bidx 反查誤讀警告）**：`token_bidx` 是確定性 HMAC
  （`HKDF-SHA256(MON_BIDX_KEY, info='mcp_tokens.token')`），事件應變時若拿一把
  外洩的舊 token 值去查 `WHERE token_bidx = ?`，**只要該列後續被 rotate 過**，
  查詢會回 0 列（rotate 後的新密文/bidx 已取代舊值）。**不得**把 0 列讀成
  「這不是我們發的 token」——真正決定 token 是否有效的是名冊檔（fail-closed、
  每個 request 現讀），DB 從來不是認證來源；查無此 bidx 只代表「這個值不是
  *目前* 掛在該 id 上的值」，不代表「這個 id 沒發過這個值」。
- **R3（中止後的復原程序固定兩步，不能只做第一步）**：雙向差異閘門因「DB 該列
  已被撤銷、但檔案還有」而中止後，正確復原程序是 **① 清 `revoked_at`（`UPDATE
  mcp_tokens SET revoked_at = NULL WHERE server=? AND env=? AND token_id=?`）
  → ② 重跑一次 rotate（`issueToken` 對同一個 id）**，兩步缺一不可。**只清
  `revoked_at` 就當作已復原是錯的**：這只解除了撤銷狀態，不保證 DB 該列此刻的
  `token_enc`/`token_bidx`/`issued_at` 與名冊檔完全一致（尤其操作者的原始意圖
  通常就是「重簽一把新的」，而不是讓舊 token 原封不動地重新生效）；沒有接著跑
  ② 的話，後續任何操作重新投影比對時，只要 DB 與檔案這一欄有任何一絲不一致
  （token 不符、`issued_at` 不符等），雙向差異閘門就會以「未預期 changed／
  removed」持續擋下，需要再次人工介入才能跳出。務必**兩步都做**，讓
  ② 的 rotate 把 DB 與名冊重新收斂成同一次寫入、同一組欄位值。

## 健康檢查

`../doctor-monitor.sh`：容器健康、publish 位址、三條帳號驗收（含裁定3 的欄位級負向驗收）、
`outcome_tier` CHECK 存在性、VictoriaLogs 四項驗收、`monitor-log-intake`（9429）三條身分驗證、
四支 wrapper 白名單、備份新鮮度、mysql2 pin（Phase 1 前恆 N/A）、tunnel job（Phase 3 前恆 N/A）。

## 備份

`./backup.sh`：每日 `mysqldump` 到 `~/.aladdin-backups/monitor-db/`（0700 目錄、0600 檔），
保留最近 14 份。由 launchd job `com.aladdin.monitor-db-backup`（每日 03:00）觸發。

## 回滾

```bash
docker rm -f mon-mysql
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.victorialogs.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.monitor-log-intake.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.monitor-db-backup.plist
rm -rf /Users/user/aladdin/mysql_store/mysql-monitor-data
brew uninstall victorialogs   # 若要连 brew pin 一起復原
```
`run-server.sh` / `run-worker-agent.sh` 只新增了 `MON_DB_ENABLED` 一個 key，`git diff` 即可還原。
零影響既有服務（`MON_DB_ENABLED` 預設關閉，遷移前後行為相同）。

## Phase 3 部署順序（一次原子部署）

出處：`scratchpad/plan-db-as-truth-v3.md` §9 Phase 3（v3.2 修訂版，裁定 4 / BL-G1 /
MAJOR-D3 / §9.0(G)）。**順序做反了會壞**，六步依序做，任一步沒過就停在那一步——
不跳到下一步，也不用等待（sleep/輪詢）掩蓋還沒真的過的檢查。

1. **先 scp `.env`**：head / `tg-monitor` / 每台 worker 各自的 key 清單補齊
   （worker 只補 `MON_DB_ENABLED`、`MON_DB_HOST=127.0.0.1`、`MON_DB_PORT=3307`、
   `MON_DB_SCHEMA`、`MON_DB_USER=mon_exec`、`MON_DB_PASSWORD`）。
   **worker 的 `telegram-dispatcher/.env` 一律 `chmod 600`**（實測現況是
   `-rw-r--r--` 0644，head 這邊本來就是 0600；scp 追加內容不會自動收窄既有權限，
   要另外下這道指令）。必須在任何 `sync-workers.sh` kickstart 之前完成——
   `doctor-worker.sh` 新增的兩條硬檢查（權限必須是 600、`.env` 不得含任何
   `MON_FIELD_KEY`）之後也會擋這個。
2. **安裝 tunnel job**：`com.aladdin.monitor-tunnel.plist.tmpl` 用 `sed` 把
   `__WORKER__` 換成實際 worker 名字 → 放進該機（head）的
   `~/Library/LaunchAgents/` → `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.monitor-tunnel.<worker>.plist`。
   逐台产生實體 plist 的腳本是 `sync-tunnels.sh`（另一輪工作項，本檔不涵蓋其實作）。
   **驗收兩層**：
   - worker 端 `nc -z 127.0.0.1 3307` 與 `nc -z 127.0.0.1 9429` 都要回應——但
     `nc -z` 只證明「有東西在聽」，不證明「聽的是我們的服務」。
   - **加一條身分驗收**：worker 端帶 `x-cluster-token` 打
     `GET http://127.0.0.1:9429/cluster/intake-identity?nonce=<隨機值>`，
     回應必須 200 且 `nonce` 原樣回傳、`identity == 'com.aladdin.monitor-log-intake'`、
     `sig` 與本地用同一把 `CLUSTER_SHARED_SECRET` 算出的 HMAC 以
     `timingSafeEqual` 比對相符（plan v3.2 §3.3(b2) / BL-G1）。
3. **分支 fast-forward 進 `main`**；**只有使用者在當次對話明確要求 push** 才
   `git push origin main`（僅 fast-forward，禁 `--force*`）——這是 CLAUDE.md 的
   硬規則，不是本步驟自己加的限制。
4. **`deploy/sync-workers.sh`**；驗收**不接受 `restart=skipped`**（MAJOR-D3）：
   每台必須同時是 `WORKER_OK` **且** `restart=done`。`restart=skipped(N jobs)`
   代表檔案已更新、`bun install` 也跑了，但行程還是舊碼——這正是「head 已寫、
   worker 沒寫」的中間態，不能算過。卡住時二擇一：(a) 等該 worker 清空進行中的
   單後重跑；(b) 使用者同意打斷該單時用 `--force-restart`。
   **timeout 常數兩機必須同批上線**（v3.2 §9.0(G)）：worker 上的
   `stale-lock-reaper` 用的門檻要與 head 同一次 commit 帶過去，不能head 先上
   新常數、worker 還在跑舊碼。
5. **`deploy/set-monitor-flag.sh 1`**：head → `tg-monitor` → 每台 worker 依序
   統一開啟，逐台確認旗標生效。
6. **`doctor-worker.sh` + `doctor-monitor.sh` 全綠**；觀察兩機 heartbeat 都有、
   spool 深度 0。

### 回滾（三層，由輕到重）

1. `deploy/set-monitor-flag.sh 0` —— 立即停止全部 DB 寫入，行為回到遷移前
   （程式碼保留，不用重新部署）。
2. `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.monitor-tunnel.<worker>.plist` ——
   拔掉 tunnel，worker 全部改落 spool，head 端照常。
3. `git revert` 相關 commit + 再次 push + `sync-workers.sh` —— 最重，需要使用者
   再次核准 push。

**tunnel 對 worker 的實連驗收待 Phase 3 實測**（本檔這節只記錄部署順序與驗收
標準；本機先行開發階段不連任何 worker，見「monitor tunnel」節）。

## monitor tunnel

head → worker 的反向 SSH tunnel，把 head 的 `127.0.0.1:3307`（mon-mysql）與
`127.0.0.1:9429`（monitor-log-intake）透過 `ssh -R` 帶到每台 worker 自己的
loopback，讓 worker 能像連本機一樣連監控 DB、把 log 經同一條加密通道送回 head
（plan v3.2 裁定 4 / BL-G1；9429 不是 v3.1 誤用的 8788——8788 在 head 上已被
`com.aladdin.mcp-toolsmith-server` 佔用）。

- **腳本**：`launchd/run-monitor-tunnel.sh <worker-name> [--resolve-only]`——
  host 不寫死在 plist 裡，啟動當下即時從 `logs/cluster-workers.json` 解析
  （MAJOR-D10(2)：DHCP 位址硬編進 launchd 是已判定的反模式）。解析不到（名字
  不存在、url 解不出 host、或該 worker `disabled=true`）一律視為失敗，stderr
  說明 + `exit 1`，交給 launchd `KeepAlive` 用預設 `ThrottleInterval`（10 秒）
  重試，腳本本身不 sleep。
- **plist 模板**：`launchd/com.aladdin.monitor-tunnel.plist.tmpl`，佔位符
  `__WORKER__`。repo 只放模板；per-worker 的實體 plist 由 `sync-tunnels.sh`
  （另一輪工作項）產生到 `~/Library/LaunchAgents/`，不進 repo。**模板與產生的
  實體 plist 都不得出現任何 IP/host**——所有位址一律由 wrapper 在執行期解析。
- **兩個 forward 綁同一個 job、`ExitOnForwardFailure=yes`**：3307 與 9429 對
  本案是共生的（沒有 log 通道，`file_offsets` 也沒有意義），任一個绑定失敗就讓
  整個 tunnel job 退出重試，全有或全無比半通半不通更好判讀。
- **狀態（本輪，先行開發）**：`run-monitor-tunnel.sh` 與 plist 模板已完成本機
  可驗部分（語法檢查、`--resolve-only` 對真實/fixture 名冊、模板 `plutil -lint`）。
  **未對任何 worker 建立實際連線**——`sync-tunnels.sh`（產生實體 plist 並
  `launchctl bootstrap` 的腳本）與對 worker 的實連驗收（`nc -z` + 身分驗收，見
  上方「Phase 3 部署順序」步驟 2）都待 Phase 3 實測。
- **`sync-tunnels.sh` 用法（先行開發，尚未實際 bootstrap 過任何 job）**：
  `deploy/sync-tunnels.sh [--dry-run] [--check] [--roster <path>]`。名冊
  （`logs/cluster-workers.json`，`--roster` 可指向測試用 fixture）是唯一驅動
  來源：enabled worker 逐台渲染 per-worker plist 到
  `~/Library/LaunchAgents/com.aladdin.monitor-tunnel.<worker>.plist`（`plutil
  -lint` 過才算成功；內容相同即跳過，冪等），不在名冊或已 `disabled` 的
  worker 則把既有 plist `bootout` + 刪除（teardown）。`--dry-run` 只印將執行
  的步驟，零副作用；`--check` 唯讀驗證每台 enabled worker 的 job 是否都存在
  且已載入，供 `doctor-monitor.sh` 日後引用。名冊 JSON parse 失敗時直接
  `exit 1`、不做任何 teardown，避免把所有現存 tunnel job 誤刪。部分失敗語意
  與 `set-monitor-flag.sh` 一致：逐台續跑、結束時非 0 並列出失敗機、重跑冪等。

## tunnel watchdog（2026-09-09，ALDREQ-812 事故後新增，已上線）

`monitor-tunnel.<worker>` 有一種 launchd `KeepAlive` 抓不到的故障模式：SSH
process 沒退出，但底層的反向 tunnel 半死——TCP port 還在 accept（`nc -z`
測得到），實際 MySQL 查詢卻會卡住/逾時。2026-09-09 實測踩過一次：worker 掉線
又重連後，tunnel 表面上恢復但一直半死，導致該 worker 的所有監控 DB 寫入
（含 heartbeat 自己）持續失敗、落 spool 且沒有東西會主動重放，直到人工發現
才 `launchctl kickstart -k` 手動重啟解決。跟 `launchd/health-watchdog.sh`
（T19，補 webhook server event loop 卡死的缺口）同一種思路，這裡補的是
tunnel 這一層的等價缺口。

- **偵測手法**：不從 worker 端量（worker 自己卡在同一條壞掉的 tunnel 上量不
  出來），改從 head 端讀 `monitor_heartbeat`——worker 每 60 秒該寫一次心跳，
  head 讀這張表走本機直連（不經任何 tunnel）。心跳新鮮＝tunnel 通；心跳過期
  ＝tunnel 卡死。查詢邏輯獨立成
  `lib/monitor-db/check-worker-heartbeat.ts <worker-name>`，輸出
  `AGE_SECONDS <n>` / `NO_ROW` / `DB_ERROR <msg>` 三種結果，後者兩種都不當
  tunnel 壞掉的證據（`NO_ROW`＝worker 可能還沒部署完成；`DB_ERROR`＝head 自己
  的 DB 有問題，不該拿去重啟 worker 的 tunnel）。
- **腳本**：`launchd/tunnel-watchdog.sh <worker-name>`，跟 `health-watchdog.sh`
  同一套慣例——`STALE_THRESHOLD_SECONDS=180`（允許漏跳 2 拍心跳）+
  `FAILURE_THRESHOLD=2`（連續 2 輪過期才動手，避免單次慢查詢誤報），翻轉那
  一刻才通知＋`launchctl kickstart -k gui/$(id -u)/com.aladdin.monitor-tunnel.<worker>`
  一次（不會每次都重啟造成迴圈），持續卡死不重複通知，恢復時另外報一次恢復。
  狀態記在 `logs/watchdog-state.tunnel.<worker>`。測試用替身：
  `WATCHDOG_CHECK_CMD`（整條檢查指令）、`WATCHDOG_KICKSTART_CMD`、
  `WATCHDOG_TG_NOTIFY_SH`、`WATCHDOG_STATE_FILE`、`WATCHDOG_LOG_FILE`。
- **plist 模板**：`launchd/com.aladdin.tunnel-watchdog.plist.tmpl`，佔位符
  `__WORKER__`，`StartInterval=60`（跟心跳頻率一致）。跟 monitor-tunnel 本身
  同一個慣例：repo 只放模板，per-worker 的實體 plist 手動渲染（或未來併入
  `sync-tunnels.sh`）到 `~/Library/LaunchAgents/`，不進 repo；模板不得出現
  任何 IP/host。
- **跟 `health-watchdog.sh`（webhook server watchdog）的差異**：後者故意
  「預設未啟用」，因為誤判重啟有已知的交互作用風險（`stale-lock-reaper.ts`
  同步鎖住整條 event loop 時可能被誤判成卡死，見上方主 README 的「已知操作
  風險」）。tunnel watchdog 沒有這個風險——`monitor-tunnel.<worker>` 只是一個
  無狀態的 `ssh -N` port-forward，重啟它頂多讓當下正在途中的查詢改走既有的
  spool-fallback 路徑（設計上本來就允許、也是這整套監控 DB 的核心正確性
  保證），不會遺失資料，所以**這支 watchdog 已直接上線、不是選配**。
- **狀態（2026-09-09，已對 landon2 上線）**：已渲染 `com.aladdin.tunnel-
  watchdog.landon2.plist` 並 `launchctl bootstrap`，實測跑過兩輪（`launchctl
  print` 的 `runs`／`last exit code` 可查），`watchdog-state.tunnel.landon2`
  正確回報 `state=healthy`。之後新增 worker 時記得比照這個手動步驟另外裝一份
  （或等 `sync-tunnels.sh` 併入這支 job 之後改回自動化）。
