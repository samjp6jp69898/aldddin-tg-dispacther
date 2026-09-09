-- migration 006（使用者核准，紅區：tracker.md 退役後續）：
-- create-mr pipeline 的 failed 出口原本靠 tracker.sh log-fail 把一句失敗原因
-- 寫進本機 pipeline-failures.md，tracker.md 退役（2026-09-09）時這份流水帳
-- 一併被砍掉——但失敗原因仍然有價值（除了 Notion 留言之外，也要能在監控 DB
-- 查得到），所以補一個 additive 欄位承接。只新增欄位，不改既有欄位/索引，
-- 符合 001 檔頭「migration 只能新增，不能編輯已套用版本」的紀律。
--
-- 授權範圍：`runs` 表現有的 GRANT 都是 table-level（mon_exec 的
-- `GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.runs`、mon_ui 的
-- `GRANT SELECT ON pipeline_monitor.runs`），新增這個欄位不需要額外 GRANT。

USE pipeline_monitor;

ALTER TABLE runs
  ADD COLUMN failure_reason VARCHAR(500) NULL AFTER exit_code;
