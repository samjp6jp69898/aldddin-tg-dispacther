-- pipeline_monitor schema — migration 001（Phase 0 骨架）
-- 由 deploy/monitor-db/migrate.sh 透過 `docker exec mon-mysql mysql -uroot` 套用。
-- 本檔只含 DDL，不含任何帳號 / 密碼相關語句
-- （帳號建立另由 migrate.sh 以 MYSQL_PWD 環境變數注入，見 plan §2.2 / MAJOR-F9）。
--
-- 這是 Phase 0 的骨架 schema，涵蓋 plan §11.1 表清單與目前已定案（BL-D3 / MJ-E1 /
-- 裁定2 outcome_tier）的欄位與守衛。多數表的完整型別/索引細節仍待 Phase 1
-- 的 lib/monitor-db/schema.sql 與 §6.2.1 S1–S11 實測後以後續 migration（002+）
-- 校正，本檔不得回頭修改（migration 只能新增，不能編輯已套用版本）。
--
-- 時間欄一律 DATETIME(3)，容器層以 --default-time-zone=+00:00 存 UTC。

CREATE DATABASE IF NOT EXISTS pipeline_monitor
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE pipeline_monitor;

-- runs：唯一由執行機（host 自己）寫入的表（R1）。
CREATE TABLE IF NOT EXISTS runs (
  run_id              CHAR(36)      NOT NULL,
  host                 VARCHAR(64)   NOT NULL,
  ticket                VARCHAR(32)   NOT NULL,
  kind                  VARCHAR(16)   NOT NULL,          -- 'bug' | 'demand'
  lifecycle_rank        TINYINT       NOT NULL,           -- 10 queued / 30 running / 100 finished
  lifecycle              VARCHAR(16) AS (
                           CASE lifecycle_rank
                             WHEN 10 THEN 'queued'
                             WHEN 30 THEN 'running'
                             WHEN 100 THEN 'finished'
                             ELSE 'unknown'
                           END
                         ) STORED,
  started_at             DATETIME(3)   NULL,
  finished_at            DATETIME(3)   NULL,
  pid                    INT           NULL,
  stdout_path            VARCHAR(512)  NULL,
  trigger_source         VARCHAR(32)   NULL,
  retry_of_run_id         CHAR(36)      NULL,
  dispatch_id             CHAR(36)      NULL,
  legacy_key               VARCHAR(128)  NULL,
  remote_dispatch_id        CHAR(36)      NULL,
  outcome                    VARCHAR(32)   NULL,
  outcome_source              VARCHAR(32)   NULL,
  outcome_tier                 TINYINT       NULL,
  legacy_outcome_raw             VARCHAR(64)   NULL,
  exit_code                       INT           NULL,
  cancel_requested_at               DATETIME(3)   NULL,
  cancel_resolved_by                  VARCHAR(16)   NULL,
  triggered_by_email                    VARCHAR(255)  NULL,
  created_at                              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                                DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id),
  KEY idx_host_lifecycle (host, lifecycle_rank),
  KEY idx_ticket (ticket),
  KEY idx_dispatch_id (dispatch_id),
  KEY idx_legacy_key (legacy_key),
  CONSTRAINT chk_outcome_tier CHECK (outcome_tier IS NULL OR outcome_tier IN (1,2)),
  CONSTRAINT chk_outcome_tier_pair CHECK ((outcome IS NULL) = (outcome_tier IS NULL)),
  CONSTRAINT chk_cancel_resolved_by CHECK (
    cancel_resolved_by IS NULL OR
    cancel_resolved_by IN ('pid_match','marker','legacy_key','latest_running','placeholder'))
) ENGINE=InnoDB;

-- dispatch_attempts：只有 head 寫（派工視角，不碰 runs）。PK 改為 dispatch_id（MJ-C6）。
CREATE TABLE IF NOT EXISTS dispatch_attempts (
  dispatch_id         CHAR(36)     NOT NULL,
  ticket                VARCHAR(32)  NOT NULL,
  kind                   VARCHAR(16)  NOT NULL,
  worker_name             VARCHAR(64)  NULL,
  worker_url                VARCHAR(255) NULL,
  status                     VARCHAR(32)  NOT NULL,
  status_rank                 SMALLINT     NOT NULL,   -- 10 dispatching / 20 dispatched / 100 終態
  dispatched_at                 DATETIME(3)  NULL,
  confirmed_at                    DATETIME(3)  NULL,
  cleared_at                        DATETIME(3)  NULL,
  clear_reason                        VARCHAR(32)  NULL,
  remote_run_id                         CHAR(36)     NULL,
  head_run_id                             CHAR(36)     NULL,
  triggered_by_email                        VARCHAR(255) NULL,
  created_at                                  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                                    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (dispatch_id),
  KEY idx_ticket_kind (ticket, kind)
) ENGINE=InnoDB;

-- agent_runs：執行機 collector（head + worker）純 additive。
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id       CHAR(36)     NOT NULL,
  path          VARCHAR(255) NOT NULL,
  host           VARCHAR(64)  NOT NULL,
  agent_name      VARCHAR(64)  NULL,
  started_at        DATETIME(3)  NULL,
  finished_at         DATETIME(3)  NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id, path)
) ENGINE=InnoDB;

