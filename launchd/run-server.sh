#!/bin/zsh
# launchd wrapper：啟動 telegram-dispatcher webhook server（bun run server.ts）。
# 比照 cron/bug-report-run.sh 的手法：用 grep '^KEY=' 從根目錄 .env 逐一匯出，
# 不用 dotenv、不自己解析整份 .env、token 不出現在這支腳本或 plist 明文裡。
#
# T18：只負責把這支腳本寫好，不執行 launchctl load，不讓服務真的上線
# （見 tasks.json T18 acceptance_criteria）。
set -u
ALADDIN="/Users/user/aladdin"
ENV_FILE="$ALADDIN/.env"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
BUN="/Users/user/.bun/bin/bun"

TG_DISPATCH_BOT_TOKEN=$(grep '^TG_DISPATCH_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
TG_WEBHOOK_PATH=$(grep '^TG_WEBHOOK_PATH=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
TG_WEBHOOK_SECRET=$(grep '^TG_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
# /kit 指令授權（見 lib/webhook-server/kit-issue.ts）——不是必要變數，缺了只是
# /kit 功能關閉（isKitAdminChat 恆回傳 false），不擋伺服器啟動。
TG_KIT_ADMIN_CHAT_ID=$(grep '^TG_KIT_ADMIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
export TG_DISPATCH_BOT_TOKEN TG_WEBHOOK_PATH TG_WEBHOOK_SECRET TG_KIT_ADMIN_CHAT_ID
# 跟 launchd/run-tunnel.sh 的 ngrok 目標 port 保持同一個明確值，不依賴
# server.ts 自己的預設值（8787）——兩支獨立 wrapper 各自隱含同一個預設，
# 未來任一邊改動容易悄悄漂移，這裡明講掉。
export PORT=8787

if [ -z "$TG_DISPATCH_BOT_TOKEN" ] || [ -z "$TG_WEBHOOK_PATH" ] || [ -z "$TG_WEBHOOK_SECRET" ]; then
  echo "ERROR: 無法從 $ENV_FILE 讀取 TG_DISPATCH_BOT_TOKEN / TG_WEBHOOK_PATH / TG_WEBHOOK_SECRET" >&2
  exit 1
fi

cd "$DISPATCHER_DIR" || exit 1

# 最後一行用 exec（不是背景 &）：讓 bun 直接取代這個 shell 行程本身，
# launchd 送 SIGTERM 時才會真的殺到 bun，不會只殺掉外層 shell 留孤兒行程。
exec "$BUN" run server.ts
