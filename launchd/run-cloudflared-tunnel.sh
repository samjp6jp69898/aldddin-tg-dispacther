#!/bin/zsh
# launchd wrapper：啟動 cloudflared tunnel，指向本機 telegram-dispatcher webhook server。
# 取代 ngrok（2026-08-22，使用者裁定，H28 risk_notes (12) 收斂）：cloudflared 沒有 ngrok
# 免費方案「同帳號同時只允許 1 個 tunnel session」與並發連線數/頻寬上限的問題。
#
# 比照 run-tunnel.sh（ngrok 版）的既有慣例：不用背景服務安裝指令（避免另外產生一支
# 不受這個 repo 管控的系統服務），改自寫 plist 直接呼叫 `cloudflared tunnel run`，
# 設定與憑證的實際內容都在 cloudflared-config.yml / ~/.cloudflared/ 底下管理。
set -u
CLOUDFLARED="/opt/homebrew/bin/cloudflared"
CONFIG="/Users/user/aladdin/telegram-dispatcher/launchd/cloudflared-config.yml"

exec "$CLOUDFLARED" tunnel --config "$CONFIG" run aladdin-mcp
