#!/bin/zsh
# backfill/test-schema.sh — 建立 / 刪除回填測試用的臨時 schema。
#
# 測試紀律（指揮官指派 2026-09-02）：對 mon-mysql(127.0.0.1:3307) 建臨時測試
# schema（pipeline_monitor_backfill_test），執行完 DROP；絕不寫正式 pipeline_monitor。
#
# 用法：
#   bash test-schema.sh create   # 建 schema、套全部 migrations/*.sql DDL、GRANT mon_head（僅此臨時 schema）
#   bash test-schema.sh drop     # DROP DATABASE（連帶收回 grant）
#
# root 認證與 migrate.sh 同構（docker exec + MYSQL_PWD 環境變數注入，不進 argv）。
# GRANT 只對臨時 schema、生命週期隨 create/drop，正式授權面不變。
set -euo pipefail

CONTAINER=mon-mysql
TEST_SCHEMA=pipeline_monitor_backfill_test
DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$DIR/../migrations"
ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"

ROOT_PW=$(grep '^MON_DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
if [ -z "$ROOT_PW" ]; then
  echo "ERROR: 缺 MON_DB_ROOT_PASSWORD" >&2
  exit 1
fi

MYSQL_ROOT() {
  docker exec -i -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysql -uroot "$@"
}

case "${1:-}" in
  create)
    MYSQL_ROOT -e "CREATE DATABASE IF NOT EXISTS ${TEST_SCHEMA} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
    # 001-init.sql 開頭有 CREATE DATABASE pipeline_monitor / USE pipeline_monitor，
    # 套進臨時 schema 時把這兩行換掉（只在管線中替換，不動 migration 檔本身）。
    # 訊息裡的「已套用」清單一律動態列出實際跑過的檔案（*.sql glob 順序＝檔名字典序，
    # 與 migrate.sh 一致），不寫死檔數——避免新增 migration 後訊息變成陳舊資訊。
    applied_migrations=()
    for f in "$MIGRATIONS_DIR"/*.sql; do
      sed -e "s/^USE pipeline_monitor;/USE ${TEST_SCHEMA};/" \
          -e "s/CREATE DATABASE IF NOT EXISTS pipeline_monitor/CREATE DATABASE IF NOT EXISTS ${TEST_SCHEMA}/" \
          "$f" | MYSQL_ROOT "$TEST_SCHEMA"
      applied_migrations+=("$(basename "$f")")
    done
    MYSQL_ROOT -e "GRANT SELECT, INSERT, UPDATE ON ${TEST_SCHEMA}.* TO 'mon_head'@'%'; FLUSH PRIVILEGES;"
    echo "OK: ${TEST_SCHEMA} 已建立（全部 migrations 已套用 [${#applied_migrations[@]} 檔：${applied_migrations[*]}]、mon_head 已授權）"
    ;;
  drop)
    MYSQL_ROOT -e "DROP DATABASE IF EXISTS ${TEST_SCHEMA}; FLUSH PRIVILEGES;"
    echo "OK: ${TEST_SCHEMA} 已刪除"
    ;;
  *)
    echo "用法: $0 create|drop" >&2
    exit 1
    ;;
esac
