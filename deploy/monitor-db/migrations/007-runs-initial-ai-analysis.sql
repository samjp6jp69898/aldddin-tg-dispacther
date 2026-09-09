-- migration 007（使用者核准）：tg-monitor 詳情頁要顯示「這一輪 run 啟動當下
-- Notion『AI分析』欄位是什麼值」（例如 bug 票的「一鍵分析＋修復＋開 MR」／
-- 需求單的「待分析」），純 additive 欄位，只在 run 建立當下（W1 running 狀態
-- 寫入點）寫一次，之後不再覆蓋——語意等同 pid/stdout_path 等既有欄位的
-- COALESCE 守衛（見 writes.ts W1_SQL）。只新增欄位，不改既有欄位/索引，符合
-- 001 檔頭「migration 只能新增，不能編輯已套用版本」的紀律。
--
-- 授權範圍：`runs` 表現有的 GRANT 都是 table-level（mon_exec 的
-- `GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.runs`、mon_ui 的
-- `GRANT SELECT ON pipeline_monitor.runs`），新增這個欄位不需要額外 GRANT。

USE pipeline_monitor;

ALTER TABLE runs
  ADD COLUMN initial_ai_analysis VARCHAR(64) NULL AFTER kind;
