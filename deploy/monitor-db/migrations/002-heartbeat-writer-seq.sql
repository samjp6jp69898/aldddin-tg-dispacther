-- pipeline_monitor schema — migration 002
-- 由 deploy/monitor-db/migrate.sh 透過 `docker exec mon-mysql mysql -uroot` 套用。
-- 本檔只含 DDL，不含任何帳號 / 密碼相關語句（見 migrate.sh 的反向驗證，MAJOR-F9）。
--
-- 依據 plan-db-as-truth-v3.2.md：
--   1) 裁定 1 §11.1 `monitor_heartbeat` 修訂（BLOCKER-F1 附帶的第二個後果）：
--      「原文：PK＝host。改為：PK＝(host, writer)，writer ∈ {server, worker-agent,
--        tg-monitor, log-intake}。理由：head 上有 3 個監控寫入行程共用一列時，
--        只要任一還活著，§6.8(a) 的『head 自己 DB 不可寫』就永遠不會觸發——
--        server.ts 死掉而 tg-monitor 照常心跳，head 的寫入面全停卻沒有任何告警。」
--      守衛條件不變：WHERE host=? AND writer=? AND ts < ?（見 §6.2.2 修訂，套用在
--      lib/monitor-db/writes.ts，本檔只負責 DDL）。
--   2) G 卷 MAJOR-F10（【G:MN-G11】event_seq 定案）：
--      「file_offsets 加一欄 event_seq BIGINT NOT NULL」，守衛改為
--      「WHERE host=? AND path=? AND event_seq < ?」→ rotate 不再是特例，跨
--      inode 的舊事件因 event_seq 較小而被擋（inode/offset 兩欄保留，仍是
--      collector 續讀游標的實際依據，event_seq 只用於守衛判斷寫入順序）。
--
-- 套用前提（本輪套用時已確認）：monitor_heartbeat / file_offsets 兩表目前皆為
-- 空表（Phase 0 之後尚未有任何實際監控寫入，MON_DB_ENABLED=0），因此新增
-- NOT NULL 欄位與變更 PRIMARY KEY 不需要資料回填步驟。

USE pipeline_monitor;

-- (1) monitor_heartbeat：PK 改 (host, writer)。
ALTER TABLE monitor_heartbeat
  ADD COLUMN writer VARCHAR(32) NOT NULL AFTER host;

ALTER TABLE monitor_heartbeat
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (host, writer),
  ADD CONSTRAINT chk_monitor_heartbeat_writer CHECK (
    writer IN ('server', 'worker-agent', 'tg-monitor', 'log-intake'));

-- (2) file_offsets：加 event_seq，守衛判斷改用它（inode/offset 欄位保留，仍是
--     collector 續讀的實際依據，不受本次修訂影響）。
ALTER TABLE file_offsets
  ADD COLUMN event_seq BIGINT NOT NULL AFTER `offset`;
