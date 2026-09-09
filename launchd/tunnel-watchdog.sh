#!/bin/zsh
# tunnel-watchdog.sh — head 端外部健康守門員：定期檢查對某台 worker 的反向
# SSH tunnel（com.aladdin.monitor-tunnel.<worker>）是否卡死，卡死就自動
# `launchctl kickstart -k` 重啟一次。
#
# 背景（2026-09-09，ALDREQ-812 事故根因）：這條 tunnel 曾經在一次網路短斷
# （worker 掉線）後「表面上重連成功」但實際上半死——SSH 的 TCP port 還在
# accept（`nc` 秒連成功），但透過它的 MySQL 查詢會卡住/逾時，導致 worker 上
# 所有監控 DB 寫入（含 heartbeat 自己）持續失敗、落 spool 且沒有任何東西會
# 主動重放。這種狀態不會讓 launchd 的 KeepAlive 出手（process 沒退出，只是
# 卡住），需要外部主動偵測才抓得到，跟 health-watchdog.sh（T19）補
# webhook server event loop 卡死的缺口是同一種思路。
#
# 偵測手法：不從 worker 端量測（worker 自己卡在同一條壞掉的 tunnel 上，量不
# 出來），改從 head 端讀 `monitor_heartbeat`——worker 每 60 秒該寫一次心跳，
# head 讀這張表走的是本機直連（不經任何 tunnel），今天實測穩定。心跳新鮮就
# 代表 tunnel 通；心跳過期就代表 tunnel 卡死（見
# lib/monitor-db/check-worker-heartbeat.ts 檔頭的因果關係說明）。
#
# 跟 health-watchdog.sh 同一套慣例：連續 N 次都判定過期才動手（避免單次瞬間
# 慢查詢誤報）、翻轉那一刻才通知＋重啟一次（不會每次都重啟造成迴圈）、狀態
# 記在 STATE_FILE 跨每次 launchd 觸發都讀得到。
#
# 用法：tunnel-watchdog.sh <worker-name>
set -u

WORKER="${1:-}"
if [ -z "$WORKER" ]; then
  echo "用法：tunnel-watchdog.sh <worker-name>" >&2
  exit 1
fi

DISPATCHER_DIR="/Users/user/aladdin/telegram-dispatcher"
LOG_DIR="${DISPATCHER_DIR}/logs"
BUN="/Users/user/.bun/bin/bun"
CHECK_TS="${DISPATCHER_DIR}/lib/monitor-db/check-worker-heartbeat.ts"
STATE_FILE="${WATCHDOG_STATE_FILE:-${LOG_DIR}/watchdog-state.tunnel.${WORKER}}"
LOG_FILE="${WATCHDOG_LOG_FILE:-${LOG_DIR}/tunnel-watchdog.${WORKER}.log}"
TG_NOTIFY_SH="${WATCHDOG_TG_NOTIFY_SH:-/Users/user/aladdin/scripts/tg-notify.sh}"
# 見 lib/notify/operator.ts 的 OPERATOR_CHAT_ID——這是唯一來源，這裡的值
# 必須跟那裡保持一致（跨 TS/shell 語言邊界沒有共用模組機制，只能手動同步）。
OPERATOR_CHAT_ID="5022865804"
SERVICE_LABEL="${WATCHDOG_SERVICE_LABEL:-com.aladdin.monitor-tunnel.${WORKER}}"
# 心跳每 60 秒一拍（MONITOR_HEARTBEAT_TICK_MS，heartbeat.ts）。180 秒＝允許
# 漏跳 2 拍（單次慢查詢、GC 停頓等）才判定「這一輪過期」，跟 FAILURE_THRESHOLD
# 疊加起來才是真正的偵測窗口，避免單一漏拍就誤判。
STALE_THRESHOLD_SECONDS=180
FAILURE_THRESHOLD=2

mkdir -p "$LOG_DIR"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"; }

PRIOR_STATE="healthy"
PRIOR_FAILURES=0
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  PRIOR_STATE="${state:-healthy}"
  PRIOR_FAILURES="${consecutive_failures:-0}"
fi

write_state() {
  echo "state=$1" > "$STATE_FILE"
  echo "consecutive_failures=$2" >> "$STATE_FILE"
}

