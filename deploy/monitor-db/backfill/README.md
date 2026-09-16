> **2026-09-16 更新**：`tech-users.csv → tech_users` 這條來源已從 `backfill-rosters.ts`
> 整段移除。該段在 2026-09-03 的正式回填就已跑完（tasklist #8），名冊自此以 DB 為
> 權威；CSV 本身於 2026-09-16 刪檔退役，名冊增修改走
> `lib/registry/tech-users-sync.ts --upsert-user／--remove-user`。本文件下方凡提到
> 名冊「三表／三來源」之處，現況皆為兩表兩來源。

# Phase 6 歷史回填（plan-db-as-truth v3 §11.2 ＋ v3.2 修訂）

一次性、離線、單執行緒、**可重跑（冪等）**的歷史資料回填。「先開發＋測試，後執行」：
本目錄的腳本在 Phase 6 時點之前只准以 `--dry-run` 或臨時測試 schema 執行，
**絕不寫正式 `pipeline_monitor`**。

## 三支回填腳本

| 腳本 | 來源 | 目標 | 冪等機制 |
|---|---|---|---|
| `backfill-sqlite.ts` | `tg-monitor/data/monitor.sqlite`（WAL-aware 快照） | `runs` / `agent_runs` / `mcp_usage` / `service_status_log` | 確定性 UUIDv5 PK + INSERT IGNORE；`service_status_log` 用 NOT EXISTS 守衛（無唯一鍵） |
| `backfill-rosters.ts` | 9 份 `tokens*.json` 白名單、`unknown-senders.jsonl` | `mcp_tokens` / `tg_unknown_senders` | PK / UNIQUE + INSERT IGNORE（bidx 是確定性 HMAC） |
| `backfill-logs-vl.ts` | `telegram-dispatcher/logs/*.log`、`aladdin_mcps/*/logs/audit*.jsonl` | VictoriaLogs（127.0.0.1:9428） | workdir manifest（best-effort；manifest 遺失重跑會重複，VL 是副本、重複可接受、缺口不可接受） |

統一入口：`bash run-backfill.sh [--dry-run] [--schema <name>] [--only sqlite|rosters|logs]`。

## 關鍵定案（實作時已鎖死，後續 Phase 不得無聲偏離）

- **回填列 `runs.host` 一律 `'unknown_pre_migration'`**（§11.2 MN-3/m2；2026-09-02 指揮官裁定
  維持計畫、不用 'head'）。§10.2 雙軌對照與 R1 不變式都依賴這個標記。
- **run_id ＝ UUIDv5(固定 namespace, legacy_key)**，namespace 見 `lib/run-id.ts`
  （`3e0aa7d4-19c5-4b31-9c8a-6f2d5e8b71c9`，**定案後不得變更**——變更＝全部回填列換 PK，
  重跑即產生重複列）。`legacy_key` 欄另存原字串（§10.2 對位鍵）。
- **timeout 列 `finished_at = started_at + 7200s`**——§9.0(G) 全案唯一「刻意不改」的 7200
  （回填的是 timeout 改 180 分之前的歷史單），不得改 10800。
- **`issued_at` byte-exact 原字串**（CHAR(24)，MAJOR-D5），不經任何 Date 轉換。
- **加密 ctx / 盲索引 scope 字串定案**（Phase 5 投影必須沿用同一組，否則解密/等值查詢對不上）：
  - `mcp_tokens.token_enc:<token_id>`（AAD）／`mcp_tokens.token`（bidx scope）
  - `tg_unknown_senders.chat_id_enc:<hex(bidx)>`、`tg_unknown_senders.sender_profile_enc:<hex(bidx)>`（AAD）
    ／`tg_unknown_senders.chat_id`（bidx scope）
- **mcp_tokens 的 env 命名**：`tokens.json → 'default'`、`tokens.<env>.json → '<env>'`
  （計畫未定義，回填自定；Phase 5 投影定案若不同，需 UPDATE 回填列——已列入回報事項）。
