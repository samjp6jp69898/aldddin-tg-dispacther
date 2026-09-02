-- pipeline_monitor schema — migration 003
-- 依 migration-003-proposal.md（已採納）：agent_runs 補 10 個 payload 欄位
-- （對齊 tg-monitor/lib/db.ts 既有 sqlite agent_runs 表與
-- tg-monitor/migration/00-api-inventory.md 的 AgentSummary 形狀），
-- runs 補 triggered_by_name（方案 B：triggered_by_email 語意不變，
-- 新增顯示名欄，兩欄各自只有一種語意）。全部 additive、全部 NULL-able。
--
-- migration 只能新增，不能編輯已套用版本（見 001-init.sql 檔頭）。
-- 本檔只含 DDL，不含任何帳號 / 密碼相關語句（MAJOR-F9）。

USE pipeline_monitor;

ALTER TABLE agent_runs
  ADD COLUMN model               VARCHAR(64)       NULL AFTER agent_name,
  ADD COLUMN input_tokens        INT UNSIGNED      NULL AFTER model,
  ADD COLUMN output_tokens       INT UNSIGNED      NULL AFTER input_tokens,
  ADD COLUMN cache_read_tokens   INT UNSIGNED      NULL AFTER output_tokens,
  ADD COLUMN cache_create_tokens INT UNSIGNED      NULL AFTER cache_read_tokens,
  ADD COLUMN cost_usd            DECIMAL(12,6)     NULL AFTER cache_create_tokens,
  ADD COLUMN num_turns           SMALLINT UNSIGNED NULL AFTER cost_usd,
  ADD COLUMN tool_calls          INT UNSIGNED      NULL AFTER num_turns,
  ADD COLUMN is_error            TINYINT(1)        NULL AFTER tool_calls,
  ADD COLUMN result_preview      VARCHAR(512)      NULL AFTER is_error;

ALTER TABLE runs
  ADD COLUMN triggered_by_name VARCHAR(128) NULL AFTER triggered_by_email;
