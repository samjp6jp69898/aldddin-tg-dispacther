#!/bin/bash
# 新 worker 機一鍵引導腳本（冪等，可重跑）。
#
# 用途：把一台裸 macOS 佈置成 telegram-dispatcher 的 worker 機（接 head 派
# 來的 /create-mr 與需求 pipeline）。能自動做的自動做，需要人工/互動式授權
# 的（.env 複製、claude 登入、repo clone 憑證）只檢查並印出待辦，不硬做。
# 全程不碰 git push、不動任何 repo 內容。
#
# 前提（本腳本會檢查但不代辦）：
#   - 帳號必須叫 user、aladdin 放在 /Users/user/aladdin（整個生態系寫死此
#     路徑，見 telegram-dispatcher/README.md「路徑是寫死的」一節——worker
#     採「約定同路徑」策略，不做路徑參數化）
#   - obsidian/ 與各子專案 repo 需自行 clone（需要各自的 git 憑證）
#   - telegram-dispatcher/.env（2026-08-31 前為根目錄 .env） 需從 head 安全複製（AirDrop/scp/USB）
#
# 跑完後執行 deploy/doctor-worker.sh 驗收，全綠才把 worker 加入派工池。
set -u

ALADDIN="/Users/user/aladdin"
DISPATCHER="$ALADDIN/telegram-dispatcher"
PASS=0; WARN=0; TODO=()

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
todo() { echo "  🔲 待辦：$1"; WARN=$((WARN+1)); TODO+=("$1"); }

echo "== 1. 路徑與帳號慣例 =="
if [ "$HOME" = "/Users/user" ]; then ok "帳號家目錄是 /Users/user"; else todo "帳號必須叫 user（目前 HOME=${HOME}）——整個生態系寫死 /Users/user 路徑，請建立同名帳號後重跑"; fi
if [ -d "$ALADDIN" ]; then ok "$ALADDIN 存在"; else mkdir -p "$ALADDIN" && ok "已建立 $ALADDIN"; fi

echo "== 2. 基礎工具 =="
if [ -x "/Users/user/.bun/bin/bun" ]; then ok "bun（$(/Users/user/.bun/bin/bun --version)）"; else todo "安裝 bun：curl -fsSL https://bun.sh/install | bash"; fi
if [ -x "/Users/user/.local/bin/claude" ]; then ok "claude CLI（$(/Users/user/.local/bin/claude --version 2>/dev/null | head -1)）"; else todo "安裝 Claude Code CLI 到 /Users/user/.local/bin/claude（pipeline 寫死此路徑），裝完執行一次 claude 完成登入"; fi
if command -v git >/dev/null 2>&1; then ok "git"; else todo "安裝 Xcode Command Line Tools（xcode-select --install）"; fi
if command -v brew >/dev/null 2>&1; then ok "Homebrew"; else todo "安裝 Homebrew（https://brew.sh）"; fi
if command -v timeout >/dev/null 2>&1 || [ -x /opt/homebrew/bin/timeout ]; then ok "GNU timeout（coreutils）"; else todo "brew install coreutils（pipeline wrapper 依賴 GNU timeout）"; fi
if command -v glab >/dev/null 2>&1; then ok "glab"; else todo "brew install glab && glab auth login（mr-pusher 建 MR 用）"; fi
# worker 機不需要 cloudflared / tunnel / webhook——那些是 head 專屬。

echo "== 3. repo checkout（需自備 git 憑證，本腳本不代 clone）=="
for repo in obsidian aladdin_ai aladdin_mcps agrabah abu lago rajah telegram-dispatcher; do
  if [ -d "$ALADDIN/$repo/.git" ]; then ok "$repo"; else todo "clone $repo 到 $ALADDIN/$repo"; fi
done

echo "== 4. symlink 重建（aladdin_ai 為單一來源，見 CLAUDE.md；obsidian 2026-08-31 起改為純知識庫，不再是 symlink 來源）=="
if [ -d "$ALADDIN/aladdin_ai" ]; then
  mkdir -p "$ALADDIN/.claude"
  ln -sfn "$ALADDIN/aladdin_ai/commands" "$ALADDIN/.claude/commands"
  ln -sfn "$ALADDIN/aladdin_ai/agents"   "$ALADDIN/.claude/agents"
  ln -sfn "$ALADDIN/aladdin_ai/skills"   "$ALADDIN/.claude/skills"
  ln -sfn "$ALADDIN/aladdin_ai/doctrine" "$ALADDIN/.claude/doctrine"
  ln -sfn "$ALADDIN/aladdin_ai/scripts"  "$ALADDIN/scripts"
  ln -sfn "$ALADDIN/aladdin_ai/conn"     "$ALADDIN/conn"
  ok "6 條 symlink 已重建（.claude/{commands,agents,skills,doctrine} + scripts + conn）"
else
  todo "aladdin_ai repo 尚未 clone，symlink 留待 clone 後重跑本腳本"
fi

echo "== 5. telegram-dispatcher 依賴與工作目錄 =="
if [ -d "$DISPATCHER" ] && [ -x "/Users/user/.bun/bin/bun" ]; then
  (cd "$DISPATCHER" && /Users/user/.bun/bin/bun install >/dev/null 2>&1) && ok "bun install 完成" || todo "cd telegram-dispatcher && bun install 失敗，請手動排查"