- **log 回填的遮罩**：`lib/redaction.ts` 是 §7.3 十一條規則的回填先行版；Phase 7 的
  `lib/log-shipper/redaction.ts` 落地後應收斂為單一來源。
- **VL retention**：`_time` 早於 90 天的行主動跳過並列入報告（VL 端會無聲拒收，§11.2）。
- **既存防撞守衛（總指揮裁定，2026-09-02）**：`runs` PK 只有 `run_id`、`legacy_key` 非
  唯一鍵——live 寫入路徑用 `randomUUID()` 鑄 `run_id`，回填路徑用
  `deriveRunId(legacy_key)` 導出 `run_id`，同一支歷史 run 兩軌算出不同 PK，
  `INSERT IGNORE` 因此偵測不到重複，雙軌重疊的 run 會被插成兩列且零警告
  （實測重疊 2 筆：`FAQ-4771` / `FAQ-4855`）。`backfill-sqlite.ts` 在回填 `runs` 之前
  先唯讀 `SELECT legacy_key FROM runs WHERE legacy_key IS NOT NULL` 建記憶體 Set
  （此步嚴禁任何寫入，唯讀與寫入分離），命中者整列 skip（skipReason：
  `已存在於 mysql（live 寫入）：key=<key>`），並級聯 skip 該 run 對應的 `agent_runs`
  （skipReason 獨立標示為「既存防撞守衛級聯跳過」），避免插出掛在未回填 `run_id`
  下的孤兒列。**這是時間序問題：Phase 6 回填的執行順序排在 live 寫入路徑
  （migration 004／W1 legacy_key 落地）部署輪之後**——回填執行當下，live 路徑可能
  已經把 sqlite 歷史裡同一支 run 寫過一次，兩軌才有機會撞在一起；**但守衛本身
  無論何時跑都必須有**，不得因「這次應該在乾淨窗口跑、理論上不會撞」而省略——
  唯讀查詢成本近乎零，省略等於把「假設不會撞」的判斷權下放給執行當下的人，
  而 2026-09-02 的實測已經證明這個假設會落空。

## 測試

```bash
cd /Users/user/aladdin/telegram-dispatcher
bun test deploy/monitor-db/backfill/          # 全部單元測試（不需 MySQL / VL）
```

整合測試（需要 mon-mysql 在跑）：

```bash
bash deploy/monitor-db/backfill/test-schema.sh create   # 建臨時 schema + 001/002 DDL + 臨時 GRANT
bash deploy/monitor-db/backfill/run-backfill.sh --schema pipeline_monitor_backfill_test --only sqlite
bash deploy/monitor-db/backfill/run-backfill.sh --schema pipeline_monitor_backfill_test --only rosters
# （logs 來源寫 VL 不寫 MySQL，整合驗證只跑 --dry-run）
bash deploy/monitor-db/backfill/test-schema.sh drop     # 用完即刪（連帶收回臨時 GRANT）
```

WAL 踩坑（impl-constraints-addendum §4）：讀 `monitor.sqlite` **禁止 cp**，一律
`VACUUM INTO` 快照（`lib/sqlite-snapshot.ts`），並驗「快照 vs 正式檔逐表 row count 一致」。

## 已知取捨（回報過指揮官）

- sqlite `agent_runs` 的 `model` / token 用量 / `cost_usd` / `result_preview` 等欄位在
  MySQL `agent_runs` 沒有對應欄位，回填時丟棄（schema 缺欄已回報，不自行加 migration）。
- sqlite `pipeline_runs.triggered_by` 是顯示名（如 "Blast"），目標欄位卻叫
  `triggered_by_email`——照存並回報語意不符。
- sqlite `file_offsets` 不回填（行程私有游標，新管線自行重建）。
- `outcome IS NULL` 且 `finished_at IS NULL` 的列（快照當下可能仍在跑）跳過不回填。
- `runs.stderr_path` / `review_rounds` / `final_review_rounds`（migration 004，2026-09-02）：
  sqlite `pipeline_runs` 同名欄位直接映射；來源缺值（含 migration 004 之前建立、
  rounds 欄位還不存在時期的舊列）→ NULL，不造數。
