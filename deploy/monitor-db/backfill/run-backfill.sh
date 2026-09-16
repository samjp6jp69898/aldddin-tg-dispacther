#!/bin/zsh
# run-backfill.sh — Phase 6 歷史回填的統一入口（plan §11.2）。
#
# ⚠️ 正式執行（不帶 --dry-run、不帶 --schema）只能在指揮官宣告 Phase 6 時點後進行。
#    開發/測試期一律 --dry-run，或 --schema pipeline_monitor_backfill_test（先跑
#    bash test-schema.sh create）。
#
# 用法：
#   bash run-backfill.sh --dry-run                  # 三個來源全部 dry-run（安全，隨時可跑）
#   bash run-backfill.sh --schema <測試schema>       # 寫入臨時測試 schema
#   bash run-backfill.sh                            # 正式回填（Phase 6 時點）
# 可加 --only sqlite|rosters|logs 只跑單一來源。
#
# 冪等：三支腳本都可重跑（INSERT IGNORE / NOT EXISTS 守衛 / manifest），重跑時
# inserted=0、ignored=全數是預期結果。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd /Users/user/aladdin/telegram-dispatcher

ONLY=""
DRY_RUN=0
ACK_EVENTS_PRECHECK=0
SCHEMA_ARGS=()
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --ack-events-precheck) ACK_EVENTS_PRECHECK=1; shift ;;
    --dry-run) DRY_RUN=1; PASS_ARGS+=("$1"); shift ;;
    --schema) SCHEMA_ARGS=(--schema "$2"); PASS_ARGS+=("$1" "$2"); shift 2 ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done

# ── events 去重前提探針（README「Phase 6 執行前置」第 3 條；review-final-A 指認
# 「README 寫必跑但腳本沒接」後補上的阻斷閘門）──
# 只在真寫入（非 --dry-run）且 sqlite 來源會跑時把關。exit 語意：
#   0 ＝ would-insert=0，直接放行
#   2 ＝ would-insert>0，探針已印逐筆明細——操作者逐筆判讀後以 --ack-events-precheck 重跑放行
#   其他（含 1）＝ 探針自身失敗＝「未評估」，依 D42 視同不通過，一律中止，不得當成沒問題
# PRECHECK_CMD 僅供測試 stub（比照 tg-map-chatids.sh 的 TG_REGISTRY_CLI 慣例）。
if [ "$DRY_RUN" -eq 0 ] && { [ -z "$ONLY" ] || [ "$ONLY" = "sqlite" ]; }; then
  echo "=== 前置：events 去重前提探針（precheck-events-dedup --gate）==="
  PRECHECK="${PRECHECK_CMD:-bun $DIR/precheck-events-dedup.ts}"
  set +e
  # ${=PRECHECK}：zsh 預設不做字詞分割，含空白的預設值（bun <路徑>）會被當成
  # 單一指令名而 127。＝旗標顯式分割（本檔 shebang 是 zsh）。踩坑記錄：stub 測試
  # 全是無空白單一路徑所以沒抓到——替身比真物寬鬆的實例。
  ${=PRECHECK} --gate ${SCHEMA_ARGS[@]+"${SCHEMA_ARGS[@]}"}
  rc=$?
  set -e
  if [ "$rc" -eq 2 ]; then
    if [ "$ACK_EVENTS_PRECHECK" -eq 1 ]; then
      echo "=== 前置：would-insert 非零，操作者已以 --ack-events-precheck 確認逐筆判讀，放行 ==="
    else
      echo "=== 中止：would-insert 非零（明細見上）。逐筆判讀無誤後加 --ack-events-precheck 重跑 ===" >&2
      exit 1
    fi
  elif [ "$rc" -ne 0 ]; then
    echo "=== 中止：探針未評估（exit ${rc}）——未評估不等於沒問題（D42），排除故障後重跑 ===" >&2
    exit 1
  fi
  echo
fi

run_one() {
  local name="$1" script="$2"
  echo "=== backfill: $name ==="
  bun "$DIR/$script" "${PASS_ARGS[@]}"
  echo
}

[ -z "$ONLY" ] || [ "$ONLY" = "sqlite" ]  && run_one "monitor.sqlite → runs/agent_runs/mcp_usage/service_status_log" backfill-sqlite.ts
[ -z "$ONLY" ] || [ "$ONLY" = "rosters" ] && run_one "tokens*.json / unknown-senders.jsonl → 名冊兩表" backfill-rosters.ts
[ -z "$ONLY" ] || [ "$ONLY" = "logs" ]    && run_one "舊 log → VictoriaLogs（best-effort）" backfill-logs-vl.ts

echo "=== 回填完成（各來源對數見上方 BACKFILL_REPORT_JSON 行） ==="
