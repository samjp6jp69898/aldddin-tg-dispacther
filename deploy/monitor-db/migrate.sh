#!/bin/zsh
# Phase 0：套用 migrations/*.sql（DDL only）＋ 建立三個帳號（逐表最小權限）。
# DDL 帳號不存在：所有 DDL 一律 `docker exec mon-mysql mysql -uroot`（容器內 socket）。
# 帳號密碼一律以 MYSQL_PWD 環境變數注入 docker exec，不進 argv、不進檔案。
# migration SQL 檔本身不得含 CREATE USER / IDENTIFIED BY / SET PASSWORD（MAJOR-F9）。
#
# 見 plan-db-as-truth-v3.md §2.1 / §2.2、plan-db-as-truth-v3.2.md MAJOR-F9。
set -euo pipefail

CONTAINER=mon-mysql
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"
SECRETS_DIR="$HOME/.aladdin-secrets/monitor-db"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: 找不到 $ENV_FILE" >&2
  exit 1
fi

ROOT_PW=$(grep '^MON_DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
if [ -z "$ROOT_PW" ]; then
  echo "ERROR: 缺 MON_DB_ROOT_PASSWORD" >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: 容器 $CONTAINER 不存在，先跑 run-container.sh" >&2
  exit 1
fi

MYSQL_ROOT() {
  docker exec -i -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysql -uroot "$@"
}

echo "=== 套用 migrations ==="
MYSQL_ROOT -e "CREATE DATABASE IF NOT EXISTS pipeline_monitor CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
MYSQL_ROOT pipeline_monitor -e "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB;"

for f in "$DIR"/migrations/*.sql; do
  [ -e "$f" ] || continue
  version="$(basename "$f")"
  applied=$(MYSQL_ROOT -N -B pipeline_monitor -e "SELECT COUNT(*) FROM schema_migrations WHERE version='${version}';")
  if [ "$applied" = "1" ]; then
    echo "  [skip] $version 已套用"
    continue
  fi
  echo "  [apply] $version"
  # 反向驗證：migration 檔本身不得含帳號密碼相關語句（MAJOR-F9 §5.8 反向驗證第 4 段，Phase 0 提前套用）
  if grep -niE "identified by|set password|create user" "$f"; then
    echo "FAIL_SECRET_IN_SQL: $f 含帳號/密碼相關語句，拒絕套用" >&2
    exit 1
  fi
  MYSQL_ROOT pipeline_monitor < "$f"
  MYSQL_ROOT pipeline_monitor -e "INSERT INTO schema_migrations (version) VALUES ('${version}');"
done

echo "=== 建立三個帳號（逐表最小權限） ==="
mkdir -p "$SECRETS_DIR"
chmod 700 "$HOME/.aladdin-secrets" 2>/dev/null || true
chmod 700 "$SECRETS_DIR"

gen_or_reuse_password() {
  local file="$1"
  if [ -f "$file" ]; then
    grep '^PASSWORD=' "$file" | cut -d= -f2-
  else
    local pw
    pw=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
    echo "PASSWORD=${pw}" > "$file"
    chmod 600 "$file"
    echo "$pw"
  fi
}

MON_HEAD_PW=$(gen_or_reuse_password "$SECRETS_DIR/mon_head.env")
MON_UI_PW=$(gen_or_reuse_password "$SECRETS_DIR/mon_ui.env")
MON_EXEC_PW=$(gen_or_reuse_password "$SECRETS_DIR/mon_exec.env")

# host pattern 一律 '%'：Docker Desktop userland proxy 會把所有連線 SNAT 成
# 172.17.0.1，host pattern 不是安全邊界（真正邊界是 publish 只綁 127.0.0.1
# ＋ 跨機走 SSH tunnel ＋ 逐表最小權限，見 §2.2）。
MYSQL_ROOT <<SQL
CREATE USER IF NOT EXISTS 'mon_head'@'%' IDENTIFIED BY '${MON_HEAD_PW}';
ALTER USER 'mon_head'@'%' IDENTIFIED BY '${MON_HEAD_PW}';
CREATE USER IF NOT EXISTS 'mon_ui'@'%' IDENTIFIED BY '${MON_UI_PW}';
ALTER USER 'mon_ui'@'%' IDENTIFIED BY '${MON_UI_PW}';
CREATE USER IF NOT EXISTS 'mon_exec'@'%' IDENTIFIED BY '${MON_EXEC_PW}';
ALTER USER 'mon_exec'@'%' IDENTIFIED BY '${MON_EXEC_PW}';

-- mon_head：server.ts、head 上的名冊 CLI、回填腳本。SELECT/INSERT/UPDATE，不含 DELETE/DDL。
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.* TO 'mon_head'@'%';
-- 2026-09-16（Phase 6，使用者核准）：唯一的 DELETE 例外——tech-users.csv 刪檔退役後，
-- 「把離職者從名冊移除」沒有其他對等管道（以前是刪 CSV 一行）。不開的話離職者會
-- 永遠留在白名單裡。範圍刻意收到最小：只有這一張表、只有這一個帳號，其餘表仍無
-- DELETE（見 lib/registry/tech-users-sync.ts 的 --remove-user）。
GRANT DELETE ON pipeline_monitor.tech_users TO 'mon_head'@'%';

-- mon_ui：tg-monitor 讀取面 ＋ cancel 旗標欄位級寫入（裁定 3，v3.2）。
GRANT SELECT ON pipeline_monitor.runs TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.dispatch_attempts TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.agent_runs TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.workers TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.worker_status_log TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.service_status_log TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.tg_webhook_status_log TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.mcp_usage TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.monitor_heartbeat TO 'mon_ui'@'%';
-- migration 005（pipeline-modes Phase 3）：mon_ui 對兩張新表唯讀（面板顯示各票階段/產物所在機）。
GRANT SELECT ON pipeline_monitor.ticket_stages TO 'mon_ui'@'%';
GRANT SELECT ON pipeline_monitor.ticket_artifact_sync TO 'mon_ui'@'%';
GRANT INSERT (run_id, host, ticket, kind, lifecycle_rank, cancel_requested_at, cancel_resolved_by, legacy_key, created_at, review_rounds, final_review_rounds) ON pipeline_monitor.runs TO 'mon_ui'@'%';
GRANT UPDATE (cancel_requested_at, cancel_resolved_by, outcome, outcome_source, review_rounds, final_review_rounds) ON pipeline_monitor.runs TO 'mon_ui'@'%';

-- mon_exec：每一台 worker（逐表最小權限，不含 mcp_tokens/tg_unknown_senders/mcp_usage/dispatch_attempts）。
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.runs TO 'mon_exec'@'%';
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.agent_runs TO 'mon_exec'@'%';
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.file_offsets TO 'mon_exec'@'%';
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.monitor_heartbeat TO 'mon_exec'@'%';
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.worker_status_log TO 'mon_exec'@'%';
-- migration 005（pipeline-modes Phase 3）：worker 在 run 結束時寫自己的 stage 快照；
-- ticket_artifact_sync 只有 head 寫，worker 唯讀（Phase 4 的產物存在性檢查會查它）。
GRANT SELECT, INSERT, UPDATE ON pipeline_monitor.ticket_stages TO 'mon_exec'@'%';
GRANT SELECT ON pipeline_monitor.ticket_artifact_sync TO 'mon_exec'@'%';
-- 2026-09-16（Phase 6 收尾，使用者核准，FAQ-5094 事故修復）：tech-users.csv 退役後
-- resolve-reviewer.sh（/create-mr Step 0.5）在 worker 上改成呼叫 tech-users-sync.ts
-- --list-roster 查 DB，但 worker 用 mon_exec 帳號，原本刻意不含 tech_users，導致
-- Step 0.5 在 worker 上必然 SELECT 被拒。改為僅 SELECT（不含 UPDATE/DELETE，
-- tg_chat_id_enc/_bidx 仍只有 mon_head 能寫）。
GRANT SELECT ON pipeline_monitor.tech_users TO 'mon_exec'@'%';

FLUSH PRIVILEGES;
SQL

echo "帳號建立完成。密碼存放於 $SECRETS_DIR/{mon_head,mon_ui,mon_exec}.env（各 0600）。"
echo "mon_head 的密碼另需寫入 telegram-dispatcher/.env 的 MON_DB_PASSWORD（不由本腳本自動寫入 .env，避免覆蓋既有內容）。"
