# Phase 6 歷史回填（plan-db-as-truth v3 §11.2 ＋ v3.2 修訂）

一次性、離線、單執行緒、**可重跑（冪等）**的歷史資料回填。「先開發＋測試，後執行」：
本目錄的腳本在 Phase 6 時點之前只准以 `--dry-run` 或臨時測試 schema 執行，
**絕不寫正式 `pipeline_monitor`**。

## 三支回填腳本

| 腳本 | 來源 | 目標 | 冪等機制 |
|---|---|---|---|
| `backfill-sqlite.ts` | `tg-monitor/data/monitor.sqlite`（WAL-aware 快照） | `runs` / `agent_runs` / `mcp_usage` / `service_status_log` | 確定性 UUIDv5 PK + INSERT IGNORE；`service_status_log` 用 NOT EXISTS 守衛（無唯一鍵） |
| `backfill-rosters.ts` | `tech-users.csv`、9 份 `tokens*.json` 白名單、`unknown-senders.jsonl` | `tech_users` / `mcp_tokens` / `tg_unknown_senders` | PK / UNIQUE + INSERT IGNORE（bidx 是確定性 HMAC） |
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
  - `tech_users.tg_chat_id:<email>`（AAD）／`tech_users.tg_chat_id`（bidx scope）
  - `mcp_tokens.token_enc:<token_id>`（AAD）／`mcp_tokens.token`（bidx scope）
  - `tg_unknown_senders.chat_id_enc:<hex(bidx)>`、`tg_unknown_senders.sender_profile_enc:<hex(bidx)>`（AAD）
    ／`tg_unknown_senders.chat_id`（bidx scope）
- **mcp_tokens 的 env 命名**：`tokens.json → 'default'`、`tokens.<env>.json → '<env>'`
  （計畫未定義，回填自定；Phase 5 投影定案若不同，需 UPDATE 回填列——已列入回報事項）。
- **log 回填的遮罩**：`lib/redaction.ts` 是 §7.3 十一條規則的回填先行版；Phase 7 的
  `lib/log-shipper/redaction.ts` 落地後應收斂為單一來源。
- **VL retention**：`_time` 早於 90 天的行主動跳過並列入報告（VL 端會無聲拒收，§11.2）。

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
