#!/bin/zsh
# DEPRECATED（2026-08-25）：已被 run-cloudflare-tunnel.sh 取代（tunnel aladdin-mcp，
# 網域 mcp.aladdin-assistant.cc，DNS 已指到 Cloudflare Tunnel，不再指向這支腳本啟動
# 的 ngrok 網址）。對應 launchd job com.aladdin.tg-dispatch-tunnel 已 bootout 並從
# ~/Library/LaunchAgents/ 移除，不再自動啟動。保留本檔與同目錄 .plist 只供緊急回退
# 參考，不會被 bootstrap。
#
# launchd wrapper：啟動 ngrok tunnel，指向本機 telegram-dispatcher webhook server。
#
# risk_notes（見 tasks.json T18）：明確不用 `ngrok service install`（會另建一
# 支非專案命名慣例的 launchd job，且需額外維護 ngrok.yml，控制權變弱），改
# 自寫 plist 直接呼叫 `ngrok http --url=...`（ngrok 3.23.3 現行語法）。
# authtoken 已存在全域 ngrok.yml，這裡不需要另外處理。
#
# 刻意不加任何會動到 request inspector（本機 4040 web UI）綁定位址的旗標
# ——review 實測 `ngrok http --help` 確認：真正控制綁定位址的是 `--web-addr`，
# 而這個旗標根本不在 `ngrok http` 子命令的選項清單裡（只在頂層/全域設定），
# 這支腳本完全沒去動它，維持 ngrok 預設只 bind 127.0.0.1，不對外開放
# （`--inspect` 這個旗標實際語意是開關 HTTP introspection 記錄，跟綁定位址
# 無關，先前註解誤植，已修正）。
#
# T18：只負責把這支腳本寫好，不執行，不讓 tunnel 真的上線
# （見 tasks.json T18 acceptance_criteria）。
#
# 語法核對：實測本機安裝的 ngrok（`ngrok version` 回報 3.23.3，跟
# risk_notes 講的版本一致）`ngrok http --help` 的 USAGE 是
# `ngrok http [address:port | port] [flags]`，範例一律 port 在前、
# `--url <value>`（空格分隔）在後——這裡照抄這個順序與寫法，不是自己猜的。
#
# T30（見 tasks.json H30）：加 `--inspect=false` 關掉本機 4040 web UI 的
# request introspection（`/api/requests/http` 這類會落地明文 header/body 的
# 記錄）——hosted MCP 化後同一條 tunnel 會流過明文密碼、Bearer token 等
# 敏感內容，任何本機行程都撈得到，必須關掉。`--inspect` 實測確實是
# `ngrok http` 子命令自己的旗標（不像上面提到、不存在於這個子命令的
# `--web-addr`），`ngrok http --help` 列出 `--inspect  enable/disable http
# introspection (default true)`。關掉後 `/api/tunnels`（health-monitor.ts
# 依賴的 tunnel 狀態 API，跟 introspection 是不同端點）仍正常回應，實測見
# H30 changelog。
set -u
NGROK="/opt/homebrew/bin/ngrok"
# 跟 launchd/run-server.sh 的 PORT=8787 保持同一個明確值。
PORT=8787
TUNNEL_URL="https://unrefreshing-trudy-subsequently.ngrok-free.dev"

exec "$NGROK" http "$PORT" --url "$TUNNEL_URL" --inspect=false
