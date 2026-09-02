#!/bin/bash
# sync-tunnels.sh — head 端：把 logs/cluster-workers.json 名冊渲染成每台 enabled
# worker 的 monitor-tunnel launchd job（ensure），並把名冊裡已移除或 disabled 的
# worker 殘留在 ~/Library/LaunchAgents 的既有 job 收掉（teardown）。名冊是唯一
# 驅動來源（plan-db-as-truth v3 §3.2 / MN-C7 / MAJOR-D10(3)）：新 worker 進派工池
# 沒有自動獲得 tunnel job 的話，監控寫入會靜默全部落 spool，不會有任何告警。
#
# 用法：sync-tunnels.sh [--dry-run] [--check] [--roster <path>]
#   --dry-run       印出每一步將執行的動作（渲染 diff 摘要、bootout/bootstrap 或
#                   刪除指令），零副作用，不寫入任何檔案、不呼叫 launchctl。
#   --check         唯讀：驗證每台 enabled worker 都有 plist、且
#                   `launchctl print gui/$(id -u)/<label>` 成功（job 已載入）。
#                   全過 exit 0，否則列出缺的並回非 0。供 doctor-monitor.sh
#                   日後引用。不做任何變更。
#   --roster <path> 指向替代名冊（測試用 fixture），預設
#                   logs/cluster-workers.json（真實名冊）。
#
# 部分失敗語意與 deploy/set-monitor-flag.sh 一致：逐台繼續、不因一台失敗中斷；
# 結束時只要有任一台失敗 → 非 0 退出，並明列失敗機清單。重跑冪等——目標 plist
# 內容與渲染結果相同就跳過，不多做 bootout/bootstrap。
#
# 名冊解析壞掉時的防呆（MJ-E8「seen 為空但快照存在就不 sweep」同型防護）：這裡
# 刻意區分「JSON parse 失敗（含檔案不存在）」與「JSON 有效但零 worker」——前者代表
# 我們根本沒能真的觀察到名冊內容，若這時照樣把它當「空集合」去跑 teardown，會把
# 所有現存 tunnel job 全部誤刪；後者則是名冊本身合法地表示零 worker，這時
# teardown 全部既有 plist 才是正確行為。所以只有前者會直接印原因、exit 1，不做
# 任何 teardown；後者照常執行 teardown 計畫（--dry-run 可先看計畫）。
set -u

ALADDIN="/Users/user/aladdin"
DISPATCHER="$ALADDIN/telegram-dispatcher"
ROSTER="$DISPATCHER/logs/cluster-workers.json"
TEMPLATE="$DISPATCHER/launchd/com.aladdin.monitor-tunnel.plist.tmpl"
# 測試用覆寫（非文件化 CLI 介面）：--dry-run 搭配這個 env var 可把「假想的
# ~/Library/LaunchAgents」指到 /private/tmp 底下的 fixture 目錄，藉此在不碰真實
# LaunchAgents、也不呼叫 launchctl（--dry-run 路徑本來就不呼叫）的前提下驗證
# render/plutil-lint/idempotent-skip/teardown 判斷邏輯。正常操作不設這個 env var。
LAUNCH_AGENTS="${SYNC_TUNNELS_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LABEL_PREFIX="com.aladdin.monitor-tunnel."

DRY_RUN=0
CHECK=0

usage() {
  cat >&2 <<'EOF'
用法：sync-tunnels.sh [--dry-run] [--check] [--roster <path>]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --check) CHECK=1; shift ;;
    --roster) ROSTER="${2:-}"; shift 2 ;;
    *) echo "未知參數：$1" >&2; usage; exit 1 ;;
  esac
done

# ---- 1. 解析名冊：只取 enabled worker 名字 ----
# exit code 2 = python 端判定 JSON parse 失敗（含檔案不存在/不是合法 JSON）；
# 錯誤原因會直接印到 stderr（沿用同一份 stderr，不吃掉）。
get_enabled_workers() {
  python3 - "$ROSTER" <<'PY'
import json, sys

path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception as e:
    print(f"名冊 {path} 解析失敗：{e}", file=sys.stderr)
    sys.exit(2)

if not isinstance(data, dict) or not isinstance(data.get("workers"), list):
    print(f"名冊 {path} 格式不符：頂層需為物件且含 workers 陣列", file=sys.stderr)
    sys.exit(2)

for w in data["workers"]:
    if isinstance(w, dict) and w.get("name") and not w.get("disabled"):
        print(w["name"])
PY
}

