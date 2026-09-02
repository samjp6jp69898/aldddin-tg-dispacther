#!/bin/bash
# 秒級止血總開關：一次把 MON_DB_ENABLED 同步改到 head、tg-monitor、每台名冊
# 裡未 disabled 的 worker，並各自 kickstart 對應 job 讓新值立即生效。
# plan v3 §9.0(C) + v3.2 F-MINOR-9。
#
# 用法：
#   set-monitor-flag.sh <0|1> [--dry-run]        統一把 MON_DB_ENABLED 設為 0 或 1
#   set-monitor-flag.sh --rollback [--dry-run]   讀 logs/monitor-flag-state.json，
#                                                 把上次改過的目標各自改回舊值
#
# 目標清單：
#   1. head        telegram-dispatcher/.env → kickstart com.aladdin.tg-dispatch-server
#                  與 com.aladdin.monitor-log-intake（本機 launchctl）
#   2. tg-monitor  ../tg-monitor/.env → kickstart com.aladdin.tg-monitor（本機 launchctl）
#   3. 每台 worker（logs/cluster-workers.json，disabled=true 跳過）：
#      ssh 改該機 telegram-dispatcher/.env → ssh kickstart com.aladdin.tg-worker-agent
#
# .env 改法：讀「grep+printf 逐行重組到 tmp，再 cat > 原檔」，不用 sed -i（macOS
# 是 BSD sed，語法跟 GNU 不同容易踩雷）、不用 mv（會換 inode，可能悄悄重設
# 權限/擁有者——.env 必須維持 600）。只替換 MON_DB_ENABLED= 那一行，其餘行原樣
# 保留、順序不變。
#
# 部分失敗語意（F-MINOR-9，寫死）：逐台繼續、不因一台失敗中斷整支腳本；結束
# 時只要有任一目標失敗 → 非 0 退出，並在最後明列「仍在跑舊值」的目標清單
# （env 沒改成功、或 env 改了但 kickstart 沒成功套用，兩種都算「服務仍在跑舊
# 值」）。不自動回滾已經改成功的目標——Phase 8（cutover）之前混合狀態無害，
# 讀取面（tg-monitor）此時仍是走 sqlite，不受 MON_DB_ENABLED 混合值影響。
# 操作者下一步：修好卡住的目標後重跑同一條指令（冪等，可安全重複執行），或
# 用 --rollback 讀 state 檔把上次改過的目標改回舊值。
#
# state 檔（logs/monitor-flag-state.json，覆寫式）：每次「env 值真的被改寫」
# 都會記一筆 {target, prev, changedAt}，供 --rollback 使用。--dry-run 模式
# 不執行任何步驟、也不寫 state 檔。
set -u

ALADDIN="/Users/user/aladdin"
DISPATCHER="$ALADDIN/telegram-dispatcher"
HEAD_ENV="$DISPATCHER/.env"
TGMON_ENV="$ALADDIN/tg-monitor/.env"
ROSTER="$DISPATCHER/logs/cluster-workers.json"
STATE_FILE="$DISPATCHER/logs/monitor-flag-state.json"
SSH_USER=user
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=5"
KEY="MON_DB_ENABLED"

ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; ANY_FAIL=1; }
info() { echo "  ℹ️  $1"; }
dryp() { echo "  🧪 $1"; }

ANY_FAIL=0
DRY_RUN=0
ROLLBACK=0
VALUE=""
STATE_ENTRIES=()   # 本次執行中「env 值真的被改寫成功」的目標，元素格式 target<TAB>prev<TAB>changedAt
FAILED=()          # 本次執行中仍停在舊值的目標，供結尾摘要用

usage() {
  cat >&2 <<'EOF'
用法：
  set-monitor-flag.sh <0|1> [--dry-run]        統一把 MON_DB_ENABLED 設為 0 或 1
  set-monitor-flag.sh --rollback [--dry-run]   讀 logs/monitor-flag-state.json，把上次改過的目標改回舊值
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    0|1) VALUE="$arg" ;;
    *) echo "未知參數：$arg" >&2; usage; exit 1 ;;
  esac
done

if [ "$ROLLBACK" -eq 0 ] && [ -z "$VALUE" ]; then
  usage
  exit 1
fi
if [ "$ROLLBACK" -eq 1 ] && [ -n "$VALUE" ]; then
  echo "--rollback 模式不接受 <0|1>（改回舊值是從 state 檔讀，不是新設一個值）" >&2
  usage
  exit 1
