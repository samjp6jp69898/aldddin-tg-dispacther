-- pipeline_monitor schema — migration 005
-- 兩張新表（純 additive，不動任何既有表）：
--   - ticket_stages：一張 bug 票「各階段做到哪、產物落在哪台執行機」的權威紀錄。
--     由執行機（head 或 worker）在 run 結束時確定性寫入（lib/pipeline-runner/
--     stage-snapshot.ts → writes.ts upsertTicketStage），不靠 manager LLM 記得呼叫。
--     PK (ticket, stage)：同一張票同一個 stage 只有一列，記的是「最近一次完成狀態」。
--     跨機器續跑（/create-mr Step 0.2 的 resume-plan.sh）與 Phase 4 的親和派工讀它。
--   - ticket_artifact_sync：head 從 worker 拉回產物（rsync）的結果，只有 head 寫。
--     head_synced_at IS NULL ＝ head 沒有完整副本，Phase 4 的 sweeper 據此重試。
--
-- 設計依據：pipeline-modes-project-docs/plan-pipeline-modes-v1.md §3 / §4。
-- 兩張表都是「觀察面」：MON_DB_ENABLED != 1 時整套退化為單機檔案系統行為
-- （resume-plan.sh 退回 resume-inventory.sh），不得有任何路徑因 DB 關閉而失敗。
--
-- migration 只能新增，不能編輯已套用版本（見 001-init.sql 檔頭）。
-- 本檔只含 DDL，不含任何帳號 / 密碼相關語句（MAJOR-F9）；新表的逐表 GRANT
-- 在 migrate.sh 的帳號段（mon_head 走 pipeline_monitor.* 不需逐表補）。

USE pipeline_monitor;

CREATE TABLE IF NOT EXISTS ticket_stages (
  ticket       VARCHAR(32)  NOT NULL,
  stage        VARCHAR(32)  NOT NULL,   -- analytics | spec | grounding | analysis-notes | worktree | fixer | review | final-review | solution | exit
  status       VARCHAR(16)  NOT NULL,   -- done | failed | skipped
  host         VARCHAR(64)  NOT NULL,   -- 產物所在執行機（寫入端一律填自己的 MON_HOST）
  run_id       CHAR(36)     NULL,
  mode         VARCHAR(16)  NULL,       -- full | analysis | fix | reanalyze | resume
  finished_at  DATETIME(3)  NULL,       -- 該 stage 產物的時間（檔案 mtime 或 run 結束時刻）；同時是寫入守衛值
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket, stage),
  KEY idx_ticket_stages_host (host)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_artifact_sync (
  ticket           VARCHAR(32) NOT NULL,
  source_host      VARCHAR(64) NOT NULL,   -- 最後一次產出產物的執行機（head 記錄的是**遠端** worker 名，不是自己的 MON_HOST）
  head_synced_at   DATETIME(3) NULL,       -- head 成功 rsync 拉回的時間；NULL＝head 沒有完整副本
  last_attempt_at  DATETIME(3) NULL,       -- 最近一次拉取嘗試的時刻；同時是寫入守衛值
  last_error       VARCHAR(255) NULL,
  file_count       INT NULL,
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket)
) ENGINE=InnoDB;
