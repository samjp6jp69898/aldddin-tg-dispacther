#!/bin/bash
# Phase 0 監控基礎設施健康檢查（head only）。
# 見 plan-db-as-truth-v3.md §9 Phase 0 步驟 8、plan-db-as-truth-v3.2.md
# §3.3(b2)（BL-G1）、裁定2（MN-G4）、裁定3（BL-E3 負向驗收）。
#
# 每一項印 [OK] / [WARN] / [ERROR] / [N/A-Phase<n>]（尚未到達的階段性項目）。
# 不做任何寫入，純檢查。
set -uo pipefail

ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"
SECRETS_DIR="$HOME/.aladdin-secrets/monitor-db"
CONTAINER=mon-mysql
ERRORS=0
WARNS=0

ok()    { echo "[OK]    $1"; }
warn()  { echo "[WARN]  $1"; WARNS=$((WARNS+1)); }
err()   { echo "[ERROR] $1"; ERRORS=$((ERRORS+1)); }
napb()  { echo "[N/A-Phase$1] $2"; }

echo "=== 1. mon-mysql 容器健康 ==="
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  STATUS=$(docker inspect "$CONTAINER" --format '{{.State.Status}}')
  if [ "$STATUS" = "running" ]; then
    ROOT_PW=$(grep '^MON_DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
    if docker exec -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysqladmin ping -uroot --silent >/dev/null 2>&1; then
      ok "mon-mysql running 且可 ping"
    else
      err "mon-mysql running 但 mysqladmin ping 失敗"
    fi
  else
    err "mon-mysql 容器狀態異常: $STATUS"
  fi
else
  err "mon-mysql 容器不存在"
fi

echo ""
echo "=== 2. publish 位址必須只有 127.0.0.1 ==="
PORTMAP=$(docker inspect "$CONTAINER" --format '{{range $p,$c := .NetworkSettings.Ports}}{{range $c}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' 2>/dev/null)
if echo "$PORTMAP" | grep -qE '(^|[[:space:]])0\.0\.0\.0:|(^|[[:space:]])::'; then
  err "mon-mysql publish 位址含對外綁定: $PORTMAP"
elif echo "$PORTMAP" | grep -q '127.0.0.1:3307'; then
  ok "mon-mysql 只 publish 127.0.0.1:3307 ($PORTMAP)"
else
  err "mon-mysql publish 位址不符預期: $PORTMAP"
fi

echo ""
echo "=== 3. 三條帳號驗收（§2.3）+ 裁定3 欄位級負向驗收 ==="
if [ -f "$SECRETS_DIR/mon_head.env" ] && [ -f "$SECRETS_DIR/mon_ui.env" ] && [ -f "$SECRETS_DIR/mon_exec.env" ]; then
  MON_HEAD_PW=$(grep '^PASSWORD=' "$SECRETS_DIR/mon_head.env" | cut -d= -f2-)
  MON_UI_PW=$(grep '^PASSWORD=' "$SECRETS_DIR/mon_ui.env" | cut -d= -f2-)
  MON_EXEC_PW=$(grep '^PASSWORD=' "$SECRETS_DIR/mon_exec.env" | cut -d= -f2-)

  if mysql -h127.0.0.1 -P3307 -umon_head -p"$MON_HEAD_PW" -e "SELECT 1;" >/dev/null 2>&1; then
    ok "mon_head 連線成功"
  else
    err "mon_head 連線失敗"
  fi
  if mysql -h127.0.0.1 -P3307 -umon_ui -p"$MON_UI_PW" -e "SELECT 1;" >/dev/null 2>&1; then
    ok "mon_ui 連線成功"
  else
    err "mon_ui 連線失敗"
  fi
  OUT=$(mysql -h127.0.0.1 -P3307 -umon_exec -p"$MON_EXEC_PW" -e "SELECT 1 FROM pipeline_monitor.mcp_tokens LIMIT 1;" 2>&1)
  if echo "$OUT" | grep -q "ERROR 1142"; then
    ok "mon_exec 讀 mcp_tokens 正確被拒 (ERROR 1142)"
  else
    err "mon_exec 讀 mcp_tokens 未被正確拒絕: $OUT"
  fi
  OUT=$(mysql -h127.0.0.1 -P3307 -umon_ui -p"$MON_UI_PW" -e \
    "INSERT INTO pipeline_monitor.runs (run_id,host,ticket,kind,outcome,outcome_tier) VALUES ('doctor-probe','x','FAQ-0','bug','success',2);" 2>&1)
  if echo "$OUT" | grep -q "ERROR 1143"; then
    ok "mon_ui 無法 INSERT outcome/outcome_tier (ERROR 1143)"
  else
    err "mon_ui 欄位級 INSERT 權限未正確限制: $OUT"
  fi
  OUT=$(mysql -h127.0.0.1 -P3307 -umon_ui -p"$MON_UI_PW" -e \
    "UPDATE pipeline_monitor.runs SET outcome_tier=2 WHERE run_id='doctor-probe';" 2>&1)
  if echo "$OUT" | grep -q "ERROR 1143"; then
    ok "mon_ui 無法 UPDATE outcome_tier (ERROR 1143)"
  else
    err "mon_ui 欄位級 UPDATE 權限未正確限制: $OUT"
  fi
else
  err "找不到 $SECRETS_DIR 內的帳號密碼檔"
fi

echo ""
echo "=== 4. outcome_tier CHECK 約束存在性（MN-G4：縱深冗餘標記） ==="
if [ -n "${ROOT_PW:-}" ]; then
  CHK=$(docker exec -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysql -uroot -N -B pipeline_monitor -e \
    "SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='pipeline_monitor' AND CONSTRAINT_NAME IN ('chk_outcome_tier','chk_outcome_tier_pair');" 2>&1)
  COUNT=$(echo "$CHK" | grep -c . || true)
  if [ "$COUNT" -eq 2 ]; then
    ok "chk_outcome_tier / chk_outcome_tier_pair 均存在 [redundant-if-check-alive]"
  else
    warn "CHECK 約束缺失（找到 $COUNT/2）——§11.2 的雙向驗收此時才是唯一偵測器"
  fi
fi

echo ""
echo "=== 5. VictoriaLogs（§7.1） ==="
VL_PID=$(launchctl list | awk '$3=="com.aladdin.victorialogs"{print $1}')
if [ -n "$VL_PID" ] && [ "$VL_PID" != "-" ]; then
  ARGV=$(ps -p "$VL_PID" -o command= 2>/dev/null)
  if echo "$ARGV" | grep -qE '(MON_VL_PASSWORD|httpAuth_password=)'; then
    err "victorialogs argv 疑似含密碼: 需人工確認"
  else
    ok "victorialogs 行程 argv 不含密碼"
  fi
  UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:9428/select/logsql/query?query=%2A")
  [ "$UNAUTH" = "401" ] && ok "無憑證查詢正確回 401" || err "無憑證查詢回 ${UNAUTH}（預期 401）"
  MON_VL_USER=$(grep '^MON_VL_USER=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
  MON_VL_PASSWORD=$(grep '^MON_VL_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
  AUTHED=$(curl -s -o /dev/null -w '%{http_code}' -u "${MON_VL_USER}:${MON_VL_PASSWORD}" "http://127.0.0.1:9428/select/logsql/query?query=%2A")
  [ "$AUTHED" = "200" ] && ok "帶憑證查詢正確回 200" || err "帶憑證查詢回 ${AUTHED}（預期 200）"
  echo "$ARGV" | grep -q 'retentionPeriod=90d' && ok "retentionPeriod=90d" || err "retentionPeriod 不是 90d"
  echo "$ARGV" | grep -q 'insert.maxLineSizeBytes=2MB' && ok "insert.maxLineSizeBytes=2MB" || err "maxLineSizeBytes 不是 2MB"
else
  err "com.aladdin.victorialogs 未在跑"
fi
PIN=$(brew list --pinned 2>/dev/null | grep -x victorialogs || true)
[ -n "$PIN" ] && ok "victorialogs 已 brew pin" || warn "victorialogs 未 pin，之後 brew upgrade 可能悄悄升版"

echo ""
echo "=== 6. monitor-log-intake（9429，BL-G1 三條身分驗證） ==="
LI_PID=$(launchctl list | awk '$3=="com.aladdin.monitor-log-intake"{print $1}')
LISTEN_PID=$(lsof -nP -iTCP:9429 -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$LI_PID" ] && [ "$LI_PID" != "-" ]; then
  BINDADDR=$(lsof -nP -iTCP:9429 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $9}')
  echo "$BINDADDR" | grep -q '^127.0.0.1:' && ok "9429 綁定 127.0.0.1 ($BINDADDR)" || err "9429 綁定位址不符: $BINDADDR"
  [ "$LI_PID" = "$LISTEN_PID" ] && ok "9429 監聽者 pid ($LISTEN_PID) 屬於 com.aladdin.monitor-log-intake" || err "9429 監聽者 pid 不符 (launchd=$LI_PID listen=$LISTEN_PID)"
  SECRET=$(grep '^CLUSTER_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
  NONCE=$(openssl rand -hex 16)
  RESP=$(curl -s -H "x-cluster-token: ${SECRET}" "http://127.0.0.1:9429/cluster/intake-identity?nonce=${NONCE}")
  EXPECTED_SIG=$(printf '%s:%s' "$NONCE" "com.aladdin.monitor-log-intake" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
  if echo "$RESP" | grep -q "\"sig\":\"${EXPECTED_SIG}\"" && echo "$RESP" | grep -q "\"identity\":\"com.aladdin.monitor-log-intake\""; then
    ok "簽名身分驗證通過"
  else
    err "簽名身分驗證失敗: $RESP"
  fi
else
  err "com.aladdin.monitor-log-intake 未在跑"
fi

echo ""
echo "=== 7. 四支 wrapper 的 MON_* 白名單（run-server.sh 不得含 MON_VL_*） ==="
DISPATCHER="/Users/user/aladdin/telegram-dispatcher"
grep -q 'MON_DB_ENABLED' "$DISPATCHER/launchd/run-server.sh" && ok "run-server.sh 含 MON_DB_ENABLED" || err "run-server.sh 缺 MON_DB_ENABLED"
if grep -qE 'MON_VL_(URL|USER|PASSWORD)' "$DISPATCHER/launchd/run-server.sh"; then
  err "run-server.sh 不應含 MON_VL_* (§9 修訂)"
else
  ok "run-server.sh 未含 MON_VL_*"
fi
grep -q 'MON_DB_ENABLED' "$DISPATCHER/launchd/run-worker-agent.sh" && ok "run-worker-agent.sh 含 MON_DB_ENABLED" || err "run-worker-agent.sh 缺 MON_DB_ENABLED"
if grep -qE 'MON_VL_URL' "$DISPATCHER/launchd/run-log-intake.sh" && grep -qE 'MON_VL_USER' "$DISPATCHER/launchd/run-log-intake.sh" && grep -qE 'MON_VL_PASSWORD' "$DISPATCHER/launchd/run-log-intake.sh"; then
  ok "run-log-intake.sh 含三個 MON_VL_* key"
else
  err "run-log-intake.sh 缺 MON_VL_* key"
fi
TGMON="/Users/user/aladdin/tg-monitor"
if [ -f "$TGMON/.env" ] && [ -f "$TGMON/.env.example" ] && grep -q 'MON_DB_ENABLED' "$TGMON/launchd/run-monitor.sh"; then
  ok "tg-monitor .env/.env.example/run-monitor.sh 白名單齊備（MAJOR-F7 v3.2 第 0 步已由指揮官解除，ee0391f）"
  PERM=$(stat -f%Lp "$TGMON/.env" 2>/dev/null || stat -c%a "$TGMON/.env" 2>/dev/null)
  [ "$PERM" = "600" ] && ok "tg-monitor/.env 權限 600" || err "tg-monitor/.env 權限不是 600（現值 ${PERM}）"
  if [ -f "$SECRETS_DIR/mon_ui.env" ]; then
    MON_UI_PW=$(grep '^PASSWORD=' "$SECRETS_DIR/mon_ui.env" | cut -d= -f2-)
    ENV_MON_UI_PW=$(grep '^MON_DB_PASSWORD=' "$TGMON/.env" | cut -d= -f2- | tr -d '\r\n')
    [ "$MON_UI_PW" = "$ENV_MON_UI_PW" ] && ok "tg-monitor/.env 的 MON_DB_PASSWORD 與 mon_ui 密碼一致" || err "tg-monitor/.env 的 MON_DB_PASSWORD 與 mon_ui 密碼不一致"
  fi
  TGMON_PID=$(launchctl list | awk '$3=="com.aladdin.tg-monitor"{print $1}')
  if [ -n "$TGMON_PID" ] && [ "$TGMON_PID" != "-" ] && curl -s -o /dev/null -w '' "http://127.0.0.1:8799/" ; then
    HC=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8799/")
    [ "$HC" = "200" ] && ok "tg-monitor 8799 正常回應 (pid=$TGMON_PID)" || err "tg-monitor 8799 回應異常: $HC"
  else
    err "tg-monitor 未在跑或 8799 無回應"
  fi
else
  err "tg-monitor 的 .env/.env.example/run-monitor.sh 白名單尚未齊備"
fi
grep -q '^MON_FIELD_KEY' "$TGMON/.env" 2>/dev/null && err "tg-monitor/.env 不應含 MON_FIELD_KEY_*（金鑰只放 head）" || ok "tg-monitor/.env 正確地沒有欄位加密金鑰"

echo ""
echo "=== 7b. head 行程角色必須是 mon_head（2026-09-02 熱修回歸檢查，Bug 2） ==="
# 根因：head 的 .env 一旦殘留非空 CLUSTER_WORKER_NAME，isWorkerProcess() 舊版
# 嗅探邏輯會把 head 誤判成 worker，要求 mon_exec 但 .env 只有 mon_head 密碼，
# 連線池建立失敗（進而讓 startMonitorMaintenance 在開機路徑未被捕捉地拋出，
# 釀成 launchd crash loop）。結構性修法是 server.ts/worker-agent.ts 顯式呼叫
# declareMonitorRole()，不再嗅探這個變數；這裡額外檢查根因本身有沒有清掉，
# 屬縱深防禦（即使程式碼修法被回退，這條檢查仍能先示警）。
WORKER_NAME_IN_HEAD_ENV=$(grep '^CLUSTER_WORKER_NAME=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
if [ -n "$WORKER_NAME_IN_HEAD_ENV" ]; then
  err "head 的 .env 含非空 CLUSTER_WORKER_NAME='$WORKER_NAME_IN_HEAD_ENV'（head 不該有這個值，worker 才用；這正是 2026-09-02 crash loop 的根因）"
else
  ok "head 的 .env 沒有殘留 CLUSTER_WORKER_NAME"
fi
if grep -q "declareMonitorRole('mon_head')" "$DISPATCHER/server.ts"; then
  ok "server.ts 已顯式宣告角色 mon_head（不再嗅探 CLUSTER_WORKER_NAME）"
else
  err "server.ts 未找到 declareMonitorRole('mon_head') 宣告（角色偵測退回舊嗅探邏輯，易受 .env 污染）"
fi
if grep -q "declareMonitorRole('mon_exec')" "$DISPATCHER/worker-agent.ts"; then
  ok "worker-agent.ts 已顯式宣告角色 mon_exec"
else
  err "worker-agent.ts 未找到 declareMonitorRole('mon_exec') 宣告"
fi

echo ""
echo "=== 8. 備份（§2.4） ==="
BACKUP_DIR="$HOME/.aladdin-backups/monitor-db"
LATEST=$(ls -1t "$BACKUP_DIR"/pipeline_monitor.*.sql.gz 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  AGE_S=$(( $(date +%s) - $(stat -f%m "$LATEST" 2>/dev/null || stat -c%Y "$LATEST") ))
  AGE_H=$((AGE_S / 3600))
  if [ "$AGE_H" -lt 26 ]; then
    ok "最新備份 ${AGE_H}h 內 ($LATEST)"
  else
    err "最新備份已 ${AGE_H}h（> 26h）"
  fi
  if gunzip -c "$LATEST" | grep -q "CREATE TABLE.*runs"; then
    ok "備份可解壓且含 CREATE TABLE runs"
  else
    err "備份內容異常，找不到 CREATE TABLE runs"
  fi
  ls -ld "$BACKUP_DIR" | awk '{print $1}' | grep -q '^drwx------' && ok "備份目錄權限 0700" || warn "備份目錄權限非 0700"
else
  err "找不到任何 monitor-db 備份"
fi
COMMAND_CHECK=$(git -C "$BACKUP_DIR" rev-parse --show-toplevel 2>/dev/null || true)
[ -z "$COMMAND_CHECK" ] && ok "備份目錄不在任何 git 工作區內" || err "備份目錄落在 git repo 內: $COMMAND_CHECK"

echo ""
echo "=== 9. mysql2 版本 pin（【G:MN-G3】，Phase 1 才會裝，本階段預期 N/A） ==="
PKG="/Users/user/aladdin/telegram-dispatcher/package.json"
if grep -q '"mysql2"' "$PKG" 2>/dev/null; then
  VER=$(grep '"mysql2"' "$PKG" | sed -E 's/.*"mysql2":[[:space:]]*"([^"]+)".*/\1/')
  [ "$VER" = "3.18.0" ] && ok "mysql2 pin 於 3.18.0" || err "mysql2 版本不是精確的 3.18.0（現值: ${VER}）"
else
  napb 1 "telegram-dispatcher/package.json 尚未加入 mysql2 依賴（Phase 1 工項）"
fi

echo ""
echo "=== 10. tunnel job（Phase 3 工項，本階段預期不存在） ==="
TUNNEL_JOBS=$(launchctl list | grep -c 'com.aladdin.monitor-tunnel' || true)
if [ "$TUNNEL_JOBS" -eq 0 ]; then
  napb 3 "尚無 monitor-tunnel job（worker 部署與 tunnel 屬 Phase 3，本輪明確排除）"
else
  ok "偵測到 $TUNNEL_JOBS 個 monitor-tunnel job"
fi

echo ""
echo "=== SUMMARY: ERRORS=$ERRORS WARNS=$WARNS ==="
[ "$ERRORS" -eq 0 ]
