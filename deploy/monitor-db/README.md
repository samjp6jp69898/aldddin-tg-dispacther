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