fi

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---- .env 讀寫（本機用；grep+printf 重組，不用 sed -i / mv，見檔頭說明）----
get_env_value() {
  local file="$1"
  [ -f "$file" ] || return 1
  grep -m1 "^${KEY}=" "$file" 2>/dev/null | cut -d= -f2- | tr -d '\r\n'
}

set_env_value_local() {
  local file="$1" value="$2" tmp line found=0
  tmp="$(mktemp)" || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "${KEY}="* ]]; then
      printf '%s=%s\n' "$KEY" "$value" >>"$tmp"
      found=1
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$file"
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$KEY" "$value" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# ---- worker 端遠端腳本（透過 ssh ... bash -s -- "$value" 送過去執行）----
# $1 = 要寫入的值（0 或 1）；輸出 "REMOTE_OK prev=<舊值|__unset__> kickstart=ok|fail"
# 或 "REMOTE_FAIL <原因>"。改法與本機端同構（grep+printf 重組，cat > 覆寫本檔內容）。
REMOTE_SCRIPT=$(cat <<'REMOTE_EOF'
set -u
VALUE="$1"
KEY="MON_DB_ENABLED"
ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "REMOTE_FAIL .env 不存在（${ENV_FILE}）"
  exit 2
fi
PREV=$(grep -m1 "^${KEY}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r\n')
TMP=$(mktemp) || { echo "REMOTE_FAIL mktemp 失敗"; exit 2; }
FOUND=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" == "${KEY}="* ]]; then
    printf '%s=%s\n' "$KEY" "$VALUE" >>"$TMP"
    FOUND=1
  else
    printf '%s\n' "$line" >>"$TMP"
  fi
done <"$ENV_FILE"
[ "$FOUND" -eq 0 ] && printf '%s=%s\n' "$KEY" "$VALUE" >>"$TMP"
cat "$TMP" >"$ENV_FILE"
rm -f "$TMP"
if launchctl kickstart -k "gui/$(id -u)/com.aladdin.tg-worker-agent" 2>/dev/null; then
  echo "REMOTE_OK prev=${PREV:-__unset__} kickstart=ok"
else
  echo "REMOTE_OK prev=${PREV:-__unset__} kickstart=fail"
fi
REMOTE_EOF
)

# ---- 本機目標（head / tg-monitor）----
# $1=target名 $2=env檔 $3=要寫入的值 $4..=kickstart labels
process_local_target() {
  local target="$1" file="$2" value="$3"; shift 3
  local labels=("$@")

  if [ "$DRY_RUN" -eq 1 ]; then
    dryp "$target: 讀舊值 grep -m1 '^${KEY}=' $file"
    dryp "$target: 重組寫入 ${KEY}=${value}（grep+printf 逐行重組到 tmp，cat > ${file}，不 mv、保留 inode/權限）"
    for l in "${labels[@]}"; do
      dryp "$target: launchctl kickstart -k gui/\$(id -u)/${l}"
    done
    return 0
  fi

  if [ ! -f "$file" ]; then
    bad "${target}：$file 不存在，仍停在舊值"
    FAILED+=("${target}（$file 不存在）")
    return 1
  fi

  local prev kick_fail=0 l
  prev="$(get_env_value "$file")"
  if ! set_env_value_local "$file" "$value"; then
    bad "${target}：改寫 $file 失敗，仍停在舊值"
    FAILED+=("${target}（改寫 .env 失敗）")
    return 1
  fi
  STATE_ENTRIES+=("$target"$'\t'"${prev}"$'\t'"$(now_iso)")

  for l in "${labels[@]}"; do
    if launchctl kickstart -k "gui/$(id -u)/${l}" 2>/dev/null; then
      ok "${target}：kickstart ${l}"
    else
      bad "${target}：kickstart ${l} 失敗"
      kick_fail=1
    fi
  done

  if [ "$kick_fail" -eq 1 ]; then
    FAILED+=("${target}（.env 已改成 ${value}，但至少一個 kickstart 失敗——行程可能仍在跑舊值，手動 launchctl kickstart -k gui/\$(id -u)/<label>）")
    return 1
  fi
  ok "${target}：${KEY} ${prev:-<空>} -> ${value}"
  return 0
}

# ---- 遠端目標（worker，經 ssh）----
# $1=target名（worker:<name>） $2=host $3=要寫入的值
process_remote_target() {
  local target="$1" host="$2" value="$3"

  if [ "$DRY_RUN" -eq 1 ]; then
    dryp "$target ($host): ssh $SSH_OPTS ${SSH_USER}@${host} bash -s -- \"${value}\" <<'REMOTE_SCRIPT'"
    printf '%s\n' "$REMOTE_SCRIPT"
    echo "REMOTE_SCRIPT"
    return 0
  fi

  local out rc prev kick
  out=$(ssh $SSH_OPTS "${SSH_USER}@${host}" bash -s -- "$value" <<<"$REMOTE_SCRIPT" 2>&1)
  rc=$?
  if [ $rc -ne 0 ] || ! printf '%s' "$out" | grep -q '^REMOTE_OK'; then
    local reason
    reason=$(printf '%s\n' "$out" | grep -m1 "REMOTE_FAIL\|Permission denied\|Connection refused\|timed out\|No route" | cut -c1-160)
    bad "${target}：${reason:-ssh 失敗 exit=$rc}，仍停在舊值"
    FAILED+=("${target}（${reason:-ssh 失敗 exit=$rc}）")
    return 1
  fi

  prev=$(printf '%s' "$out" | sed -nE 's/.*prev=([^ ]+).*/\1/p')
  kick=$(printf '%s' "$out" | sed -nE 's/.*kickstart=([a-z]+).*/\1/p')
  [ "$prev" = "__unset__" ] && prev=""
  STATE_ENTRIES+=("$target"$'\t'"${prev}"$'\t'"$(now_iso)")

  if [ "$kick" != "ok" ]; then
    bad "${target}：kickstart com.aladdin.tg-worker-agent 失敗"
    FAILED+=("${target}（.env 已改成 ${value}，但 kickstart 失敗——行程可能仍在跑舊值，需人工 ssh 進去 launchctl kickstart -k）")
    return 1
  fi
  ok "${target}：${KEY} ${prev:-<空>} -> ${value}（${host}）"
  return 0
}

# ---- 名冊 ----
get_workers() {
  [ -f "$ROSTER" ] || return 0
  python3 - "$ROSTER" <<'PY'
import json, sys
from urllib.parse import urlparse
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for w in d.get("workers", []):
    if w.get("disabled"):
        continue
    host = urlparse(w.get("url", "")).hostname or ""
    print(f"{w.get('name','')}\t{host}")
PY
}

lookup_worker_host() {
  local name="$1"
  python3 - "$ROSTER" "$name" <<'PY'
import json, sys
from urllib.parse import urlparse
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for w in d.get("workers", []):
    if w.get("name") == sys.argv[2]:
        print(urlparse(w.get("url", "")).hostname or "")
        break
PY
}

# ---- state 檔 ----
read_state() {
  [ -f "$STATE_FILE" ] || return 0
  python3 - "$STATE_FILE" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = []
for e in d:
    print(f"{e.get('target','')}\t{e.get('prev','')}\t{e.get('changedAt','')}")
PY
}

write_state_file() {
  # stdin: target<TAB>prev<TAB>changedAt，一行一筆。
  # 注意：這裡不能用 `python3 - <<'PY' ... PY`——那樣 heredoc 會佔走 stdin
  # 當 python 腳本原始碼本身，我們自己要餵的 TSV 資料就讀不到了。也不能用
  # `python3 <(cat <<'PY' ...)`——實測這台機器的 bash 對「process substitution
  # 內含 heredoc、heredoc 內文又有 {a,b,c} 這種逗號分隔的大括號」會誤判成
  # brace expansion，把整段指令重複展開成好幾份、資料整個爛掉（heredoc body
  # 不該被展開，但這個組合下確實會被展開，屬於這台 bash 的踩雷組合，避開
  # 比查清楚成因更省事）。改成：heredoc 先寫進一個真正的暫存檔，再用
  # `python3 <暫存腳本> <STATE_FILE>` 正常執行，stdin 留給資料。
  mkdir -p "$DISPATCHER/logs"
  local pyscript
  pyscript="$(mktemp)" || return 1
  cat >"$pyscript" <<'PY'
import json, sys
path = sys.argv[1]
entries = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    parts = line.split("\t")
    if len(parts) != 3:
        continue
    target, prev, changed_at = parts
    entries.append({"target": target, "prev": prev, "changedAt": changed_at})
with open(path, "w") as f:
    json.dump(entries, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  python3 "$pyscript" "$STATE_FILE"
  rm -f "$pyscript"
}

# ==== 主流程 ====
if [ "$ROLLBACK" -eq 0 ]; then
  echo "=== 統一設定 ${KEY}=${VALUE}$( [ "$DRY_RUN" -eq 1 ] && echo ' [dry-run，零副作用]' ) ==="

  process_local_target "head" "$HEAD_ENV" "$VALUE" com.aladdin.tg-dispatch-server com.aladdin.monitor-log-intake
  process_local_target "tg-monitor" "$TGMON_ENV" "$VALUE" com.aladdin.tg-monitor

  while IFS=$'\t' read -r NAME HOST; do
    [ -n "$NAME" ] || continue
    if [ -z "$HOST" ]; then
      bad "worker:${NAME}：名冊 url 解析不出 host，仍停在舊值"
      FAILED+=("worker:${NAME}（名冊 url 解析不出 host）")
      continue
    fi
    process_remote_target "worker:$NAME" "$HOST" "$VALUE"
  done < <(get_workers)

else
  echo "=== --rollback：讀 $STATE_FILE 把已改的目標改回舊值$( [ "$DRY_RUN" -eq 1 ] && echo ' [dry-run，零副作用]' ) ==="

  if [ ! -f "$STATE_FILE" ]; then
    echo "找不到 ${STATE_FILE}，沒有可回滾的紀錄" >&2
    exit 1
  fi

  ORIGINAL_ENTRIES="$(read_state)"
  if [ -z "$ORIGINAL_ENTRIES" ]; then
    echo "state 檔為空，沒有可回滾的紀錄"
    exit 0
  fi

  while IFS=$'\t' read -r TARGET PREV CHANGED_AT; do
    [ -n "$TARGET" ] || continue
    case "$TARGET" in
      head)
        process_local_target "head" "$HEAD_ENV" "$PREV" com.aladdin.tg-dispatch-server com.aladdin.monitor-log-intake
        ;;
      tg-monitor)
        process_local_target "tg-monitor" "$TGMON_ENV" "$PREV" com.aladdin.tg-monitor
        ;;
      worker:*)
        NAME="${TARGET#worker:}"
        HOST="$(lookup_worker_host "$NAME")"
        if [ -z "$HOST" ]; then
          bad "${TARGET}：名冊裡找不到這台（可能已被移除/改名），無法回滾"
          FAILED+=("${TARGET}（名冊裡找不到這台）")
        else
          process_remote_target "$TARGET" "$HOST" "$PREV"
        fi
        ;;
      *)
        bad "${TARGET}：未知目標類型，略過"
        FAILED+=("${TARGET}（未知目標類型）")
        ;;
    esac
  done <<<"$ORIGINAL_ENTRIES"

  if [ "$DRY_RUN" -eq 0 ]; then
    # 成功回滾的目標已進 STATE_ENTRIES（記錄回滾前的值，等於「回滾這個動作」
    # 本身也可再被 --rollback 一次撤銷）；回滾失敗的目標把原始 entry 原樣保留，
    # 以便修好後重跑 --rollback 仍讀得到正確的舊值。
    WRITTEN_TARGETS="$(printf '%s\n' "${STATE_ENTRIES[@]:-}" | cut -f1)"
    while IFS=$'\t' read -r TARGET PREV CHANGED_AT; do
      [ -n "$TARGET" ] || continue
      if ! printf '%s\n' "$WRITTEN_TARGETS" | grep -qxF "$TARGET"; then
        STATE_ENTRIES+=("$TARGET"$'\t'"$PREV"$'\t'"$CHANGED_AT")
      fi
    done <<<"$ORIGINAL_ENTRIES"
  fi
fi

# ---- state 檔落地（僅非 dry-run）----
if [ "$DRY_RUN" -eq 0 ]; then
  if [ "${#STATE_ENTRIES[@]}" -gt 0 ]; then
    printf '%s\n' "${STATE_ENTRIES[@]}" | write_state_file
  else
    write_state_file </dev/null
  fi
fi

# ---- 結尾摘要 ----
echo ""
if [ "$ANY_FAIL" -eq 0 ]; then
  echo "=== 完成：全部目標已套用 ==="
  exit 0
else
  echo "=== 完成，但有目標仍在跑舊值（未自動回滾已改成功的）==="
  for f in "${FAILED[@]}"; do
    echo "  - $f"
  done
  echo "修好後重跑同一條指令即可（冪等），或用 --rollback 把已改的改回舊值。"
  exit 1
fi
