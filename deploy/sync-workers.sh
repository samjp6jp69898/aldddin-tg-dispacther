#!/bin/bash
# sync-workers.sh — head 端：把 GitHub 上**已 push** 的 aladdin_ai / telegram-dispatcher / aladdin_mcps
# 派送到名冊裡每台 worker（ssh 進去 git pull --ff-only + 視需要 bun install + 重啟 worker agent）。
#
# 用法：bash deploy/sync-workers.sh [--worker <name|ip>] [--no-restart] [--force-restart] [--dry-run]
#   --worker <name|ip>   只同步這一台（名稱或 IP，對照 logs/cluster-workers.json）
#   --no-restart         只 pull 不重啟 worker agent
#   --force-restart      worker 上有進行中的 pipeline（/tmp/bug-analysis-locks 有 ticket 鎖）也照樣重啟
#                        （預設遇到進行中的單會跳過重啟並回報，避免打斷 job-done 回報鏈）
#   --dry-run            只印每台會執行的動作，不 ssh
#
# 一次性前提（每台 worker）：
#   1. 系統設定 → 一般 → 共享 → 開「遠端登入」，允許 user
#   2. 從 head 執行 ssh-copy-id user@<worker_ip>（把 head 的公鑰放進 worker 的 authorized_keys）
#   3. bash deploy/doctor-worker.sh 在 worker 上跑過（含新增的「Remote Login」檢查）
#
# 本腳本**不 git push**（CLAUDE.md 硬規則；push 是人的動作）。head 本機 main 若領先 origin/main
# 會直接拒跑（先 push 再來）——否則 worker pull 到的是舊版，跟 head 行為不一致。
# 名冊來源：logs/cluster-workers.json（worker agent 啟動時自動登記），disabled=true 的跳過。
#
# 輸出契約（呼叫端行首 grep）：
#   WORKER_OK   <name> aladdin_ai=<sha7> telegram-dispatcher=<sha7> aladdin_mcps=<sha7> bun_install=yes|no symlink=ok|<n>_bad restart=done|skipped(<n> jobs)|off health=ok|pending
#   WORKER_FAIL <name> <原因>
#   WORKER_SKIP <name> <原因>
#   SYNC_DONE ok=N fail=M skip=K        （任一 WORKER_FAIL → exit 1）
set -u
ROOT=/Users/user/aladdin
DISPATCHER=$ROOT/telegram-dispatcher
ROSTER=$DISPATCHER/logs/cluster-workers.json
SSH_USER=user
REPOS="aladdin_ai telegram-dispatcher aladdin_mcps"

ONLY=""; NO_RESTART=0; FORCE=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --worker) ONLY="${2:-}"; shift 2;;
    --no-restart) NO_RESTART=1; shift;;
    --force-restart) FORCE=1; shift;;
    --dry-run) DRY=1; shift;;
    *) echo "SYNC_DONE ok=0 fail=0 skip=0 (未知選項 $1)"; exit 1;;
  esac
done

# ---- 1. head 端前置：三個 repo 都必須已 push（main 不可領先 origin/main）----
TARGET_AI=""; TARGET_TD=""; TARGET_MCPS=""
for repo in $REPOS; do
  git -C "$ROOT/$repo" fetch origin main --quiet 2>/dev/null || { echo "SYNC_DONE ok=0 fail=0 skip=0 (head 的 $repo fetch origin 失敗)"; exit 1; }
  AHEAD=$(git -C "$ROOT/$repo" rev-list --count origin/main..main 2>/dev/null || echo "?")
  if [ "$AHEAD" != "0" ]; then
    echo "HEAD_UNPUSHED: $repo 本機 main 領先 origin/main $AHEAD 個 commit——先 git push 再跑本腳本（本腳本不代推）"
    echo "SYNC_DONE ok=0 fail=0 skip=0"; exit 1
  fi
  SHA=$(git -C "$ROOT/$repo" rev-parse --short=7 origin/main)
  case "$repo" in aladdin_ai) TARGET_AI=$SHA;; telegram-dispatcher) TARGET_TD=$SHA;; aladdin_mcps) TARGET_MCPS=$SHA;; esac
done
echo "TARGET: aladdin_ai=$TARGET_AI telegram-dispatcher=$TARGET_TD aladdin_mcps=$TARGET_MCPS (origin/main)"

