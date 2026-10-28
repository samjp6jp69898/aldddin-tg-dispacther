#!/bin/zsh
# launchd 包裝：從 telegram-dispatcher/.env 讀 changelog bot 需要的變數後啟動
# changelog-bot.ts（long polling，不需要 tunnel / webhook）。比照 run-server.sh：
# 逐一 grep 指定變數、不 source 整份 .env。
set -u
ALADDIN="/Users/user/aladdin"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
ENV_FILE="$DISPATCHER_DIR/.env"
BUN="/Users/user/.bun/bin/bun"

# 允許的群組不在 .env：由後台動態設定、記錄在監控 DB（見 lib/webhook-server/changelog-group-allowlist.ts），
# 下面的 MON_DB_* 就是查那張表用的連線變數（mon_head）。
TG_ALADDIN_OPERATION_BOT_TOKEN=$(grep '^TG_ALADDIN_OPERATION_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
TG_BUG_REPORT_ADMIN_CHAT_ID=$(grep '^TG_BUG_REPORT_ADMIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
MON_DB_HOST=$(grep '^MON_DB_HOST=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
MON_DB_PORT=$(grep '^MON_DB_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
MON_DB_SCHEMA=$(grep '^MON_DB_SCHEMA=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
MON_DB_USER=$(grep '^MON_DB_USER=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
MON_DB_PASSWORD=$(grep '^MON_DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
export TG_ALADDIN_OPERATION_BOT_TOKEN TG_BUG_REPORT_ADMIN_CHAT_ID MON_DB_HOST MON_DB_PORT MON_DB_SCHEMA MON_DB_USER MON_DB_PASSWORD

if [ -z "$TG_ALADDIN_OPERATION_BOT_TOKEN" ]; then
  echo "ERROR: 無法從 $ENV_FILE 讀取 TG_ALADDIN_OPERATION_BOT_TOKEN" >&2
  exit 1
fi

cd "$DISPATCHER_DIR" || exit 1

# exec：launchd 送 SIGTERM 時直接殺到 bun，不留孤兒行程（同 run-server.sh）。
exec "$BUN" run changelog-bot.ts
