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
