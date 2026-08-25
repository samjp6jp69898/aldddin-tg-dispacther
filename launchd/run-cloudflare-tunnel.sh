#!/bin/zsh
# launchd wrapper：啟動 Cloudflare Tunnel（aladdin-mcp），指向本機 telegram-dispatcher
# webhook server（:8787）。2026-08-25 起取代 run-tunnel.sh（ngrok 版，見該檔）——
# 這台機器是這條 tunnel 的其中一個 connector（另一台機器仍同時連著，cloudflared
# 原生支援多 connector 接同一條 tunnel，互為備援，不像 ngrok 限單一 session）。
#
# tunnel 本身（id、DNS route）不是這支腳本建立的，是既有正式資源：
#   名稱：aladdin-mcp
#   id：  6906f8e7-e46e-43f3-abd5-b43bbaa96e3e
#   網域：mcp.aladdin-assistant.cc（已在 Cloudflare 註冊，DNS 已指到這條 tunnel）
# 這台機器要能連上，靠的是 ~/.cloudflared/6906f8e7-e46e-43f3-abd5-b43bbaa96e3e.json
# 這份 credentials-file（用 `cloudflared tunnel token --cred-file ... aladdin-mcp`
# 在本機用帳號層級 cert.pem 現領的，不是從別台機器搬檔案過來）；ingress 規則見
# 同目錄 cloudflared-config.yml（單一規則轉本機 8787，內部路徑分流由 telegram-
# dispatcher 自己的 Hono app 處理，tunnel 這層不需要知道）。
set -u
CLOUDFLARED="/opt/homebrew/bin/cloudflared"
CONFIG="/Users/user/aladdin/telegram-dispatcher/launchd/cloudflared-config.yml"

exec "$CLOUDFLARED" tunnel --config "$CONFIG" run aladdin-mcp
