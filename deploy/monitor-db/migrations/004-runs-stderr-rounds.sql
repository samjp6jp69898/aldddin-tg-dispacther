-- pipeline_monitor schema — migration 004
-- runs 補三欄 + 一個索引（純 additive）：
--   - stderr_path：執行紀錄完整性（stdout_path 已有，stderr 一直缺）。
--   - review_rounds / final_review_rounds：Phase 8 tg-monitor rounds 顯示的唯一來源
--     （由 tg-monitor mon_ui 直寫，本 migration 只負責欄位就位，不進 writes.ts）。
--   - idx_host_stdout_path (host, stdout_path(191))：A 包審查確認 stdout 對位需要
--     （pipeline 執行期負向快取每 30 秒失效重試 + Phase 7
--     lib/log-shipper/run-id-lookup.ts:11 同組 (host, stdout_path) 查詢）。
--
-- migration 只能新增，不能編輯已套用版本（見 001-init.sql 檔頭）。
-- 本檔只含 DDL，不含任何帳號 / 密碼相關語句（MAJOR-F9）。

USE pipeline_monitor;

ALTER TABLE runs
  ADD COLUMN stderr_path VARCHAR(512) NULL AFTER stdout_path,
  ADD COLUMN review_rounds TINYINT UNSIGNED NULL,
  ADD COLUMN final_review_rounds TINYINT UNSIGNED NULL,
  ADD KEY idx_host_stdout_path (host, stdout_path(191));
