#!/bin/zsh
# T19 外部健康守門員：跟 lib/webhook-server/health-monitor.ts 不同層次——
# health-monitor.ts 跑在 webhook server process「自己裡面」，只能偵測 tunnel
# 斷線，偵測不到 server 自己的 event loop 卡死（若真的卡死，setInterval
# callback 本身也不會觸發，見 health-monitor.ts 檔頭已知範圍缺口註解）。這支
# 腳本是完全獨立的 launchd job（見 com.aladdin.tg-dispatch-watchdog.plist，
# StartInterval 週期執行，不是常駐 process），從外部定期打 /health，能抓到
# 「process 活著但完全沒反應」這種自我不可觀測的故障。
#
# 連續 2 次（見 FAILURE_THRESHOLD）打不到才判定為「掛了」，避免單次瞬間慢
# 請求造成誤報；判定掛了時只在「從健康翻轉成掛掉」那一刻通知＋嘗試自我修復
# 一次（launchctl kickstart -k 強制重啟，跟 KeepAlive 只在 process 真的退出
# 才重啟不同，這個指令能重啟一個卡死但沒退出的 process），不會每次檢查都
# 重複重啟造成重啟迴圈；持續掛著不會重複通知洗版，直到真的恢復才報一次
# 恢復。狀態記在 STATE_FILE，跨每次 launchd 觸發都讀得到（不是常駐記憶體）。
set -u

# 全部支援環境變數覆寫（比照 tg-notify.sh `${VAR:-default}` 既有慣例）——
# 正式使用（launchd StartInterval 觸發）完全不帶任何環境變數、吃預設值；
# 覆寫只給測試用，讓測試能指向假 port／暫存 state 檔／假 notify 腳本，
# 不必碰正式跑著的 8787 服務或真的打 Telegram。
PORT="${WATCHDOG_PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
LOG_DIR="/Users/user/aladdin/telegram-dispatcher/logs"
STATE_FILE="${WATCHDOG_STATE_FILE:-${LOG_DIR}/watchdog-state}"
LOG_FILE="${WATCHDOG_LOG_FILE:-${LOG_DIR}/health-watchdog.log}"
TG_NOTIFY_SH="${WATCHDOG_TG_NOTIFY_SH:-/Users/user/aladdin/scripts/tg-notify.sh}"
# 見 lib/notify/operator.ts 的 OPERATOR_CHAT_ID——這是唯一來源，這裡的值
# 必須跟那裡保持一致（跨 TS/shell 語言邊界沒有共用模組機制，只能手動同步）。
OPERATOR_CHAT_ID="5022865804"
SERVICE_LABEL="${WATCHDOG_SERVICE_LABEL:-com.aladdin.tg-dispatch-server}"
FAILURE_THRESHOLD=2
CURL_MAX_TIME=5

mkdir -p "$LOG_DIR"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"; }

# 讀先前狀態：STATE_FILE 不存在（第一次跑）視為「健康、0 次連續失敗」，
# 避免服務其實正常時，watchdog 剛裝上去就因為沒有歷史記錄而誤報。
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

if curl -sf --max-time "$CURL_MAX_TIME" "$HEALTH_URL" > /dev/null 2>&1; then
  if [ "$PRIOR_STATE" = "down" ]; then
    log "恢復：$HEALTH_URL 重新有回應"
    notify "✅ [dispatcher watchdog] webhook server 恢復回應（$HEALTH_URL）"
  fi
  write_state "healthy" 0
  exit 0
fi

FAILURES=$((PRIOR_FAILURES + 1))
log "打不到 $HEALTH_URL（連續第 $FAILURES 次，門檻 $FAILURE_THRESHOLD）"

if [ "$FAILURES" -lt "$FAILURE_THRESHOLD" ]; then
  # 還沒到門檻：維持原本的 state（通常是 healthy），只累加失敗次數，不通知、
  # 不重啟——避免單次瞬間慢請求（例如剛好卡在一次 400-700ms 的 Notion 查詢）
  # 被誤判成掛掉。
  write_state "$PRIOR_STATE" "$FAILURES"
  exit 0
fi

if [ "$PRIOR_STATE" != "down" ]; then
  log "判定掛掉：連續 $FAILURES 次打不到，嘗試 launchctl kickstart -k 強制重啟並通知 Landon"
  notify "🚨 [dispatcher watchdog] webhook server 連續 $FAILURES 次打不到 $HEALTH_URL，判定卡死或已掛掉，正在嘗試自動重啟（launchctl kickstart -k）。若重啟後仍持續掛著，watchdog 不會重複通知，請直接檢查 launchd-server.err.log。"
  if [ -n "${WATCHDOG_KICKSTART_CMD:-}" ]; then
    eval "$WATCHDOG_KICKSTART_CMD" >> "$LOG_FILE" 2>&1   # 測試用替身，見上方環境變數說明
  else
    launchctl kickstart -k "gui/$(id -u)/${SERVICE_LABEL}" >> "$LOG_FILE" 2>&1
  fi
else
  log "持續掛著（連續 $FAILURES 次），已通知過，不重複通知/不重複重啟"
fi

write_state "down" "$FAILURES"
exit 0
