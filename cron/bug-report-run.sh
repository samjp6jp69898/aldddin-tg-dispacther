#!/bin/zsh
# launchd wrapper（com.aladdin.bug-report，週一至週五 08:00）：跑
# bug-report-send.ts，把 Bug 指派人員統計三份品牌 CSV 推給
# TG_BUG_REPORT_ADMIN_CHAT_ID。比照 run-server.sh 的手法：用 grep '^KEY='
# 從 telegram-dispatcher 自己的 .env 逐一匯出（2026-08-31 前是根目錄 .env），
# 不用 dotenv、不自己解析整份 .env、token 不出現在這支腳本或 plist 明文裡。
set -u
ALADDIN="/Users/user/aladdin"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
ENV_FILE="$DISPATCHER_DIR/.env"
BUN="/Users/user/.bun/bin/bun"

TG_DISPATCH_BOT_TOKEN=$(grep '^TG_DISPATCH_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
TG_BUG_REPORT_ADMIN_CHAT_ID=$(grep '^TG_BUG_REPORT_ADMIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
export TG_DISPATCH_BOT_TOKEN TG_BUG_REPORT_ADMIN_CHAT_ID

if [ -z "$TG_DISPATCH_BOT_TOKEN" ] || [ -z "$TG_BUG_REPORT_ADMIN_CHAT_ID" ]; then
  echo "ERROR: 無法從 $ENV_FILE 讀取 TG_DISPATCH_BOT_TOKEN / TG_BUG_REPORT_ADMIN_CHAT_ID" >&2
  exit 1
fi

cd "$DISPATCHER_DIR" || exit 1
exec "$BUN" run cron/bug-report-send.ts