- **冪等機制不擴充 UPDATE 補欄路徑**：`runs`/`agent_runs`/`mcp_usage` 全線只用
  `insertIgnoreRow`（`INSERT IGNORE`），`service_status_log` 用 `insertIfNotExists`
  （`WHERE NOT EXISTS` 守衛）——`lib/db.ts` 沒有、也不新增任何 UPDATE 路徑，這是本目錄
  三支回填腳本一貫的冪等哲學（見上表「冪等機制」欄）。新增 `stderr_path` 等三欄後，
  對「已經回填過的舊列」重跑 `INSERT IGNORE` 命中唯一鍵即整列略過、不會補上新欄位值；
  這與 `mcp_tokens` env 命名那條既有取捨（若計畫定案不同，需另外手動 UPDATE 回填列）
  是同一類已知限制，不在本腳本自動化範圍內。Phase 6 回填在指揮官核准前只在
  `--dry-run` / 臨時測試 schema 跑過（見檔頭「先開發＋測試，後執行」），尚未對正式
  `pipeline_monitor.runs` 寫過任何一列，因此「重跑補齊舊列」目前不是實際問題；
  若之後需要對已回填過的正式列補新欄，屬於一次性人工 UPDATE，不建議塞進這支
  設計上「只插入、不更新」的冪等腳本。
- **Phase 6 執行前置（2026-09-02 總指揮裁定，配套上一條「維持純 INSERT IGNORE」）**：
  1. 開跑前**實查**正式 `runs` 表確認零回填列
     （`SELECT COUNT(*) FROM runs WHERE host='unknown_pre_migration'` 必須為 0），
     不接受「應該是零」的假設；非零即停下上呈，不得直接跑。
  2. **一次跑完，不分批跨版本**：`INSERT IGNORE` 的安全性建立在「所有列由同一版
     mapping 寫入」——第一批跑完後若 mapping 被改過再跑第二批，先寫的列用舊 mapping
     且不會被修正、也不會報錯，這是 `INSERT IGNORE` 最陰的失敗模式。
  3. **events 去重前提探針（b5 對線定案，必跑非引用；2026-09-03 已接進
     `run-backfill.sh` 成阻斷閘門，非僅文件宣稱——review-final-A 指認落差後補）**：
     非 `--dry-run` 且含 sqlite 來源時，`run-backfill.sh` 自動以 `--gate` 模式執行
     探針：would-insert=0 放行；非零中止（逐筆判讀無誤後以 `--ack-events-precheck`
     重跑放行）；**探針自身失敗＝「未評估」依 D42 視同不通過、一律中止**。
     手動單跑：`bun deploy/monitor-db/backfill/precheck-events-dedup.ts`（唯讀）。它驗的是
     「兩軌 (service, raw) 逐位元一致」這個 `uq_service_raw` 跨寫入者去重的**前提**——
     2026-09-02 實測 1738/1738 全命中、would-insert=0（本探針與 b5 獨立實測逐位一致），
     但那是快照不是恆真：insertAuditLine / audit-ingester 若改了 raw 處理，前提會
     **無聲失效**。would-insert 非零不必然錯（sqlite 可能真的累積了 mysql 沒有的事件），
     但每一筆都要能被解釋；解釋不了＝前提已破，停下上呈。**注意 events 回填現況是
     no-op**（mysql 已有全部 1738 筆）——「回填 events 會正確去重」在回填當天才第一次
     真跑，風險浮現的情境是 sqlite 累積了 mysql 沒有的事件（如 ingester 停機期間）。
     回填後對帳恆等式延伸：`mcp_usage` 列數增量必須等於探針的 would-insert 數。
     弱鍵啟發式重複檢查（如 (service,ts,identity)）**不採**——b5 於乾淨資料實測
     9 組全誤報，誤報恆紅的檢查比沒有檢查更糟。
  4. **既存防撞守衛的驗收檢查（b5 對線定案）**：回填跑完後執行
     `SELECT legacy_key, COUNT(*) FROM runs WHERE legacy_key IS NOT NULL GROUP BY legacy_key
     HAVING COUNT(*)>1`，結果必須為空。**`WHERE legacy_key IS NOT NULL` 不可省**：
     cancel placeholder 路徑（`lib/monitor-db/writes.ts:304` 的 `input.legacyKey ?? null`）
     會產生 `legacy_key` 為 NULL 的列，MySQL 的 `GROUP BY` 把所有 NULL 併成同一組，
     一旦 placeholder 列 ≥ 2 筆，拿掉這個 WHERE 就會 false-red。此 SQL 層檢查沒有
     讀取層 `COALESCE(legacy_key, run_id)` 那種保護，NULL 過濾是必要條件，不是風格選擇。