# ---- 2. 讀名冊 ----
[ -f "$ROSTER" ] || { echo "SYNC_DONE ok=0 fail=0 skip=0 (名冊 $ROSTER 不存在——head 尚未啟用 cluster 或沒有 worker 登記)"; exit 1; }
# 每行：name<TAB>host<TAB>disabled
WORKERS=$(python3 - "$ROSTER" <<'PY'
import json, sys
from urllib.parse import urlparse
d = json.load(open(sys.argv[1]))
for w in d.get("workers", []):
    host = urlparse(w.get("url", "")).hostname or ""
    print(f"{w.get('name','')}\t{host}\t{'1' if w.get('disabled') else '0'}")
PY
)
[ -n "$WORKERS" ] || { echo "SYNC_DONE ok=0 fail=0 skip=0 (名冊為空)"; exit 1; }

# ---- 3. 遠端腳本（以 bash -s 送過去；$1..$5 = target_ai target_td target_mcps no_restart force）----
REMOTE='
set -u
TARGET_AI="$1"; TARGET_TD="$2"; TARGET_MCPS="$3"; NO_RESTART="$4"; FORCE="$5"
ROOT=/Users/user/aladdin
BUN=/Users/user/.bun/bin/bun
BUN_INSTALL=no
for repo in aladdin_ai telegram-dispatcher aladdin_mcps; do
  cd "$ROOT/$repo" 2>/dev/null || { echo "REMOTE_FAIL: $repo 目錄不存在"; exit 2; }
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "REMOTE_FAIL: $repo 有未 commit 的已追蹤變更，拒絕 pull（請到該機處理：git stash 或 commit）"; exit 2
  fi
  BR=$(git branch --show-current)
  [ "$BR" = "main" ] || { git checkout -q main 2>/dev/null || { echo "REMOTE_FAIL: $repo 在分支 $BR 且無法切回 main"; exit 2; }; }
  git fetch origin main --quiet || { echo "REMOTE_FAIL: $repo fetch origin 失敗（git 憑證/網路）"; exit 2; }
  OLD=$(git rev-parse HEAD)
  git merge --ff-only origin/main --quiet || { echo "REMOTE_FAIL: $repo 無法 fast-forward 到 origin/main（本機 main 有分岔 commit）"; exit 2; }
  NEW=$(git rev-parse HEAD)
  if [ "$repo" = "telegram-dispatcher" ] && [ "$OLD" != "$NEW" ] && git diff --name-only "$OLD" "$NEW" | grep -qE "^(package.json|bun.lock)$"; then
    "$BUN" install --frozen-lockfile >/tmp/sync-workers-bun-install.log 2>&1 && BUN_INSTALL=yes || { echo "REMOTE_FAIL: bun install 失敗，log /tmp/sync-workers-bun-install.log"; exit 2; }
  fi
