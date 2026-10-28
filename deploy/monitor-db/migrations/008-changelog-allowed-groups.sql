-- pipeline_monitor schema — migration 008（使用者 2026-10-28 核准）
-- changelog_allowed_groups：哪些 Telegram 群組可以用「@aladdin operation bot /changelog ...」。
--   - 讀：changelog bot（changelog-bot.ts，獨立程序）每則「@bot /changelog」訊息都重新查一次、
--     不快取（lib/webhook-server/changelog-group-allowlist.ts），後台改完不必重啟 bot。
--   - 寫：只經 lib/registry/changelog-groups-cli.ts（單一寫入者），由 head 本機的 tg-monitor
--     dashboard（127.0.0.1:8799）spawn 呼叫，角色 mon_head。
--   - 停用（enabled=0）與刪除都支援：停用保留紀錄、刪除整列移除。
--
-- migration 只能新增，不能編輯已套用版本（見 001-init.sql 檔頭）。
-- 本檔只含 DDL，不含任何帳號 / 密碼相關語句（MAJOR-F9）；mon_head 對本表的 DELETE
-- 在 migrate.sh 的帳號段逐表補（mon_head 走 pipeline_monitor.* 只有 SELECT/INSERT/UPDATE）。

USE pipeline_monitor;

CREATE TABLE IF NOT EXISTS changelog_allowed_groups (
  chat_id      BIGINT        NOT NULL PRIMARY KEY,  -- 群組 chat_id，一律負數（supergroup 形如 -100xxxxxxxxxx）
  title        VARCHAR(255)  NULL,                  -- 群組名稱（新增／編輯時由 Telegram getChat 帶入，抓不到才手填）
  enabled      TINYINT(1)    NOT NULL DEFAULT 1,
  created_by   VARCHAR(255)  NULL,                  -- 操作來源（如 tg-monitor）
  updated_by   VARCHAR(255)  NULL,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
