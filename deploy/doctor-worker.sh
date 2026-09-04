#!/bin/bash
# worker 機驗收腳本（唯讀，不改任何狀態）。全部 ✅ 才把這台加入派工池。
# bootstrap-worker.sh 是「佈置」，這支是「體檢」——分開是刻意的：體檢可以
# 在日常任何時候重跑（例如懷疑某台 worker 環境壞了），不會有副作用。
set -u

# PATH 正規化（2026-09-03 踩到）：本腳本常被從 head 遠端非互動執行
# （`ssh user@worker 'bash -s' < deploy/doctor-worker.sh`），那種 shell 的
# PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，**不含 Homebrew**，於是 timeout、
# glab 這些裝在 /opt/homebrew/bin 的工具會全部被誤報成「缺失」——當時據此
# 判定 worker 沒裝 glab，實際上它裝著、缺的只是認證。pipeline 自己跑在
# launchd 環境下 PATH 是完整的，所以誤報只會出現在體檢，不影響實際執行。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ALADDIN="/Users/user/aladdin"
DISPATCHER="$ALADDIN/telegram-dispatcher"
ENV_FILE="$DISPATCHER/.env"
ALADDIN_AI_ENV_FILE="$ALADDIN/aladdin_ai/.env.local"
BUN="/Users/user/.bun/bin/bun"
CLAUDE_BIN="/Users/user/.local/bin/claude"
FAIL=0
WARN=0

ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
# warn：這台仍可上線接單，但某類收尾會做不完（例如開不了 MR），需要有人事後
# 補。刻意不計入 FAIL——把「機器不能用」跟「產出少一步」混為同一個阻擋條件，
# 會讓維運者為了讓體檢變綠而忽略真正的紅燈。
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }
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
# GitLab 身分（2026-09-03 起 worker 完全不需要 glab）：
#   - 推拉（push/fetch）走 SSH key，由下面「repo checkout 與遠端連通」那節的
#     `git ls-remote origin HEAD` 實測。
#   - 開 MR 走 **push options over SSH**（見 agents/mr-pusher.md Step 1），
#     同一把 SSH key、不需要任何 API token。
# 這裡驗的是「這把 key 對得上 GitLab 帳號」——push 得動不等於 GitLab 認得它，
# MR 作者就是這個帳號。glab 只有 head 的 /refine-mr 會用（讀寫既有 MR 留言，
# push options 做不到那件事），worker 只跑 bug/demand 兩種 pipeline，兩者都不
# 碰 glab，所以這裡刻意不檢查 glab 有沒有裝或有沒有認證。
GITLAB_HOST="$(git -C "$ALADDIN/lago" remote get-url origin 2>/dev/null | sed -E 's#^[a-z+]+://[^@]*@([^:/]+).*#\1#')"
GITLAB_PORT="$(git -C "$ALADDIN/lago" remote get-url origin 2>/dev/null | sed -nE 's#^[a-z+]+://[^@]*@[^:/]+:([0-9]+).*#\1#p')"
if [ -z "$GITLAB_HOST" ]; then
  warn "無法從 lago 的 origin 推導 GitLab host，未能驗證 SSH 身分"
else
  # `-n`（把 ssh 的 stdin 導向 /dev/null）不可省略：本腳本常以
  # `ssh user@worker 'bash -s' < doctor-worker.sh` 遠端執行，此時腳本自己就是
  # stdin。ssh 預設會讀 stdin，會把腳本剩下的內容整個吃掉——症狀是體檢跑到
  # 這一行就無聲中止，後面所有檢查與總結全部不執行（2026-09-03 踩到）。
  SSH_WHOAMI="$(ssh -n -T -o BatchMode=yes -o ConnectTimeout=8 ${GITLAB_PORT:+-p "$GITLAB_PORT"} "git@${GITLAB_HOST}" 2>&1 | head -1)"
  case "$SSH_WHOAMI" in
    *"Welcome to GitLab"*)
      ok "GitLab SSH 身分：${SSH_WHOAMI#*, }（開 MR 的 push options 用這個身分，MR 作者即為此帳號）" ;;
    *)
      bad "GitLab SSH 認證失敗（${GITLAB_HOST}）：${SSH_WHOAMI:-無回應} → 推不了分支也開不了 MR。檢查 ~/.ssh/config 是否把 ${GITLAB_HOST} 指向正確的 key、該 key 是否已加到 GitLab 帳號" ;;
  esac
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

