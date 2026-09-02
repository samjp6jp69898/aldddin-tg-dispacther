#!/bin/zsh
# Phase 0：建立監控 DB 專用的獨立 docker MySQL container（mon-mysql）。
# 與 dev 那顆 db-mysql(3306) 完全隔離：獨立 datadir、獨立 publish port(3307)、
# 獨立帳號體系。本腳本冪等——容器已存在時只驗證關鍵參數一致，不重建。
#
# 見 plan-db-as-truth-v3.md §2.1（決策 1）。
set -euo pipefail

CONTAINER=mon-mysql
IMAGE="mysql:8.4.6"
DATADIR="/Users/user/aladdin/mysql_store/mysql-monitor-data"
PUBLISH="127.0.0.1:3307:3306"
ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: 找不到 $ENV_FILE，請先建立（見 .env.example）" >&2
  exit 1
fi

ROOT_PW=$(grep '^MON_DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
if [ -z "$ROOT_PW" ]; then
  echo "ERROR: $ENV_FILE 內找不到 MON_DB_ROOT_PASSWORD" >&2
  exit 1
fi

mkdir -p "$DATADIR"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "容器 $CONTAINER 已存在，驗證關鍵參數..."
  ACTUAL_IMAGE=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')
  ACTUAL_MOUNT=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Source}}{{end}}')
  ACTUAL_PORT=$(docker inspect "$CONTAINER" --format '{{range $p,$c := .NetworkSettings.Ports}}{{$p}}={{(index $c 0).HostIp}}:{{(index $c 0).HostPort}}{{end}}')
  echo "  image=$ACTUAL_IMAGE mount=$ACTUAL_MOUNT port=$ACTUAL_PORT"
  if [ "$ACTUAL_IMAGE" != "$IMAGE" ]; then
    echo "ERROR: 既有容器 image ($ACTUAL_IMAGE) 與預期 ($IMAGE) 不符，拒絕自動處理，需要人工介入" >&2
    exit 1
  fi
  if [ "$ACTUAL_MOUNT" != "$DATADIR" ]; then
    echo "ERROR: 既有容器 datadir ($ACTUAL_MOUNT) 與預期 ($DATADIR) 不符，拒絕自動處理" >&2
    exit 1
  fi
  echo "參數一致，不重建。"
  exit 0
fi

echo "建立容器 $CONTAINER (image=$IMAGE datadir=$DATADIR publish=$PUBLISH) ..."
docker run -d \
  --name "$CONTAINER" \
  --restart=always \
  -p "$PUBLISH" \
  -v "$DATADIR:/var/lib/mysql" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" \
  "$IMAGE" \
  --innodb-buffer-pool-size=256M \
  --max-connections=200 \
  --character-set-server=utf8mb4 \
  --default-time-zone=+00:00

echo "等待 mysqld 就緒..."
for i in $(seq 1 60); do
  if docker exec -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysqladmin ping -uroot --silent >/dev/null 2>&1; then
    echo "mon-mysql 已就緒（等待 ${i}s）"
    exit 0
  fi
  sleep 1
done

echo "ERROR: mon-mysql 在 60 秒內未就緒" >&2
exit 1
