#!/bin/bash
# tasks.sh — telegram-dispatcher/tasks.json 的行級操作，風格比照 scripts/tracker.sh
#
# 這是 telegram-dispatcher 專案自己的任務追蹤檔（跨 session/跨 agent 迭代用），
# 跟 aladdin 主線的 bug_analysis_tracker.md 完全無關，不要混用。
#
# 用法：
#   bash telegram-dispatcher/tasks.sh next              # 印出下一個可做的 task（todo 且所有 depends_on 都 done）
#   bash telegram-dispatcher/tasks.sh show T11           # 印該 task 完整內容
#   bash telegram-dispatcher/tasks.sh list [狀態]        # 列出所有 task（可選：只列某狀態），依 id 排序
#   bash telegram-dispatcher/tasks.sh set T11 in_progress   # 更新狀態
#   bash telegram-dispatcher/tasks.sh set T11 done
#   bash telegram-dispatcher/tasks.sh validate           # 檢查重複 id / 非法 status·module / 懸空依賴
#
# 合法狀態：todo in_progress blocked done deferred
set -u
FILE="${TASKS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tasks.json}"
LOCKDIR="/tmp/telegram-dispatcher-tasks-lock"
ACTION="${1:-}"

[ -f "$FILE" ] || { echo "ERROR: 找不到 $FILE"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: 需要 jq"; exit 1; }

validate_file() {
  local f="$1"
  jq -e '.' "$f" >/dev/null 2>&1 || { echo "ERROR: 不是合法 JSON"; return 1; }

  local dup bad_status bad_module unresolved
  dup=$(jq -r '[.tasks[].id] | group_by(.) | map(select(length>1)) | flatten | unique | .[]' "$f")
  [ -n "$dup" ] && { echo "ERROR: 重複 id: $dup"; return 1; }

  bad_status=$(jq -r '
    ["todo","in_progress","blocked","done","deferred"] as $ok
    | .tasks[] | select(.status as $s | ($ok | index($s)) | not) | .id' "$f")
  [ -n "$bad_status" ] && { echo "ERROR: 非法 status: $bad_status"; return 1; }

  bad_module=$(jq -r '
    .modules as $mods
    | .tasks[] | select(.module as $m | ($mods | index($m)) | not) | .id' "$f")
  [ -n "$bad_module" ] && { echo "ERROR: 非法 module: $bad_module"; return 1; }

  unresolved=$(jq -r '
    [.tasks[].id] as $ids
    | .tasks[] | .id as $tid | (.depends_on // [])[]
    | select(. as $d | ($ids | index($d)) | not)
    | "\($tid) -> \(.)"' "$f")
  [ -n "$unresolved" ] && { echo "ERROR: 懸空依賴: $unresolved"; return 1; }

  return 0
}

case "$ACTION" in
  next)
    # todo 且所有 depends_on 狀態都是 done（deferred 不視為滿足，需要人工判斷才升級）
    result=$(jq -r '
      ([.tasks[] | {key: .id, value: .status}] | from_entries) as $status_by_id
      | [.tasks[]
         | select(.status == "todo")
         | select(
             (.depends_on // []) | all(. as $d | $status_by_id[$d] == "done")
           )]
      | sort_by(.id | ltrimstr("T") | tonumber)
      | .[0]
    ' "$FILE")
    if [ "$result" = "null" ] || [ -z "$result" ]; then
      echo "NO_CLAIMABLE：沒有可做的 task（要嘛全部完成，要嘛剩下的都卡在還沒 done 的依賴上，用 'list blocked-view' 概念自行 show 依賴檢查）"
      exit 1
    fi
    echo "$result" | jq .
    ;;

  show)
    T="${2:?用法: tasks.sh show T11}"
    result=$(jq --arg id "$T" '.tasks[] | select(.id == $id)' "$FILE")
    [ -z "$result" ] && { echo "NOT_FOUND: $T"; exit 1; }
    echo "$result"
    ;;

  list)
    FILTER="${2:-}"
    if [ -n "$FILTER" ]; then
      jq -r --arg s "$FILTER" '
        .tasks[] | select(.status == $s)
        | "\(.id)\t\(.status)\t\(.module)\t\(.title)"' "$FILE"
    else
      jq -r '.tasks[] | "\(.id)\t\(.status)\t\(.module)\t\(.title)"' "$FILE"
    fi
    ;;

  set)
    T="${2:?用法: tasks.sh set T11 <狀態>}"
    ST="${3:?缺狀態}"
    case "$ST" in todo|in_progress|blocked|done|deferred) ;; *) echo "ERROR: 非法狀態 $ST"; exit 1;; esac

    jq -e --arg id "$T" '.tasks[] | select(.id == $id)' "$FILE" >/dev/null 2>&1
    [ $? -ne 0 ] && { echo "NOT_FOUND: $T"; exit 1; }

    mkdir -p "$(dirname "$LOCKDIR")"
    n=0
    until mkdir "$LOCKDIR" 2>/dev/null; do
      n=$((n+1)); [ "$n" -gt 50 ] && { echo "ERROR: tasks.json 鎖等待逾時（$LOCKDIR 疑似殘留，確認無人在寫後可 rmdir）"; exit 1; }
      sleep 0.1
    done
    trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

    TODAY="$(date '+%Y-%m-%d')"
    tmp=$(mktemp)
    jq --arg id "$T" --arg st "$ST" --arg d "$TODAY" '
      (.tasks[] | select(.id == $id) | .status) = $st
      | .updated_at = $d
    ' "$FILE" > "$tmp" && mv "$tmp" "$FILE"

    echo "SET: $T -> $ST"
    jq --arg id "$T" '.tasks[] | select(.id == $id) | {id, status, title}' "$FILE"
    ;;

  validate)
    if validate_file "$FILE"; then
      echo "OK: $(jq '.tasks | length' "$FILE") tasks，通過檢查（重複 id / status / module / 懸空依賴）"
    else
      exit 1
    fi
    ;;

  *)
    echo "用法：tasks.sh {next|show|list|set|validate} [args]（詳見檔頭註解）"; exit 1
    ;;
esac