## 回填對讀取端點的已知影響（b5 查證，2026-09-02）

- **`/api/events` 顯示順序（mysql 軌現況即錯序，非回填造成；b5 實測更正 2026-09-02）**：
  `queryEvents`（tg-monitor lib/read/mysql.ts:588）以 `ORDER BY e.id DESC` 排序且 `e.id`
  兼分頁游標，而 `mcp_usage` 的 id 是寫入序非事件時間序——b5 實測**回填前**mysql 軌
  首筆已比內容最新筆舊約 19 小時（違序相鄰對 mysql=8、sqlite 側自身也有 333，
  「sqlite id 序 ≡ ts 序」只對 status_log 成立、對 events 不成立）。回填會**加劇**
  （歷史事件以更大 id 進來）但**不是成因，也不是修它的觸發點**——該問題擋的是
  `MON_READ_SOURCE=mysql` 切換，不擋回填（b5 已上呈 a7）。修法不能照抄 status_log
  （id 兼游標，需複合游標 (ts,id)，動前端契約），歸讀取面。
- `service_status_log` 排序鍵（D43）：讀取層已修（c71b88c）；回填仍以 D44 聯合組合驗證
  （造資料：本側；讀取檢查：b5）通過為前置。

## §10.2 對數備註（雙軌對照；容差定義 2026-09-02 與讀取面統一，a7 核定）

- `runs.started_at` 兩軌語意不同：sqlite 由 log 檔名（`<ticket>.<ISO毫秒>`）反推
  （spawn-create-mr.ts:322 的檔名時戳），MySQL 由 W1 spawn 當下另一次 `new Date()`
  實際寫入（:430/:445）——兩者隔著建檔＋sidecar I/O，**方向單向（MySQL ≥ sqlite）**，
  實測現象為 1ms 級落點差（n=2 描述性觀察，**不是容差**）。
- **容差判準的 canonical 定義在 `tg-monitor/scripts/switch-readiness.ts` 的
  `STARTED_AT_TOLERANCE_MS`**（現值：單向 `0 ≤ Δ ≤ 2000ms`，逾界 FAIL；本 README
  不自帶數字，以該常數為唯一來源）。上界為**抗負載抖動的餘裕，非實測值**——誤配對
  只會發生在同票不同次執行之間（間隔至少幾分鐘），2s 與其差三個數量級仍擋得住。
- 判準明文**限定 `mysql.runs.host='head'` 的配對**；host 非 head 的配對出現即單獨
  FAIL（switch-readiness C5b）——head 的 sqlite 結構上沒有 worker 執行單的列
  （ingest.ts:460 只掃本機 log dir），真出現只可能是 `legacy_key` 碰撞，是 bug 不是誤差。
- **回填列（`host='unknown_pre_migration'`）排除出分布統計**：回填列不走 spawn 路徑，
  `mapPipelineRunToRunsRow` 把 sqlite 的 `started_at` 原字串直通寫入、不重算，故
  Δ ≡ 0 by construction——不得拿回填列的 Δ=0 去質疑 2000ms 上界。
- 對照一律以 `legacy_key`（§10.2 對位鍵）為主要對位依據，時間欄位
  （`started_at`/`finished_at`）用容差比較，不能拿來當對位鍵或要求逐毫秒相等。
- 回填實跑若量到 host='head' 配對 Δ > 2000ms 或任何負 Δ，回報讀取面（a4）重新推導。