notify() {
  bash "$TG_NOTIFY_SH" --chat-id "$OPERATOR_CHAT_ID" --text "$1" > /dev/null 2>&1
}

# 測試用替身：整條檢查指令可覆寫成回聲假輸出（比照 WATCHDOG_KICKSTART_CMD），
# 不必真的連真的 DB 就能驗證 AGE_SECONDS/DB_ERROR/NO_ROW 三條分支各自的行為。
if [ -n "${WATCHDOG_CHECK_CMD:-}" ]; then
  RESULT="$(eval "$WATCHDOG_CHECK_CMD" 2>>"$LOG_FILE")"
else
  RESULT="$(cd "$DISPATCHER_DIR" && "$BUN" "$CHECK_TS" "$WORKER" 2>>"$LOG_FILE")"
fi
KIND="${RESULT%% *}"
VALUE="${RESULT#* }"

if [ "$KIND" = "DB_ERROR" ]; then
  # head 自己查詢就失敗——不是 tunnel 的證據（可能是 head 本機 mon-mysql 有
  # 問題，那是另一個故障面，不該被這支 watchdog 拿來重啟 worker 的 tunnel）。
  # 維持原本 state，不累加失敗、不通知、不重啟，只記 log 供事後查。
  log "查詢失敗（不當作 tunnel 證據，維持原狀 $PRIOR_STATE）：$RESULT"
  write_state "$PRIOR_STATE" "$PRIOR_FAILURES"
  exit 0
fi

if [ "$KIND" = "NO_ROW" ]; then
  # 這台 worker 從沒寫過心跳（可能還在部署、或 MON_DB_ENABLED 尚未開）——
  # 跟「查得到但過期」是不同情境，同樣不猜、不動作。
  log "worker '$WORKER' 尚無任何 heartbeat 紀錄，略過本輪判定"
  write_state "$PRIOR_STATE" "$PRIOR_FAILURES"
  exit 0
fi

if [ "$KIND" != "AGE_SECONDS" ]; then
  log "check-worker-heartbeat.ts 回傳非預期格式，視同查詢失敗：$RESULT"
  write_state "$PRIOR_STATE" "$PRIOR_FAILURES"
  exit 0
fi

if [ "$VALUE" -lt "$STALE_THRESHOLD_SECONDS" ]; then
  if [ "$PRIOR_STATE" = "down" ]; then
    log "恢復：worker '$WORKER' heartbeat 重新新鮮（${VALUE}s）"
    notify "✅ [tunnel watchdog] worker ${WORKER} 的 monitor DB tunnel 恢復正常（heartbeat ${VALUE}s 前）"
  fi
  write_state "healthy" 0
  exit 0
fi

FAILURES=$((PRIOR_FAILURES + 1))
log "worker '$WORKER' heartbeat 已過期 ${VALUE}s（門檻 ${STALE_THRESHOLD_SECONDS}s，連續第 $FAILURES 次，閾值 $FAILURE_THRESHOLD）"

if [ "$FAILURES" -lt "$FAILURE_THRESHOLD" ]; then
  write_state "$PRIOR_STATE" "$FAILURES"
  exit 0
fi

if [ "$PRIOR_STATE" != "down" ]; then
  log "判定 tunnel 卡死：連續 $FAILURES 次過期，嘗試 launchctl kickstart -k 強制重啟並通知 Landon"
  notify "🚨 [tunnel watchdog] worker ${WORKER} 的 monitor DB heartbeat 已 ${VALUE}s 沒更新，判定反向 tunnel 卡死，正在嘗試自動重啟（launchctl kickstart -k ${SERVICE_LABEL}）。若重啟後仍持續掛著，watchdog 不會重複通知，請直接檢查 launchd-worker-agent.err.log 與 monitor-tunnel.${WORKER}.log。"
  if [ -n "${WATCHDOG_KICKSTART_CMD:-}" ]; then
    eval "$WATCHDOG_KICKSTART_CMD" >> "$LOG_FILE" 2>&1   # 測試用替身，見上方環境變數說明
  else
    launchctl kickstart -k "gui/$(id -u)/${SERVICE_LABEL}" >> "$LOG_FILE" 2>&1
  fi
else
  log "持續卡死（連續 $FAILURES 次），已通知過，不重複通知/不重複重啟"
fi

write_state "down" "$FAILURES"
exit 0