ENABLED_RAW="$(get_enabled_workers)"
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "ERROR: 名冊解析失敗，拒絕執行——不做任何 teardown（防止把所有現存 tunnel job 誤刪，見檔頭 MJ-E8 同型防護說明）" >&2
  exit 1
fi

ENABLED=()
while IFS= read -r name; do
  [ -n "$name" ] && ENABLED+=("$name")
done <<<"$ENABLED_RAW"

is_enabled() {
  local target="$1" e
  for e in "${ENABLED[@]:-}"; do
    [ -n "$e" ] && [ "$e" = "$target" ] && return 0
  done
  return 1
}

# ---- 2. --check 模式：唯讀驗證，不做任何變更 ----
run_check() {
  local fail=0 name label plist
  if [ "${#ENABLED[@]}" -eq 0 ]; then
    echo "[N/A] 名冊沒有 enabled worker，無 tunnel job 需檢查"
  fi
  for name in "${ENABLED[@]:-}"; do
    [ -n "$name" ] || continue
    label="${LABEL_PREFIX}${name}"
    plist="$LAUNCH_AGENTS/${label}.plist"
    if [ ! -f "$plist" ]; then
      echo "[MISSING] $name: plist 不存在（${plist}）"
      fail=1
      continue
    fi
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
      echo "[OK] $name"
    else
      echo "[MISSING] $name: job 未載入（launchctl print gui/\$(id -u)/${label} 失敗）"
      fail=1
    fi
  done
  return "$fail"
}

if [ "$CHECK" -eq 1 ]; then
  echo "=== --check：驗證 enabled worker 的 tunnel job（唯讀，零副作用）==="
  run_check
  RC=$?
  echo ""
  if [ "$RC" -eq 0 ]; then
    echo "=== 全部 enabled worker 的 tunnel job 都存在且已載入 ==="
  else
    echo "=== 有 tunnel job 缺失或未載入，見上方 [MISSING] ==="
  fi
  exit "$RC"
fi

# ---- 3. ensure：enabled worker 的 tunnel job ----
render_plist() {
  # $1=worker 名字 $2=輸出檔路徑
  sed "s/__WORKER__/$1/g" "$TEMPLATE" > "$2"
}

ensure_worker() {
  local name="$1" label target tmp
  label="${LABEL_PREFIX}${name}"
  target="$LAUNCH_AGENTS/${label}.plist"
  tmp="$(mktemp "${TMPDIR:-/tmp}/sync-tunnels.XXXXXX")" || { echo "  ❌ $name: mktemp 失敗"; return 1; }
  render_plist "$name" "$tmp"

  if ! plutil -lint "$tmp" >/dev/null 2>&1; then
    echo "  ❌ $name: 渲染後的 plist 未通過 plutil -lint"
    rm -f "$tmp"
    return 1
  fi

  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    echo "  ✅ $name: plist 內容相同，跳過（冪等）"
    rm -f "$tmp"
    return 0
  fi

  mkdir -p "$LAUNCH_AGENTS"
  if ! cp "$tmp" "$target"; then
    echo "  ❌ $name: 寫入 $target 失敗"
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"

  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 # 容忍不存在
  if launchctl bootstrap "gui/$(id -u)" "$target" >/tmp/sync-tunnels-bootstrap.$$ 2>&1; then
    echo "  ✅ $name: plist 已更新 + bootstrap 成功"
    rm -f "/tmp/sync-tunnels-bootstrap.$$"
    return 0
  else
    echo "  ❌ $name: bootstrap 失敗（$(cat "/tmp/sync-tunnels-bootstrap.$$" 2>/dev/null | tr '\n' ' ')）"
    rm -f "/tmp/sync-tunnels-bootstrap.$$"
    return 1
  fi
}