done
SHA_AI=$(git -C "$ROOT/aladdin_ai" rev-parse --short=7 HEAD)
SHA_TD=$(git -C "$ROOT/telegram-dispatcher" rev-parse --short=7 HEAD)
SHA_MCPS=$(git -C "$ROOT/aladdin_mcps" rev-parse --short=7 HEAD)
# symlink 健檢（AGENTS.md 那行是已知且使用者裁定不修的，排除）
BAD=$(bash "$ROOT/scripts/sync-mirrors.sh" --check 2>/dev/null | grep "^SYMLINK_" | grep -v "SYMLINK_OK" | grep -v "AGENTS.md" | wc -l | tr -d " ")
[ "$BAD" = "0" ] && SYMLINK=ok || SYMLINK="${BAD}_bad"
# 重啟
JOBS=$(ls -d /tmp/bug-analysis-locks/*/ 2>/dev/null | wc -l | tr -d " ")
if [ "$NO_RESTART" = "1" ]; then RESTART=off
elif [ "$JOBS" != "0" ] && [ "$FORCE" != "1" ]; then RESTART="skipped(${JOBS} jobs)"
else
  launchctl kickstart -k "gui/$(id -u)/com.aladdin.tg-worker-agent" 2>/dev/null && RESTART=done || RESTART=kickstart_failed
fi
PORT=$(grep -m1 "^CLUSTER_WORKER_PORT=" "$ROOT/telegram-dispatcher/.env" 2>/dev/null | cut -d= -f2-); PORT="${PORT:-8801}"
curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && HEALTH=ok || HEALTH=pending
echo "REMOTE_RESULT aladdin_ai=$SHA_AI telegram-dispatcher=$SHA_TD aladdin_mcps=$SHA_MCPS bun_install=$BUN_INSTALL symlink=$SYMLINK restart=$RESTART health=$HEALTH"
'

# ---- 4. 逐台執行 ----
OK=0; FAIL=0; SKIP=0; MATCHED=0
while IFS=$'\t' read -r NAME HOST DISABLED; do
  [ -n "$NAME" ] || continue
  if [ -n "$ONLY" ] && [ "$ONLY" != "$NAME" ] && [ "$ONLY" != "$HOST" ]; then continue; fi
  MATCHED=$((MATCHED+1))
  if [ "$DISABLED" = "1" ]; then echo "WORKER_SKIP $NAME disabled=true"; SKIP=$((SKIP+1)); continue; fi
  [ -n "$HOST" ] || { echo "WORKER_FAIL $NAME 名冊 url 解析不出 host"; FAIL=$((FAIL+1)); continue; }
  if [ "$DRY" = 1 ]; then
    echo "DRY: ssh $SSH_USER@$HOST → pull $REPOS 到 origin/main($TARGET_AI/$TARGET_TD/$TARGET_MCPS)，restart=$([ "$NO_RESTART" = 1 ] && echo off || echo yes) force=$FORCE"
    echo "WORKER_SKIP $NAME dry-run"; SKIP=$((SKIP+1)); continue
  fi
  echo "== $NAME ($HOST) =="
  OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST" \
        bash -s -- "$TARGET_AI" "$TARGET_TD" "$TARGET_MCPS" "$NO_RESTART" "$FORCE" <<<"$REMOTE" 2>&1)
  RC=$?
  printf '%s\n' "$OUT" | grep -v "^REMOTE_RESULT" | sed 's/^/  /'
  RES=$(printf '%s\n' "$OUT" | grep -m1 "^REMOTE_RESULT")
  if [ $RC -ne 0 ] || [ -z "$RES" ]; then
    REASON=$(printf '%s\n' "$OUT" | grep -m1 "REMOTE_FAIL\|Permission denied\|Connection refused\|timed out\|No route" | cut -c1-160)
    echo "WORKER_FAIL $NAME ${REASON:-ssh exit=${RC}（Remote Login 未開 / 公鑰未佈署 / 網路不通，見檔頭一次性前提）}"; FAIL=$((FAIL+1)); continue
  fi
  GOT_AI=$(printf '%s' "$RES" | sed -E 's/.*aladdin_ai=([0-9a-f]+).*/\1/')
  GOT_TD=$(printf '%s' "$RES" | sed -E 's/.*telegram-dispatcher=([0-9a-f]+).*/\1/')
  GOT_MCPS=$(printf '%s' "$RES" | sed -E 's/.*aladdin_mcps=([0-9a-f]+).*/\1/')
  if [ "$GOT_AI" != "$TARGET_AI" ] || [ "$GOT_TD" != "$TARGET_TD" ] || [ "$GOT_MCPS" != "$TARGET_MCPS" ]; then
    echo "WORKER_FAIL $NAME pull 後版本不符（aladdin_ai=${GOT_AI}≠$TARGET_AI 或 telegram-dispatcher=${GOT_TD}≠$TARGET_TD 或 aladdin_mcps=${GOT_MCPS}≠${TARGET_MCPS}）"; FAIL=$((FAIL+1)); continue
  fi
  echo "WORKER_OK $NAME ${RES#REMOTE_RESULT }"; OK=$((OK+1))
done <<<"$WORKERS"

if [ -n "$ONLY" ] && [ "$MATCHED" -eq 0 ]; then
  echo "WORKER_FAIL $ONLY 名冊 $ROSTER 裡沒有這個名稱/IP（現有：$(printf '%s\n' "$WORKERS" | cut -f1 | tr '\n' ' ')）"; FAIL=$((FAIL+1))
fi
echo "SYNC_DONE ok=$OK fail=$FAIL skip=$SKIP"
[ "$FAIL" -eq 0 ]