echo "== 非 git 資產（需從 head 複製，本腳本不代辦）=="
# 2026-09-03 事故補課。這三項都不在任何 repo 裡，2026-08-31 建 landon2 時全部
# 漏帶，而當時 doctor 沒有任何一項檢查涵蓋它們——**體檢全綠、機器卻是壞的**。
# 三者的共同特徵是「缺了不會讓 pipeline 報錯退出」，所以只能靠體檢抓：
#   - tracker 缺 → tracker.sh 對檔案不存在直接 exit 1、被 ensureTrackerPending
#     的 catch 靜默吞掉 → /create-mr Step 0.1 把每張單都判 not claimable、
#     幾十秒就 SKIPPED。head 端只看得到「派出去、幾秒後 job-done」，兩天 7 張白跑。
#   - gdrive 缺 → drive-uploader 上傳全失敗，Notion 留言沒有文件連結，
#     分析產物困在 worker 本機。
#   - cqa-e2e 缺 → cqa-grounder 的 Playwright lib 全滅，畫面取證降級 DEGRADED。
TRACKER_MD="$HOME/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md"
if [ -f "$TRACKER_MD" ] && grep -qE '^\| FAQ-[0-9]+ \|' "$TRACKER_MD" 2>/dev/null; then
  ok "bug_analysis_tracker.md（$(grep -cE '^\| FAQ-[0-9]+ \|' "$TRACKER_MD" 2>/dev/null) 筆）"
else
  bad "bug_analysis_tracker.md 缺失或空表 → /create-mr Step 0.1 會把每張派來的單都判成 not claimable。從 head 執行：ssh user@<本機IP> 'mkdir -p ~/.claude/projects/-Users-user-aladdin/memory' && scp -p ~/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md user@<本機IP>:~/.claude/projects/-Users-user-aladdin/memory/"
fi
# 首次複製之後不需要人工維護：worker-agent 每次接單前會向 head 抓一份覆蓋本機
# （GET /cluster/tracker），跑完把該單終態隨 job-done 回寫 head，head 那份是
# 唯一權威（見 lib/pipeline-runner/tracker-sync.ts「整檔同步」段落）。這裡檢查
# 的是「首次要有一份」——worker-agent 起來之前就得存在。
if [ -x "$HOME/.claude/gdrive.sh" ] && [ -f "$HOME/.claude/gdrive_token.json" ]; then
  ok "gdrive.sh + gdrive_token.json（drive-uploader 用）"
else
  bad "gdrive.sh 或 gdrive_token.json 缺失 → 分析文件上傳 Google Drive 會全數失敗、Notion 留言不會有文件連結。從 head 執行：scp -p ~/.claude/gdrive.sh ~/.claude/gdrive_token.json user@<本機IP>:~/.claude/"
fi
if [ -d "$ALADDIN/cqa-e2e" ] && [ -n "$(ls -A "$ALADDIN/cqa-e2e" 2>/dev/null)" ]; then
  ok "cqa-e2e/（cqa-grounder 的 Playwright lib）"
else
  bad "cqa-e2e/ 缺失或空目錄 → cqa-grounder 無法做畫面取證，grounding 會降級成 DEGRADED。從 head 執行：rsync -a /Users/user/aladdin/cqa-e2e/ user@<本機IP>:/Users/user/aladdin/cqa-e2e/"
