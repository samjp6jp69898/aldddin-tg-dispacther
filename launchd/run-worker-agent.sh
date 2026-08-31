#!/bin/zsh
# launchd wrapper：啟動 telegram-dispatcher worker agent（bun run worker-agent.ts）。
# 只在 worker 機使用——head（跑 server.ts 的那台）不需要這支。
# 環境變數讀取手法比照 run-server.sh：grep '^KEY=' 從根目錄 .env 逐一匯出，
# token/secret 不出現在腳本或 plist 明文裡。
#
# 需要的 .env 變數（worker 機的 /Users/user/aladdin/.env）：
#   CLUSTER_SHARED_SECRET  head/worker 共用認證 secret（≥32 字元，與 head 同值）
#   CLUSTER_HEAD_URL       head 的 LAN 位址，如 http://192.168.1.10:8787
#   CLUSTER_WORKER_NAME    本機在 cluster 裡的名字，如 mac-mini-2
#   CLUSTER_WORKER_URL     本機對 LAN 的位址，如 http://192.168.1.50:8801
#                          （建議兩台都在路由器上做 DHCP 固定 IP）
#   CLUSTER_WORKER_PORT    選填，預設 8801
#   TG_DISPATCH_BOT_TOKEN  pipeline 收尾通知（tg-notify.sh / post-run-notify）用，
#                          與 head 同值
# 另外 /create-mr pipeline 本身需要的其他變數（Notion token 等）也要在
# .env 裡，隨 aladdin 主線走——worker 的 .env 直接從 head 安全複製一份即可
# （AirDrop/scp/USB，不走會落地存放的通道）。
set -u
ALADDIN="/Users/user/aladdin"
ENV_FILE="$ALADDIN/.env"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
BUN="/Users/user/.bun/bin/bun"

for KEY in CLUSTER_SHARED_SECRET CLUSTER_HEAD_URL CLUSTER_WORKER_NAME CLUSTER_WORKER_URL CLUSTER_WORKER_PORT TG_DISPATCH_BOT_TOKEN; do
  VALUE=$(grep "^${KEY}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
  export "${KEY}=${VALUE}"
done

if [ -z "$CLUSTER_SHARED_SECRET" ] || [ -z "$CLUSTER_HEAD_URL" ] || [ -z "$CLUSTER_WORKER_NAME" ] || [ -z "$CLUSTER_WORKER_URL" ]; then
  echo "ERROR: 無法從 $ENV_FILE 讀取 CLUSTER_SHARED_SECRET / CLUSTER_HEAD_URL / CLUSTER_WORKER_NAME / CLUSTER_WORKER_URL" >&2
  exit 1
fi

cd "$DISPATCHER_DIR" || exit 1

# exec 讓 bun 取代 shell 行程本身，launchd SIGTERM 才殺得到 bun（同 run-server.sh）。
exec "$BUN" run worker-agent.ts
