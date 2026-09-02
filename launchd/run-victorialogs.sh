#!/bin/zsh
# launchd wrapper：啟動監控用 VictoriaLogs（head only）。
# 密碼經 -envflag.enable 由環境變數注入，不進 argv、不進 plist 明文
#（見 plan-db-as-truth-v3.md §7.1）。env var 命名規則：flag 的 '.' 換成 '_'，
# 大小寫比照原 flag（本輪實測確認：httpAuth.username -> httpAuth_username）。
set -u
ALADDIN="/Users/user/aladdin"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
ENV_FILE="$DISPATCHER_DIR/.env"
VL_BIN="/opt/homebrew/opt/victorialogs/bin/victoria-logs"
DATA_PATH="$ALADDIN/tg-monitor/data/victoria-logs"

MON_VL_USER=$(grep '^MON_VL_USER=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
MON_VL_PASSWORD=$(grep '^MON_VL_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')

if [ -z "$MON_VL_USER" ] || [ -z "$MON_VL_PASSWORD" ]; then
  echo "ERROR: 無法從 $ENV_FILE 讀取 MON_VL_USER / MON_VL_PASSWORD" >&2
  exit 1
fi

export httpAuth_username="$MON_VL_USER"
export httpAuth_password="$MON_VL_PASSWORD"

mkdir -p "$DATA_PATH"

exec "$VL_BIN" \
  -envflag.enable=true \
  -httpListenAddr=127.0.0.1:9428 \
  -retentionPeriod=90d \
  -insert.maxLineSizeBytes=2MB \
  -storageDataPath="$DATA_PATH"
