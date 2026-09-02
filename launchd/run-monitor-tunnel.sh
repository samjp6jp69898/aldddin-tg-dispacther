#!/bin/zsh
# launchd wrapper：head 端對單一 worker 建立反向 SSH tunnel，把 head 的
# 127.0.0.1:3307（mon-mysql）與 127.0.0.1:9429（monitor-log-intake）透過 -R
# 帶到該 worker 自己的 loopback。
#
# 為何 plist 不帶任何 IP：把會變動的 DHCP 位址寫死進 launchd job 是已判定的
# 反模式（plan-db-as-truth v3 MAJOR-D10(2)）——worker 換到新位址時 plist 要
# 跟著手動改，容易漏改、事後難稽核。host 一律由本 wrapper 在啟動當下即時從
# 名冊 logs/cluster-workers.json 解析；plist 本身只帶 worker 的邏輯名字
# （__WORKER__ 佔位符），不帶任何 IP/host。
#
# 為何兩個 forward 綁同一個 job、ExitOnForwardFailure=yes 全有或全無：3307
# （監控 DB 讀寫）與 9429（log intake）對本案是共生的——沒有 log 通道，
# file_offsets 也沒有意義；半通半不通比整條斷更難判讀（plan v3.2 裁定 4）。
# 任一個 forward 綁定失敗就讓整個 ssh job 退出，交給 launchd KeepAlive（用
# 預設 ThrottleInterval 10 秒）重試整條——本腳本不自己 sleep。
#
# 9429 的用途：worker 的 log shipper 把本機 log 經這條既有加密 tunnel POST
# 給 head 的 log intake（monitor-log-intake.plist），不再走明文 LAN HTTP
# （plan v3.2 裁定 4 / BL-G1；v3.1 誤用了當時已被 mcp-toolsmith-server 佔用
# 的 8788，v3.2 實測改正為 9429）。
#
# 用法：run-monitor-tunnel.sh <worker-name> [--resolve-only]
#   <worker-name>    logs/cluster-workers.json 裡的 worker 名字（不是 IP）
#   --resolve-only   只解析並印出 host 到 stdout 後 exit 0，不建立任何連線
#                     （doctor / 測試用）
#
# 解析不到（名字不存在、名冊裡的 url 解不出 host、或該 worker disabled=true）
# 一律視為解析失敗：stderr 印說明、exit 1，交給 launchd KeepAlive 重試。
set -u
ALADDIN="/Users/user/aladdin"
DISPATCHER_DIR="$ALADDIN/telegram-dispatcher"
ROSTER="$DISPATCHER_DIR/logs/cluster-workers.json"
BUN="/Users/user/.bun/bin/bun"

WORKER_NAME="${1:-}"
RESOLVE_ONLY=0
if [ "${2:-}" = "--resolve-only" ]; then
  RESOLVE_ONLY=1
fi

if [ -z "$WORKER_NAME" ]; then
  echo "ERROR: 用法 run-monitor-tunnel.sh <worker-name> [--resolve-only]" >&2
  exit 1
fi

if [ ! -f "$ROSTER" ]; then
  echo "ERROR: 名冊 $ROSTER 不存在" >&2
  exit 1
fi

HOST=$("$BUN" -e '
  const name = process.argv[1];
  const rosterPath = process.argv[2];
  const data = JSON.parse(require("fs").readFileSync(rosterPath, "utf8"));
  const w = (data.workers || []).find((x) => x.name === name);
  if (!w) {
    console.error(`ERROR: 名冊裡沒有 worker "${name}"`);
    process.exit(1);
  }
  if (w.disabled) {
    console.error(`ERROR: worker "${name}" 已 disabled，拒絕解析／建立 tunnel`);
    process.exit(1);
  }
  let host = "";
  try {
    host = new URL(w.url).hostname;
  } catch {
    host = "";
  }
  if (!host) {
    console.error(`ERROR: worker "${name}" 的 url "${w.url}" 解析不出 host`);
    process.exit(1);
  }
  console.log(host);
' "$WORKER_NAME" "$ROSTER")
RC=$?

if [ $RC -ne 0 ] || [ -z "$HOST" ]; then
  exit 1
fi

if [ "$RESOLVE_ONLY" = "1" ]; then
  echo "$HOST"
  exit 0
fi

exec /usr/bin/ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -R 127.0.0.1:3307:127.0.0.1:3307 \
  -R 127.0.0.1:9429:127.0.0.1:9429 \
  "${MON_TUNNEL_SSH_USER:-user}@$HOST"
