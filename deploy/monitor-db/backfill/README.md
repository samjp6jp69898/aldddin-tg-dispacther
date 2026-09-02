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