dry_run_ensure_worker() {
  local name="$1" label target tmp
  label="${LABEL_PREFIX}${name}"
  target="$LAUNCH_AGENTS/${label}.plist"
  tmp="$(mktemp "${TMPDIR:-/tmp}/sync-tunnels.XXXXXX")" || { echo "  ❌ $name: mktemp 失敗"; return 1; }
  render_plist "$name" "$tmp"

  if ! plutil -lint "$tmp" >/dev/null 2>&1; then
    echo "  ❌ $name: 渲染後的 plist 未通過 plutil -lint（dry-run 仍視為失敗）"
    rm -f "$tmp"
    return 1
  fi

  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    echo "  🧪 $name: plist 內容相同 → 將跳過（冪等，不會 bootout/bootstrap）"
  elif [ -f "$target" ]; then
    echo "  🧪 $name: 既有 plist 內容不同 → 將寫入 $target"
    echo "  🧪 $name: launchctl bootout gui/\$(id -u)/${label}（容忍不存在）"
    echo "  🧪 $name: launchctl bootstrap gui/\$(id -u) $target"
  else
    echo "  🧪 $name: plist 不存在 → 將新建 $target"
    echo "  🧪 $name: launchctl bootout gui/\$(id -u)/${label}（容忍不存在）"
    echo "  🧪 $name: launchctl bootstrap gui/\$(id -u) $target"
  fi
  rm -f "$tmp"
  return 0
}

# ---- 4. teardown：不在 enabled 名冊裡的既有 tunnel plist ----
list_existing_tunnel_plists() {
  local f
  for f in "$LAUNCH_AGENTS"/${LABEL_PREFIX}*.plist; do
    [ -e "$f" ] || continue
    basename "$f"
  done
}

teardown_worker() {
  local name="$1" label target
  label="${LABEL_PREFIX}${name}"
  target="$LAUNCH_AGENTS/${label}.plist"
  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 # 容忍不存在/已停
  if rm -f "$target"; then
    echo "  ✅ $name: 已 bootout + 刪除 $target"
    return 0
  else
    echo "  ❌ $name: 刪除 $target 失敗"
    return 1
  fi
}

dry_run_teardown_worker() {
  local name="$1" label target
  label="${LABEL_PREFIX}${name}"
  target="$LAUNCH_AGENTS/${label}.plist"
  echo "  🧪 $name: 不在 enabled 名冊（已移除或 disabled）→ 將 launchctl bootout gui/\$(id -u)/${label} + 刪除 $target"
}

# ---- 主流程 ----
ANY_FAIL=0
FAILED=()

echo "=== ensure：enabled worker 的 tunnel job$( [ "$DRY_RUN" -eq 1 ] && echo ' [dry-run，零副作用]' ) ==="
if [ "${#ENABLED[@]}" -eq 0 ]; then
  echo "  （名冊沒有 enabled worker）"
else
  for name in "${ENABLED[@]:-}"; do
    [ -n "$name" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      dry_run_ensure_worker "$name" || { ANY_FAIL=1; FAILED+=("ensure:$name"); }
    else
      ensure_worker "$name" || { ANY_FAIL=1; FAILED+=("ensure:$name"); }
    fi
  done
fi

echo ""
echo "=== teardown：不在 enabled 名冊（已移除或 disabled）的既有 tunnel job$( [ "$DRY_RUN" -eq 1 ] && echo ' [dry-run，零副作用]' ) ==="
EXISTING="$(list_existing_tunnel_plists)"
if [ -z "$EXISTING" ]; then
  echo "  （$LAUNCH_AGENTS 沒有任何 monitor-tunnel plist）"
else
  TEARDOWN_COUNT=0
  while IFS= read -r fname; do
    [ -n "$fname" ] || continue
    name="${fname#"$LABEL_PREFIX"}"
    name="${name%.plist}"
    if is_enabled "$name"; then
      continue
    fi
    TEARDOWN_COUNT=$((TEARDOWN_COUNT + 1))
    if [ "$DRY_RUN" -eq 1 ]; then
      dry_run_teardown_worker "$name"
    else
      teardown_worker "$name" || { ANY_FAIL=1; FAILED+=("teardown:$name"); }
    fi
  done <<<"$EXISTING"
  if [ "$TEARDOWN_COUNT" -eq 0 ]; then
    echo "  （現有 plist 全部仍在 enabled 名冊內，無需 teardown）"
  fi
fi

echo ""
if [ "$ANY_FAIL" -eq 0 ]; then
  echo "=== 完成 ==="
  exit 0
else
  echo "=== 完成，但有失敗機 ==="
  for f in "${FAILED[@]:-}"; do
    [ -n "$f" ] && echo "  - $f"
  done
  echo "重跑同一條指令即可（冪等）。"
  exit 1
fi
