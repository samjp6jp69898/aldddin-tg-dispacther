#!/bin/bash
# worker 機驗收腳本（唯讀，不改任何狀態）。全部 ✅ 才把這台加入派工池。
# bootstrap-worker.sh 是「佈置」，這支是「體檢」——分開是刻意的：體檢可以
# 在日常任何時候重跑（例如懷疑某台 worker 環境壞了），不會有副作用。
set -u

ALADDIN="/Users/user/aladdin"
DISPATCHER="$ALADDIN/telegram-dispatcher"
ENV_FILE="$ALADDIN/.env"
BUN="/Users/user/.bun/bin/bun"
CLAUDE_BIN="/Users/user/.local/bin/claude"
FAIL=0

ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info() { echo "  ℹ️  $1"; }

envval() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r\n'; }

echo "== 路徑慣例 =="
[ "$HOME" = "/Users/user" ] && ok "HOME=/Users/user" || bad "帳號不是 user（HOME=${HOME}），生態系寫死路徑會全面失效"
[ -d "$ALADDIN" ] && ok "$ALADDIN 存在" || bad "$ALADDIN 不存在"

echo "== 工具鏈 =="
[ -x "$BUN" ] && ok "bun $($BUN --version 2>/dev/null)" || bad "bun 不在 /Users/user/.bun/bin/bun"
if [ -x "$CLAUDE_BIN" ]; then
  ok "claude $($CLAUDE_BIN --version 2>/dev/null | head -1)"
  info "登入狀態無法離線驗證：請確認在這台跑過一次 claude 並完成登入（背景 pipeline 用同一份登入態）"
else
  bad "claude 不在 /Users/user/.local/bin/claude（pipeline 寫死此路徑）"
fi
command -v timeout >/dev/null 2>&1 && ok "GNU timeout（$(command -v timeout)）" || bad "GNU timeout 缺失（brew install coreutils）"
command -v git >/dev/null 2>&1 && ok "git" || bad "git 缺失"
if command -v glab >/dev/null 2>&1; then
  glab auth status >/dev/null 2>&1 && ok "glab 已認證" || bad "glab 未認證（glab auth login）"
else
  bad "glab 缺失（brew install glab）"
fi

echo "== repo checkout 與遠端連通 =="
for repo in obsidian aladdin_ai aladdin_mcps agrabah abu lago rajah telegram-dispatcher; do
  if [ -d "$ALADDIN/$repo/.git" ]; then
    if git -C "$ALADDIN/$repo" ls-remote origin HEAD >/dev/null 2>&1; then
      ok "${repo}（origin 可達）"
    else
      bad "${repo}：origin 連不上（git 憑證/網路問題，pipeline 的 fetch/push 會失敗）"
    fi
  else
    bad "$repo 未 clone"
  fi
done

echo "== symlink 與腳本 =="
for link in "$ALADDIN/.claude/commands" "$ALADDIN/.claude/agents" "$ALADDIN/.claude/skills" "$ALADDIN/.claude/doctrine" "$ALADDIN/scripts" "$ALADDIN/conn"; do
  [ -L "$link" ] && [ -e "$link" ] && ok "symlink $link" || bad "symlink 壞掉/缺失：${link}（見 bootstrap-worker.sh 第 4 節）"
done
for sh in bug-lock.sh tracker.sh notion.sh tg-notify.sh setup-worktree.sh; do
  [ -f "$ALADDIN/scripts/$sh" ] && ok "scripts/$sh" || bad "scripts/$sh 缺失"
done

echo "== .env =="
if [ -f "$ENV_FILE" ]; then
  for KEY in CLUSTER_SHARED_SECRET CLUSTER_HEAD_URL CLUSTER_WORKER_NAME CLUSTER_WORKER_URL TG_DISPATCH_BOT_TOKEN ALD_NOTION_TOKEN; do
    [ -n "$(envval "$KEY")" ] && ok "$KEY 已設定" || bad "$KEY 缺失/空值"
  done
  SECRET="$(envval CLUSTER_SHARED_SECRET)"
  [ "${#SECRET}" -ge 32 ] && ok "CLUSTER_SHARED_SECRET 長度足夠" || bad "CLUSTER_SHARED_SECRET 長度 <32，worker-agent 會拒絕啟動"
else
  bad "$ENV_FILE 不存在"
fi

echo "== head 連通性 =="
HEAD_URL="$(envval CLUSTER_HEAD_URL)"
if [ -n "$HEAD_URL" ]; then
  if curl -sf --max-time 5 "$HEAD_URL/health" >/dev/null 2>&1; then
    ok "head $HEAD_URL /health 可達"
  else
    bad "head $HEAD_URL /health 打不通（確認 head 的 server.ts 在跑、同網段、防火牆放行 8787）"
  fi
fi

echo "== worker agent =="
PORT="$(envval CLUSTER_WORKER_PORT)"; PORT="${PORT:-8801}"
if curl -sf --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  ok "worker agent 已在本機 $PORT 運行"
else
  info "worker agent 尚未運行（尚未 launchctl bootstrap，或剛體檢還沒啟動——非錯誤）"
fi
[ -f "$HOME/Library/LaunchAgents/com.aladdin.tg-worker-agent.plist" ] && ok "launchd plist 已就位" || bad "plist 未複製到 ~/Library/LaunchAgents/"

echo "== 電源 =="
if command -v pmset >/dev/null 2>&1; then
  SLEEP_SETTING=$(pmset -g custom 2>/dev/null | awk '/AC Power/{f=1} f && /^[[:space:]]*sleep/{print $2; exit}')
  if [ "$SLEEP_SETTING" = "0" ]; then ok "插電不睡眠（sleep=0）"; else bad "插電會睡眠（sleep=${SLEEP_SETTING:-?}）——睡著會接不到派工，請到系統設定關閉"; fi
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "== 體檢通過（0 項失敗）：這台可以加入派工池 =="
else
  echo "== 體檢未過：$FAIL 項失敗，修完再跑一次 =="
fi
exit "$FAIL"