-- file_offsets：各 collector 續讀游標，守衛見 §6.2.2。
CREATE TABLE IF NOT EXISTS file_offsets (
  host     VARCHAR(64)     NOT NULL,
  path      VARCHAR(512)    NOT NULL,
  inode      BIGINT UNSIGNED NULL,
  `offset`     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (host, path)
) ENGINE=InnoDB;

-- monitor_heartbeat：各長駐行程存活心跳（BL-2/BLOCKER-1 靜默失敗偵測）。
CREATE TABLE IF NOT EXISTS monitor_heartbeat (
  host              VARCHAR(64)  NOT NULL,
  ts                  DATETIME(3)  NOT NULL,
  spool_depth           INT          NULL,
  spool_oldest_ts          DATETIME(3)  NULL,
  PRIMARY KEY (host)
) ENGINE=InnoDB;

-- worker_status_log：worker 探測歷史（平移既有 tg-monitor probe）。
CREATE TABLE IF NOT EXISTS worker_status_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  worker_name     VARCHAR(64)  NOT NULL,
  ts                DATETIME(3)  NOT NULL,
  status              VARCHAR(32)  NULL,
  detail_json           JSON         NULL,
  KEY idx_worker_ts (worker_name, ts)
) ENGINE=InnoDB;

-- workers：cluster 名冊投影（head only 寫）。
CREATE TABLE IF NOT EXISTS workers (
  name           VARCHAR(64)  NOT NULL PRIMARY KEY,
  url              VARCHAR(255) NULL,
  enabled            TINYINT(1)   NOT NULL DEFAULT 1,
  registered_at        DATETIME(3)  NULL,
  last_seen_at           DATETIME(3)  NULL
) ENGINE=InnoDB;

-- service_status_log：tg-monitor probe（head only 寫），平移既有機制。
CREATE TABLE IF NOT EXISTS service_status_log (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  service     VARCHAR(64)  NOT NULL,
  host          VARCHAR(64)  NOT NULL,
  ts              DATETIME(3)  NOT NULL,
  status            VARCHAR(32)  NULL,
  detail_json         JSON         NULL,
  KEY idx_service_ts (service, ts)
) ENGINE=InnoDB;

-- tg_webhook_status_log：webhook 探測歷史（head only 寫）。
CREATE TABLE IF NOT EXISTS tg_webhook_status_log (
  id    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts      DATETIME(3)  NOT NULL,
  status    VARCHAR(32)  NULL,
  detail_json JSON         NULL,
  KEY idx_ts (ts)
) ENGINE=InnoDB;

-- mcp_usage：audit ingester（head only 寫）；raw_sha256 生成欄位供去重（S8）。
CREATE TABLE IF NOT EXISTS mcp_usage (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  service      VARCHAR(64)   NOT NULL,
  identity       VARCHAR(255)  NULL,
  source_ip        VARCHAR(64)   NULL,
  raw                MEDIUMTEXT    NOT NULL,
  raw_sha256           BINARY(32) AS (UNHEX(SHA2(raw, 256))) STORED,
  ts                     DATETIME(3)   NOT NULL,
  UNIQUE KEY uq_service_raw (service, raw_sha256),
  KEY idx_service_ts (service, ts)
) ENGINE=InnoDB;

-- mcp_tokens：DB 權威 + 產物投影（§5.9）。head only 寫。issued_at 存原字串（MAJOR-D5）。
CREATE TABLE IF NOT EXISTS mcp_tokens (
  server         VARCHAR(64)  NOT NULL,
  env              VARCHAR(32)  NOT NULL,
  token_id           VARCHAR(64)  NOT NULL,
  token_enc             TEXT         NOT NULL,
  token_bidx              BINARY(32)   NOT NULL,
  issued_at                  CHAR(24)     NOT NULL,
  display_name                 VARCHAR(128) NULL,
  revoked_at                     DATETIME(3)  NULL,
  created_at                       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (server, env, token_id),
  UNIQUE KEY uq_token_bidx (token_bidx)
) ENGINE=InnoDB;

-- tech_users：欄位級權威（§5.10），只有 tg_chat_id 由 DB 權威。head only 寫。
CREATE TABLE IF NOT EXISTS tech_users (
  email              VARCHAR(255) NOT NULL PRIMARY KEY,
  notion_user_name     VARCHAR(128) NULL,
  notion_user_id         VARCHAR(64)  NULL,
  pushed_repos              VARCHAR(255) NULL,
  tg_chat_id_enc              TEXT         NULL,
  tg_chat_id_bidx                BINARY(32)   NULL,
  bidx_key_ver                     TINYINT      NULL,
  updated_at                         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tg_chat_id_bidx (tg_chat_id_bidx)
) ENGINE=InnoDB;

-- tg_unknown_senders：DM 過 bot 但尚未對映的自然人識別資料。head only 寫（webhook server）。
CREATE TABLE IF NOT EXISTS tg_unknown_senders (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  chat_id_enc         TEXT        NOT NULL,
  chat_id_bidx           BINARY(32)  NOT NULL,
  sender_profile_enc        TEXT        NULL,
  ts                          DATETIME(3) NOT NULL,
  UNIQUE KEY uq_chatid_ts (chat_id_bidx, ts)
) ENGINE=InnoDB;

-- schema_migrations：migrate.sh 自己的套用紀錄（本檔套用後由 migrate.sh 寫入這一列）。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
