#!/bin/zsh
# launchd wrapper：啟動監控 log 的專用 loopback intake（bun run lib/log-shipper/intake-server.ts）。
# 環境變數讀取手法比照 run-server.sh：grep '^KEY=' 從 telegram-dispatcher 自己的
# .env 逐一匯出，token/secret 不出現在腳本或 plist 明文裡。
#
# VL 憑證（MON_VL_URL / MON_VL_USER / MON_VL_PASSWORD）只進本白名單，
# 不進 run-server.sh（見 plan-db-as-truth-v3.2.md §9 修訂：Phase 0 步驟 5）。
set -u
ALADDIN="/Users/user/aladdin"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
ENV_FILE="$DISPATCHER_DIR/.env"
BUN="/Users/user/.bun/bin/bun"

for KEY in CLUSTER_SHARED_SECRET MON_DB_ENABLED MON_VL_URL MON_VL_USER MON_VL_PASSWORD; do
  VALUE=$(grep "^${KEY}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
  export "${KEY}=${VALUE}"
done

if [ -z "$CLUSTER_SHARED_SECRET" ]; then
  echo "ERROR: 無法從 $ENV_FILE 讀取 CLUSTER_SHARED_SECRET" >&2
  exit 1
fi

cd "$DISPATCHER_DIR" || exit 1

# exec 讓 bun 取代 shell 行程本身，launchd SIGTERM 才殺得到 bun（同 run-server.sh）。
exec "$BUN" run lib/log-shipper/intake-server.ts
