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
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done

run_one() {
  local name="$1" script="$2"
  echo "=== backfill: $name ==="
  bun "$DIR/$script" "${PASS_ARGS[@]}"
  echo
}

[ -z "$ONLY" ] || [ "$ONLY" = "sqlite" ]  && run_one "monitor.sqlite → runs/agent_runs/mcp_usage/service_status_log" backfill-sqlite.ts
[ -z "$ONLY" ] || [ "$ONLY" = "rosters" ] && run_one "tech-users.csv / tokens*.json / unknown-senders.jsonl → 名冊三表" backfill-rosters.ts
[ -z "$ONLY" ] || [ "$ONLY" = "logs" ]    && run_one "舊 log → VictoriaLogs（best-effort）" backfill-logs-vl.ts

echo "=== 回填完成（各來源對數見上方 BACKFILL_REPORT_JSON 行） ==="