fi
mkdir -p "$ALADDIN/worktrees" "$DISPATCHER/logs" 2>/dev/null && ok "worktrees/ 與 logs/ 目錄就緒"
[ -d "$ALADDIN/obsidian" ] && mkdir -p "$ALADDIN/obsidian/Debug"

echo "== 6. 非 git 資產（不代辦，只檢查——2026-09-03 事故補課）=="
# 這三項都不在任何 repo 裡，也無法在 worker 這端自己取得（worker 沒有回連
# head 的管道），所以只能列待辦、由人從 head 推過來。2026-08-31 建 landon2
# 時三項全漏，且當時 bootstrap 與 doctor 都沒有檢查它們，機器看起來是好的、
# 實際上每張派來的單都白跑。缺失的共同特徵是「不會讓 pipeline 報錯退出」。
TRACKER_MD="$HOME/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md"
mkdir -p "$(dirname "$TRACKER_MD")" 2>/dev/null
if [ -f "$TRACKER_MD" ] && grep -qE '^\| FAQ-[0-9]+ \|' "$TRACKER_MD" 2>/dev/null; then
  ok "bug_analysis_tracker.md 已存在"
else
  todo "從 head 複製 bug 認領表（缺了會讓每張派來的單在 /create-mr Step 0.1 判 not claimable、幾十秒 SKIPPED）：在 head 執行 scp -p ~/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md user@<本機IP>:~/.claude/projects/-Users-user-aladdin/memory/"
fi
if [ -x "$HOME/.claude/gdrive.sh" ] && [ -f "$HOME/.claude/gdrive_token.json" ]; then
  ok "gdrive.sh + gdrive_token.json 已存在"
else
  todo "從 head 複製 Google Drive 上傳工具與憑證（缺了分析文件上傳會全失敗、Notion 留言沒有文件連結）：在 head 執行 scp -p ~/.claude/gdrive.sh ~/.claude/gdrive_token.json user@<本機IP>:~/.claude/"
fi
if [ -d "$ALADDIN/cqa-e2e" ] && [ -n "$(ls -A "$ALADDIN/cqa-e2e" 2>/dev/null)" ]; then
  ok "cqa-e2e/ 已存在"
else
  todo "從 head 同步 CQA 取證環境（缺了 cqa-grounder 無法做畫面取證、grounding 降級 DEGRADED；約 360MB）：在 head 執行 rsync -a /Users/user/aladdin/cqa-e2e/ user@<本機IP>:/Users/user/aladdin/cqa-e2e/"
fi

echo "== 7. .env（不代辦，只檢查）=="
if [ -f "$DISPATCHER/.env" ]; then
  MISSING=""
  for KEY in CLUSTER_SHARED_SECRET CLUSTER_HEAD_URL CLUSTER_WORKER_NAME CLUSTER_WORKER_URL TG_DISPATCH_BOT_TOKEN ALD_NOTION_TOKEN MON_DB_ENABLED MON_DB_HOST MON_DB_PORT MON_DB_SCHEMA MON_DB_USER MON_DB_PASSWORD; do
    grep -q "^${KEY}=" "$DISPATCHER/.env" || MISSING="$MISSING $KEY"
  done
  if [ -z "$MISSING" ]; then ok ".env 必要 key 齊全"; else todo ".env 缺 key：${MISSING}（CLUSTER_* 見 launchd/run-worker-agent.sh 檔頭說明；其餘從 head 的 .env 複製；MON_* 由 head 在 Phase 3 scp 時寫入，worker 端 MON_DB_HOST=127.0.0.1、MON_DB_PORT=3307、MON_DB_USER=mon_exec）"; fi
else
  todo "從 head 安全複製 .env 到 $DISPATCHER/.env（AirDrop/scp/USB，不走會落地存放的通道），再補 CLUSTER_WORKER_NAME / CLUSTER_WORKER_URL 為本機值"
fi

echo "== 8. launchd（worker agent 常駐）=="
if [ -f "$DISPATCHER/launchd/com.aladdin.tg-worker-agent.plist" ]; then
  cp "$DISPATCHER/launchd/com.aladdin.tg-worker-agent.plist" "$HOME/Library/LaunchAgents/" 2>/dev/null \
    && ok "plist 已複製到 ~/Library/LaunchAgents/（啟動見下方指令）" \
    || todo "手動複製 plist 到 ~/Library/LaunchAgents/"
fi

echo ""
echo "== 結果：$PASS 項就緒，$WARN 項待辦 =="
if [ ${#TODO[@]} -gt 0 ]; then
  echo "待辦清單："
  for t in "${TODO[@]}"; do echo "  - $t"; done
  echo ""
  echo "完成待辦後重跑本腳本，直到 0 待辦。"
else
  echo "全部就緒。接下來："
  echo "  1. bash $DISPATCHER/deploy/doctor-worker.sh   # 驗收（全綠才上線）"
  echo "  2. launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-worker-agent.plist"
  echo "  3. 系統設定 → 電池：關閉「插電時允許進入睡眠」（睡著會接不到派工）"
fi
exit 0
