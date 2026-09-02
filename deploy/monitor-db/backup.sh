#!/bin/zsh
# 每日備份 pipeline_monitor（§2.4）。備份目錄在所有 repo 之外
# （~/.aladdin-backups/monitor-db/，比照 §5.8 名冊備份的位置紀律），
# 保留最近 14 份，由本腳本自己修剪（不依賴外部清理排程，m-9）。
set -euo pipefail

CONTAINER=mon-mysql
ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"
BACKUP_DIR="$HOME/.aladdin-backups/monitor-db"
KEEP=14

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: 找不到 $ENV_FILE" >&2
  exit 1
fi

ROOT_PW=$(grep '^MON_DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
if [ -z "$ROOT_PW" ]; then
  echo "ERROR: 缺 MON_DB_ROOT_PASSWORD" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$HOME/.aladdin-backups" 2>/dev/null || true
chmod 700 "$BACKUP_DIR"

TS=$(date -u +%Y-%m-%dT%H-%M-%S)
OUT="$BACKUP_DIR/pipeline_monitor.${TS}.sql.gz"

docker exec -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" \
  mysqldump --single-transaction --skip-lock-tables -uroot pipeline_monitor \
  | gzip > "$OUT"
chmod 600 "$OUT"

echo "備份完成: $OUT ($(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT") bytes)"

# 修剪：只留最近 $KEEP 份
COUNT=$(ls -1 "$BACKUP_DIR"/pipeline_monitor.*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/pipeline_monitor.*.sql.gz | tail -n +"$((KEEP + 1))" | while read -r f; do
    echo "修剪舊備份: $f"
    rm -f "$f"
  done
fi