fi
info "worker 上 obsidian/Debug/ 的分析產物不會自動回到 head（該 repo 在 worker 端不 push）；gdrive 正常時走 Drive，需要原始檔則從 head scp 撈回"

echo "== .env（telegram-dispatcher/.env）=="
if [ -f "$ENV_FILE" ]; then
  for KEY in CLUSTER_SHARED_SECRET CLUSTER_HEAD_URL CLUSTER_WORKER_NAME CLUSTER_WORKER_URL TG_DISPATCH_BOT_TOKEN; do
    [ -n "$(envval "$KEY")" ] && ok "$KEY 已設定" || bad "$KEY 缺失/空值"
  done
  SECRET="$(envval CLUSTER_SHARED_SECRET)"
  [ "${#SECRET}" -ge 32 ] && ok "CLUSTER_SHARED_SECRET 長度足夠" || bad "CLUSTER_SHARED_SECRET 長度 <32，worker-agent 會拒絕啟動"
else
  bad "$ENV_FILE 不存在"
fi

echo "== 監控 DB（Phase 3+）=="
# 第 1、2 項是反向斷言（權限、禁止金鑰），任何時期都該成立，不受下方
# 「尚未佈建」前置豁免——即使 Phase 3 還沒做，.env 權限與金鑰缺席本來就該通過。
if [ -f "$ENV_FILE" ]; then
  PERM=$(stat -f %Lp "$ENV_FILE" 2>/dev/null)
  [ "$PERM" = "600" ] && ok ".env 權限 600" || bad ".env 權限是 ${PERM:-?}（非 600，BLOCKER-D1 硬檢查）：chmod 600 $ENV_FILE"
else
  bad "$ENV_FILE 不存在，無法檢查權限"
fi

if [ -f "$ENV_FILE" ]; then
  LEAKED=""
  for PAT in '^MON_FIELD_KEY' '^MON_BIDX_KEY' '^MON_DB_ROOT_PASSWORD'; do
    grep -qE "$PAT" "$ENV_FILE" 2>/dev/null && LEAKED="$LEAKED $PAT"
  done
  [ -z "$LEAKED" ] && ok ".env 不含金鑰（MON_FIELD_KEY_*／MON_BIDX_KEY／MON_DB_ROOT_PASSWORD）" || bad ".env 含不該出現在 worker 的金鑰：${LEAKED}（金鑰只在 head，§4.2 反向斷言，立即撤換）"
fi
ENVLEAK=""
for PAT in MON_FIELD_KEY MON_BIDX_KEY MON_DB_ROOT_PASSWORD; do
  printenv | grep -q "^${PAT}" && ENVLEAK="$ENVLEAK $PAT"
done
[ -z "$ENVLEAK" ] && ok "行程環境不含金鑰" || bad "行程環境含不該出現的金鑰：${ENVLEAK}"

if [ -f "$ENV_FILE" ] && grep -q '^MON_DB_' "$ENV_FILE" 2>/dev/null; then
  MON_DB_USER="$(envval MON_DB_USER)"
  [ "$MON_DB_USER" = "mon_exec" ] && ok "MON_DB_USER=mon_exec" || bad "MON_DB_USER=${MON_DB_USER:-<空>}（worker 不得拿到其他帳號，必須是 mon_exec）"

  MON_DB_HOST="$(envval MON_DB_HOST)"
  MON_DB_PORT="$(envval MON_DB_PORT)"
  [ "$MON_DB_HOST" = "127.0.0.1" ] && ok "MON_DB_HOST=127.0.0.1" || bad "MON_DB_HOST=${MON_DB_HOST:-<空>}（worker 走 tunnel，應固定 127.0.0.1，見 §3.1）"
  [ "$MON_DB_PORT" = "3307" ] && ok "MON_DB_PORT=3307" || bad "MON_DB_PORT=${MON_DB_PORT:-<空>}（worker 走 tunnel，應固定 3307，見 §3.1）"

  if nc -z -G 2 127.0.0.1 3307 >/dev/null 2>&1; then
    ok "127.0.0.1:3307 通（monitor-db tunnel）"
  else
    bad "127.0.0.1:3307 不通：檢查 head 的 monitor-tunnel job（com.aladdin.monitor-tunnel.<worker>）"
  fi
  if nc -z -G 2 127.0.0.1 9429 >/dev/null 2>&1; then
    ok "127.0.0.1:9429 通（monitor-log-intake tunnel）"
  else
    bad "127.0.0.1:9429 不通：檢查 head 的 monitor-tunnel job（com.aladdin.monitor-tunnel.<worker>）"
  fi
