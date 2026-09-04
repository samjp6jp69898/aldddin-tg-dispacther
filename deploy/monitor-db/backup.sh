#!/bin/zsh
# 每日備份 pipeline_monitor（§2.4）。備份目錄在所有 repo 之外
# （~/.aladdin-backups/monitor-db/，比照 §5.8 名冊備份的位置紀律），
# 保留最近 14 份，由本腳本自己修剪（不依賴外部清理排程，m-9）。
#
# ── 為什麼要先寫暫存檔、驗證過才原子搬進正式位置（2026-09-03）────────────────
# 舊版是 `docker exec ... | gzip > "$OUT"`：重導向會**先把正式檔名建出來**，管線才開始
# 執行。2026-09-03 03:00 排程跑的時候 Docker Desktop 是停的，docker exec 失敗，磁碟上
# 留下一個 20 bytes 的空 gzip——而它是備份目錄裡**最新的一份**。
#
# 這是最惡劣的一種壞：要復原時，人會伸手拿最新那份；doctor 的「最新備份 26h 內」也判綠
# （它確實存在、確實新）。而且 KEEP 修剪是按 `ls -1t` 排的，**連續失敗會把真備份擠出去**。
# 失敗的備份偽裝成最新的備份，比沒有備份更危險。
#
# 現在的做法：寫進一個**刻意不符合 `pipeline_monitor.*.sql.gz` glob** 的暫存檔 → 驗證 →
# `mv` 原子搬進正式位置。暫存檔名避開那個 glob 是結構性的，不是命名潔癖：修剪與 doctor
# 都靠那個 glob 找檔，暫存檔若命中 glob，在它還沒驗證通過時就已經是「最新的備份」了。
# 任何一層驗證不過就刪暫存、非零退出，**不留下任何看起來像備份的東西**——寧可「今天沒有
# 備份」（doctor 的 26h 檢查會轉紅、有人會知道）也不要「有一份假的」（沒有人會知道）。
set -euo pipefail

CONTAINER=mon-mysql
ENV_FILE="/Users/user/aladdin/telegram-dispatcher/.env"
BACKUP_DIR="${HOME}/.aladdin-backups/monitor-db"
KEEP=14
# 空 gzip 剛好是 20 bytes；只含 schema 的真備份也有數 KB
# （2026-09-02 那份 2365 bytes）。512 是「明顯不可能是真備份」的地板，不是品質門檻。
MIN_BYTES=512

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: 找不到 ${ENV_FILE}" >&2
  exit 1
fi

ROOT_PW=$(grep '^MON_DB_ROOT_PASSWORD=' "${ENV_FILE}" | cut -d= -f2- | tr -d '\r\n')
if [ -z "${ROOT_PW}" ]; then
  echo "ERROR: 缺 MON_DB_ROOT_PASSWORD" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${HOME}/.aladdin-backups" 2>/dev/null || true
chmod 700 "${BACKUP_DIR}"

TS=$(date -u +%Y-%m-%dT%H-%M-%S)
OUT="${BACKUP_DIR}/pipeline_monitor.${TS}.sql.gz"
# 前綴 .inprogress. 且副檔名不是 .sql.gz：兩端都不符合 pipeline_monitor.*.sql.gz。
# 放在同一個目錄是為了讓 mv 成為同檔案系統內的 rename（原子），不會出現「半個正式檔」。
TMP="${BACKUP_DIR}/.inprogress.${TS}.sqlgz"
ERRLOG="${BACKUP_DIR}/.inprogress.${TS}.err"

cleanup() { rm -f "${TMP}" "${ERRLOG}"; }
trap cleanup EXIT

fail() {
  echo "ERROR: 備份失敗，未產生任何備份檔（$1）" >&2
  if [ -s "${ERRLOG}" ]; then
    echo "--- mysqldump/docker stderr（最後 10 行）---" >&2
    tail -10 "${ERRLOG}" >&2
  fi
  exit 1
}

if ! docker exec -e MYSQL_PWD="${ROOT_PW}" "${CONTAINER}" \
     mysqldump --single-transaction --skip-lock-tables -uroot pipeline_monitor \
     2>"${ERRLOG}" | gzip > "${TMP}"; then
  fail "mysqldump/gzip 管線非零結束"
fi

# 四層驗證，由便宜到貴。任一不過都當作「今天沒有備份」。
SIZE=$(stat -f%z "${TMP}" 2>/dev/null || stat -c%s "${TMP}")
[ "${SIZE}" -ge "${MIN_BYTES}" ] || fail "產出只有 ${SIZE} bytes（< ${MIN_BYTES}），視為空檔"

# 注意：空 gzip 是**合法的** gzip，gzip -t 對 20 bytes 的空檔會通過。
# 所以完整性檢查抓不到 2026-09-03 那顆，非空與內容檢查才抓得到——四層都要。
gzip -t "${TMP}" 2>/dev/null || fail "產出不是完整的 gzip"

# 用 grep -c 而不是 grep -q：-q 命中即早退，上游 gunzip 會收到 SIGPIPE，在 pipefail 下
# 整條管線判失敗——而且只有檔案大到塞滿 pipe buffer 時才會發生，小檔測不出來。
# -c 一定讀到 EOF，結構上不可能早退；命中 0 筆時 grep 退 1，由 || true 吸收，
# 判斷完全落在計數值上、與退出碼脫鉤。
# 加 -a：dump 含二進位欄位資料（有 NUL byte，file 判為 data），沒有 -a 的話 grep 走
# binary 模式，行為隨「今天的資料剛好有沒有二進位」而變。-a 讓它與資料內容無關。
DDL_HITS=$(gunzip -c "${TMP}" 2>/dev/null | grep -ac '^CREATE TABLE' || true)
[ "${DDL_HITS}" -gt 0 ] || fail "解壓後找不到任何 CREATE TABLE"

# mysqldump 正常結束才會寫這行。抓的是「中途截斷」：size 夠大、gzip 完整、也有
# CREATE TABLE，但 dump 只跑到一半——前三層全都會放行，只有這層擋得下來。
TAIL_HITS=$(gunzip -c "${TMP}" 2>/dev/null | grep -ac '^-- Dump completed' || true)
[ "${TAIL_HITS}" -gt 0 ] || fail "解壓後找不到 mysqldump 結尾標記，dump 中途截斷"

# 先 chmod 再 mv：正式檔名從出現的第一刻就是 0600，不會有一段可讀的空窗。
chmod 600 "${TMP}"
mv -f "${TMP}" "${OUT}"

echo "備份完成: ${OUT}（${SIZE} bytes, ${DDL_HITS} 張表）"

# 修剪：只留最近 $KEEP 份
COUNT=$(ls -1 "${BACKUP_DIR}"/pipeline_monitor.*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
if [ "${COUNT}" -gt "${KEEP}" ]; then
  ls -1t "${BACKUP_DIR}"/pipeline_monitor.*.sql.gz | tail -n +"$((KEEP + 1))" | while read -r f; do
    echo "修剪舊備份: ${f}"
    rm -f "${f}"
  done
fi