else
  info "監控 DB 尚未佈建（Phase 3 前正常），略過本節其餘檢查"
fi

echo "== .env（aladdin_ai/.env.local，pipeline 用）=="
if [ -f "$ALADDIN_AI_ENV_FILE" ]; then
  ALD_NOTION_TOKEN=$(grep -m1 '^ALD_NOTION_TOKEN=' "$ALADDIN_AI_ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
  [ -n "$ALD_NOTION_TOKEN" ] && ok "ALD_NOTION_TOKEN 已設定" || bad "ALD_NOTION_TOKEN 缺失/空值"
else
  bad "$ALADDIN_AI_ENV_FILE 不存在"
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

echo "== Remote Login（head 用 deploy/sync-workers.sh ssh 進來派送程式碼更新）=="
if nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1; then
  ok "sshd 在 22 port 監聽（系統設定 → 共享 → 遠端登入 已開）"
  [ -s "$HOME/.ssh/authorized_keys" ] && ok "~/.ssh/authorized_keys 有內容（head 公鑰應在其中，從 head 執行 ssh-copy-id user@本機IP）" || bad "~/.ssh/authorized_keys 空/缺失：head 無法免密 ssh 進來（從 head 執行 ssh-copy-id user@本機IP）"
else
  bad "22 port 未監聽：系統設定 → 一般 → 共享 → 開「遠端登入」並允許 user，否則 head 的 sync-workers.sh 連不進來"
fi

echo "== 電源 =="
# 2026-09-03：先看有沒有第三方防睡眠工具在跑。landon2 用 Amphetamine 常駐維持
# 喚醒，pmset 的 sleep 值仍是 1，只看 pmset 會誤報成「會睡眠」。判定順序改成
# 「工具接管 > pmset 設定」——真正要確認的是「這台不會睡著」，不是某個設定值。
KEEPAWAKE=""
for APP in Amphetamine caffeinate KeepingYouAwake Lungo; do
  pgrep -qx "$APP" 2>/dev/null && KEEPAWAKE="$APP" && break
done
if [ -n "$KEEPAWAKE" ]; then
  ok "防睡眠工具運行中（${KEEPAWAKE}）——pmset 的 sleep 設定不適用"
elif command -v pmset >/dev/null 2>&1; then
  SLEEP_SETTING=$(pmset -g custom 2>/dev/null | awk '/AC Power/{f=1} f && /^[[:space:]]*sleep/{print $2; exit}')
  if [ "$SLEEP_SETTING" = "0" ]; then ok "插電不睡眠（sleep=0）"; else bad "插電會睡眠（sleep=${SLEEP_SETTING:-?}）且未偵測到防睡眠工具——睡著會接不到派工，請到系統設定關閉或啟用 Amphetamine"; fi
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  if [ "$WARN" -eq 0 ]; then
    echo "== 體檢通過（0 失敗 / 0 警告）：這台可以加入派工池 =="
  else
    echo "== 體檢通過（0 失敗 / ${WARN} 警告）：這台可以加入派工池，但上面的 ⚠️ 代表某些收尾要人工補，請先看過再上線 =="
  fi
else
  echo "== 體檢未過：${FAIL} 項失敗、${WARN} 項警告，修完再跑一次 =="
fi
exit "$FAIL"
