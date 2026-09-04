# Pipeline / Monitor 六項問題調查報告（2026-09-04）

> **2026-09-04 更新：六項問題已全數實作完成**，見下方「實作總結（2026-09-04 下午）」。原始內容（調查結論）保留在後，作為每項修法的完整背景與 file:line 依據，不再是「只調查不實作」的狀態。

## 實作總結（2026-09-04 下午）

在唯讀調查完成後，使用者裁示「不管 monitor-db-as-truth 專案的 7 天觀察冷卻期，現在直接全面實作」，共分四輪派工完成，另加一輪對抗性安全審查與一個審查發現的小修補。**兩個 repo 全程未 `git push`（本機 commit）、commit message 皆不含 `Co-Authored-By`（依 `/Users/user/aladdin/CLAUDE.md` 硬規則）。**

| # | 問題 | 狀態 | 關鍵改動 |
|---|---|---|---|
| 1 | 每種結束狀態都要發 TG，文字要能區分 | ✅ 完成 | `classify-result.ts` 新增 `session_limit` 分類（研究後誠實標記為低信心度字串比對——Claude Code CLI 對所有失敗情境回同一個 exit code，無官方穩定訊號，來源見 `classify-result.ts` 檔頭註解）；修好 `post-run-notify.ts` 「assignee 解析失敗＝靜默不發通知」的 bug（改為 fallback 到既有的升級聯絡人）；每種分類的 TG 文字改成各自獨立 |
| 2 | worker/head 進度與完成細節同步 | ✅ 完成 | worker 新增唯讀端點回傳 trace 內容（`GET /files`）與階段檔案狀態（`GET /jobs/:ticket/stage-files`），head 端 `tg-monitor` proxy 組裝，`/api/agent-trace` 依 `host` 欄位轉發；已知限制：worker 執行中「正在跑第幾輪」的即時細節仍本機限定；stdout/stderr log 連結尚未 host-aware |
| 3 | head 雙向控制 worker（取消＋續跑） | ✅ 完成 | worker 新增 `POST /jobs/:ticket/cancel`（演算法比照 head 既有 `cancelPipeline()`，逐步驟核對過一致）；`/api/pipelines/retry` 原本寫死只能在 head 重跑，已打通到跟一般派工同一套判斷邏輯（`dispatch()`/`dispatchBug()` 新增 `resume` 旗標），可以落到 worker |
| 4 | 需求單 token 顯示異常大 | ✅ 完成 | 確認 MySQL schema 早已有分開的 `input_tokens`/`cache_read_tokens`/`cache_create_tokens` 欄位（migration 003），純粹是 `server.ts` 顯示層無差別相加；已拆開顯示＋加 tooltip 說明。另查清楚 demand-plan vs create-mr 的真實差距（拉到同一口徑後約 4.3 倍，不是畫面顯示的 150 倍），詳見下方「問題 4 補充」章節；意外發現 create-mr 畫面數字系統性低估（未解析 `modelUsage` 子代理花費），已記錄但這次未修 |
| 5 | worker job-done 回報異常誤判 | ✅ 完成 | worker 端新增待重送佇列（`job-done-queue.ts`，tmp+rename 原子寫入＋60 秒週期重試＋開機補送），根治「單次 HTTP 遺失＝永久遺失」這個根因；殘留風險降到「worker 整機硬碟損毀在完成與第一次成功送達之間」這種極端情況 |
| 6 | worker 執行中列表顯示兩筆 | ✅ 完成 | 接上既有但先前沒人讀的 MySQL `dispatch_attempts` 表做去重（`dedupRemoteDispatches()`），不用發明新機制 |

**額外做的事**：使用者要求「掃描是否有我漏掉的」UI 對等性缺口，系統性掃過 `PipelinesListView.tsx`/`PipelineDetailView.tsx` 所有 host/kind 分支，逐項標記已修好／本來就對等／留待下一輪（結果見下方「附錄：UI 對等性掃描清單」）；三輪實作後另派一個對抗性安全審查專門檢查新增的 worker 端 HTTP 端點（路徑白名單、認證機制、cancel 演算法、resume/retry 雙跑風險），結論：**沒有找到可被利用的安全漏洞**，找到一個 Medium-Low 的正確性問題（worker 探測逾時時 fail-open 誤判成「確定沒在跑」，可能誤導使用者按下不該按的重試按鈕，但底層 `dispatch-registry` 的同步檢查仍會擋下真正的雙重執行）已修復為 fail-closed。

**測試結果**（三輪實作＋一輪修補，最終狀態）：
- `telegram-dispatcher`：`bun test` 1173 pass / 3 fail（3 個為既有無關失敗，`whitelist-bugreport-routing.test.ts`/`whitelist-kit-routing.test.ts`，已用 `git stash` 驗證與本次改動無關）
- `tg-monitor`：`bun test` 340 pass / 0 fail；`frontend` build 成功

**誠實的殘留風險（尚未做／需要人工介入）**：
1. **這批改動全部只做到程式碼＋單元測試層級驗證，還沒有真的部署到 worker 機器跑過一次真實流程**（依指示這次刻意未 SSH 進 worker、未跑 `sync-workers.sh`、未 kickstart 任何服務）。要正式生效，需要：`telegram-dispatcher` 側走既有的 `sync-workers.sh` 派送到 worker（如 landon2）並重啟服務；`tg-monitor` 側走既有的 `safe-kickstart` 部署流程。
2. worker 執行中「目前正在跑第幾輪」的即時細節（`inferCurrentBugStage`）仍是本機限定，未覆蓋到 worker。
3. worker 執行的票，stdout/stderr log 連結（`/api/log/tail`、`/api/log/since`）尚未改成 host-aware，指向 worker 檔案時會顯示成 missing。
4. Workers 分頁沒有取消/查看票詳情的入口（非必修，供之後決定要不要加）。
5. `tg-monitor/migration/00-api-inventory.md` 契約文件這次由實作 agent 直接改動（`GET /api/pipelines`、`GET /api/pipelines/run` 兩節），未走該文件既有的「ff 為唯一寫入者」轉交流程（聯絡不到 ff），建議之後知會或請 ff 複查。
6. 這批改動沒有走 `monitor-db-as-truth` 專案自己的裁決台帳（`impl-errata-g2.md` 的 D-序號機制）——是刻意的（使用者裁示「不管冷卻期」），但代表如果之後有人依台帳追溯這幾天的變更史，會在這裡出現一段沒有登記的異動，需要之後有人手動補一筆說明，或至少讓下一個接手 `monitor-db-as-truth` 專案的人知道這份 `ISSUES-INVESTIGATION-20260904.md` 才是這批改動的完整記錄。

---

## 附錄：UI 對等性掃描清單（問題 3 延伸，使用者要求「掃描是否有我漏掉的」）

| 位置 | 結論 |
|---|---|
| `PipelinesListView.tsx` Worker 欄（remote 列 vs history 列） | 已修好：history 列原本只顯示純文字 host，補上跟 remote 列一樣的 worker 詳情連結 |
| `PipelinesListView.tsx` actions 欄（cancel/retry 按鈕） | 已修好：worker running 狀態原本永遠誤判 false（見上方安全審查 Finding），修好後取消按鈕能正確顯示；worker 逾時時已改為 fail-closed 顯示「無法確認執行狀態」 |
| `PipelinesListView.tsx` 其餘欄位（assignee/started/finished/duration/tokens/outcome） | 本來就對等，不需要改 |
| `log` 欄（stdout/stderr 連結） | **發現落差，尚未修**：worker 執行的票，連結指向的 `/api/log/tail`／`/api/log/since` 仍是純本機路徑判斷，會顯示成 missing。修法要把這兩支端點也做成 host-aware，工程量較大，留給下一輪 |
| `AgentConversationCard.tsx` | 檢查過不需要改，host 由 `PipelineDetailView` 統一處理後傳入 |
| `PipelinesPage.tsx` / `WorkersPage.tsx` | 純路由容器，無 host/kind 分支，不需要改 |
| Workers 分頁 | 確認現況：目前沒有取消/查看票詳情的入口，只能查詢粗略的 `GET /jobs/:ticket` 原始 JSON，且沒有連到 Pipelines 詳情頁的連結。非必修項，供之後決定要不要加 |

---

## 總覽

| # | 問題 | 根因類型 | 是否有共通根因 |
|---|---|---|---|
| 1 | 各結束狀態應都發 TG 通知，但沒有 | 分類缺口 + 補發通知路徑無重試/兜底 | 與問題 5 共享「單次動作無重試」的系統性設計模式，但**不是因果關係** |
| 2 | worker 工單進度與完成後細節跟 head 不一致 | 資料只落在執行機本地、沒有回傳機制 | 與問題 6 同源（worker↔head 資料同步缺口） |
| 3 | head 要能手動中斷＋從某 step 續跑，含控制 worker | 功能缺口（本機取消已有，worker 遠端取消完全沒有） | 獨立問題，是純粹的「未開發」而非 bug |
| 4 | 需求單 token 數字異常大（17M～162M） | 資料語意誤用：cache_read 累加值被當「用量」顯示 | 獨立問題 |
| 5 | worker job-done 回報異常，誤判「已清除」 | job-done 是單次 HTTP 無重試，失敗即永久遺失 | 與問題 1 共享同一種系統性設計模式 |
| 6 | worker 執行時 pipelines 列表出現兩筆相同資料 | 前端把兩個獨立資料源（dispatch-registry + runs 表）無去重 concat | 與問題 2 同源（worker↔head 資料同步缺口的另一種症狀） |

---

## 問題 1：pipeline 各結束狀態應都發 TG 通知，但目前不是每個狀態都有

### 現象
使用者列出的五種結束狀態：fail / success / infra failure / need clarification / claude session limit，通知覆蓋率不一致，其中「claude session limit」完全沒有被當成獨立分類存在。

### Root Cause

判斷路徑分兩層：
1. **`.claude/commands/create-mr/create-mr.md` Step 7 出口表**（第 305-367 行）——pipeline **正常跑完並吐出合法結果**時，由它自己決定要不要發 TG。
2. **`classify-result.ts` + `post-run-notify.ts`**（`telegram-dispatcher/lib/pipeline-runner/`）——dispatcher 對**外層 CLI 沒能正常吐出合法結果**的情況做兜底分類與補發通知，是 wrapper bash `EXIT trap` 呼叫的一次性子行程（`spawn-create-mr.ts:231-241`）。

**已驗證涵蓋（會發通知）的狀態**：

| 狀態 | 分類器對應 | 觸發條件 | 通知路徑 |
|---|---|---|---|
| success（真正的） | `classify-result.ts:116` `success` | Step 9 報告 `Pipeline status: success` | create-mr.md Step 7b.1（`:350-355`） |
| already_fixed / i18n_manual_handoff | 收斂進 `success` | — | **不發 TG**（`create-mr.md:310-311` TG 欄是 `—`，只留 Notion，屬既有設計） |
| failed | `classify-result.ts:118` | `Pipeline status: failed` | create-mr.md Step 7c（`:313,367`） |
| needs_qa_clarification | `classify-result.ts:117` | `Pipeline status: needs_qa_clarification` | create-mr.md Step 7c（`:312`，TG=✅，**確實有發，使用者疑慮不成立**） |
| skipped / timeout / infra_failure / cli_failure / unknown_failure | `classify-result.ts:82-129` | exitCode 124→timeout；exitCode≠0→infra_failure；is_error/subtype 異常→cli_failure；抓不到 status 行且非 SKIPPED→unknown_failure | dispatcher 補發（`post-run-notify.ts:83,122-133`），集合在 `NEEDS_NOTIFY`（`:83`） |

**"claude session limit" 是真正的缺口**：`classify-result.ts:31-43` 的 `Classification` 型別只有 8 種值，**沒有針對 usage/session limit 的特徵字串做偵測**。實際會被吸收成：
- CLI 快速以非 0 exit code 結束（較常見）→ 落入 `infra_failure`（`:84`），跟「SSH 斷線」「worktree 建立失敗」混在同一個桶，通知文字只有通用的 `⚠️ [需人工檢查] ${ticket}...分類：infra_failure`（`post-run-notify.ts:129-132`），看不出是額度問題。
- CLI 卡住不退出直到 `timeout 10800`（3 小時）才被砍 → `exitCode 124` → `timeout` 分類，這條反而有專門處理（見下）。

**真正的 bug：非 timeout 的補發通知路徑，assignee 解析失敗時會被靜默吞掉，完全不發通知**（`post-run-notify.ts:568-580`）：
```ts
try {
  const email = resolveAssigneeEmail(ticket)
  if (!email) {
    log(`${ticket} 需要補發通知但找不到 tech assignee email...略過`)   // ← 只印 log，沒人收到通知
  } else if (classification !== 'timeout' || email !== TIMEOUT_ESCALATION_EMAIL) {
    execFileSync('bash', [TG_NOTIFY_SH, '--email', email, '--text', text], ...)
  }
} catch (err) { log(...) }
```
只有 `classification === 'timeout'` 才有強制升級給 Landon 的保證（`:24-29, 546-561`）。`infra_failure`/`cli_failure`/`unknown_failure`/`skipped` 這四類完全依賴 `resolveAssigneeEmail()`，一旦 Notion 查詢失敗、指派人非 tech、或例外，就完全靜音。**「claude session limit」若真的觸發，恰好落在這種沒有強制兜底的分類**，若當下 Notion 指派解析恰好失敗（額度問題常伴隨整帳號多張票同時失敗，Notion 查詢也可能連帶受影響），這張單就完全沒人知道它失敗了。

**process 被 kill/斷電等非正常結束（更符合「claude session limit」實際情境）**：bash `EXIT trap` 對 `kill -9`／斷電重開機完全無法攔截（`spawn-create-mr.ts:37-46`、`stale-lock-reaper.ts:37-46` 已知風險註解），`post-run-notify.ts` 根本不會被呼叫。唯一的補償是 `stale-lock-reaper.ts`（10 分鐘掃描一次，195 分鐘門檻），但：
1. 只處理有鎖檔的 ticket，若鎖目錄因斷電重開被清空（`/tmp`），連這個安全網都摸不到。
2. 觸發延遲達 3 小時以上，通知文字是通用「鎖逾時已回收」，不是有意義的結果分類。

**worker 與 head 通知共用同一份程式碼，問題 1 不是問題 2/5 的下游症狀**：`worker-agent.ts:19-21` 明確：「對使用者的通知不經過 head：EXIT trap / post-run-notify / tg-notify.sh 在本機直接打 Telegram API」。兩者是獨立程式碼路徑，只是在「進程非正常終止」這個共同觸發源下會一起失效。

### 建議修法
1. `classify-result.ts`：對 stdout/stderr 增加 usage-limit 特徵字串偵測，拆出獨立 `session_limit` 分類，通知文字明確標示「額度用盡」而非通用 infra_failure。
2. `post-run-notify.ts:568-580`：assignee 解析失敗時比照 timeout 的 Landon 強制升級模式，退回發給保底對象，不要讓四類補發通知在查無 assignee 時完全靜音。
3. `stale-lock-reaper.ts`：改用 `active-pipeline-marker.ts` 的標記檔（而非鎖目錄）作為掃描起點之一，避免鎖檔遺失（斷電）時安全網失效；可考慮縮短偵測門檻。

---

## 問題 5：worker job-done 回報異常，誤判「已無執行活動但未收到 job-done 回報，登記已清除」

### 現象
訊息來源：`remote-sweeper.ts:170-186`（「vanished」分支）。使用者常常收到此訊息但工單實際有正常跑完，只是回報遺失。

### Root Cause

**job-done 完整生命週期**：
1. worker 端 pipeline 真正結束（`child.on('exit')`，`spawn-create-mr.ts:141,400-403`）→ `bugExitListeners` → `worker-agent.ts:178` 的 `reportJobDone(ticket)`。
2. `reportJobDone`（`worker-agent.ts:157-176`）先確認 `localActivity.isActive` 為 false，才呼叫 `postToHead('/cluster/job-done', ...)`。
3. **`postToHead`（`worker-agent.ts:103-115`）是單次 fetch、10 秒 timeout，失敗只 `catch` 回傳 `false`，完全沒有重試、沒有落地任何 spool/持久化**——`reportJobDone` 收到失敗只印一行 log，之後永遠不會再重試這次回報。
4. head 端只有收到 `/cluster/job-done` 才會 `dispatchRegistry.clear(ticket)`（`cluster-head.ts:218-268`）；沒收到就持續保留 `confirmed` 狀態。
5. 清除觸發：`remote-sweeper.ts` 每 10 分鐘 sweep 一次，過 15 分鐘寬限後查 worker 的 `/jobs/:ticket`；若 worker 回報「locked=false 且 queueState=null」就判定 vanished、清除登記並發通知。

**已排除典型競態**：worker 端 `bugQueue` 的 running 判定在 bash wrapper（含 EXIT trap 全部跑完）真正退出前都持續為 true，此時 `ps` 仍看得到 wrapper，sweep 若查詢不會誤判「無活動」。只有 trap 完全跑完（含 `post-run-notify.ts` 執行完畢）後，lock/ps/queue 三個來源才會真的清空——**此時 sweep 判定「無任何活動」本身是準確的，問題純粹出在第 3 步的單次 HTTP 回報遺失**，job-done 訊號永久消失但工單其實已正常完成。

**遺失原因**：head process 剛好在重啟/部署、head 主 event loop 被 `reapStaleLocks` 的同步 `execFileSync` 卡住（`stale-lock-reaper.ts:17-27` 已知風險）、LAN 抖動、tunnel/SSH 短暫問題等，都會讓這唯一一次 HTTP 呼叫失敗且永不重試。worker 端也**沒有**任何「重啟後重新掃描已完成但未確認回報的工單」補償機制——`recoverBugQueue()`（`worker-agent.ts:191`）只撿回還在排隊/執行中的條目，完成態 ticket 不會被保留供事後重送。

`remote-sweeper.ts` 的「vanished」分支本身就**刻意設計成無法區分**「正常完成但回報遺失」vs「worker 中途重開」，所以只要回報遺失發生，此分支必然觸發並發出這則帶歧義措辭的訊息——不是它誤判，而是根因（單次無重試 HTTP 回報）出現機率不低。

### 建議修法
1. **`worker-agent.ts:157-176` `reportJobDone`**：失敗時落地本機待重送佇列（比照 `pipeline-queue.bug.json` 的 tmp+rename 寫法），由既有週期性 timer 定期重送直到 head 確認收到為止。
2. **worker 啟動補償掃描**：`recoverBugQueue`/`recoverDemandQueue` 附近額外掃一次「本機顯示已完成、但沒有『已成功送出 job-done』紀錄」的最近工單，主動補送，使 worker 整機重開後仍能自我修復。
3. `remote-sweeper.ts:184` 訊息：可考慮在判定 vanished 前，多給一輪 sweep 的重試視窗（降低誤觸發率）；措辭本身已適當表達不確定性，不需要改。

### 問題 1 與問題 5 的共通根因
不是同一個 bug，但同屬一種系統性設計模式：**單次盡力而為（best-effort）的關鍵動作 + 事後由粗粒度、高延遲的週期性安全網兜底，且該安全網刻意設計成無法精確區分成因**。只有 `timeout` 分類的 Landon 強制升級、以及 monitor DB 寫入的 spool 機制是例外，享有真正的「保證送達」設計。兩者共享同一個觸發情境（進程被 SIGKILL/斷電/EXIT trap 未跑完），但**不是因果關係**——各自獨立的程式碼路徑，只是在該根因下會同時發作。

---

## 問題 2：worker 工單進度顯示與 head 不一致；完成後無法顯示「之前做過什麼」

### 現象
worker 執行的 bug 票（如截圖 FAQ-4866）詳情頁只顯示 1 個 agent（`create-mr` stage），「進度 log」固定顯示「（Bug pipeline 的進度請看 stdout log）」；head 執行的票能看到完整的多 stage Agent 流程表格（model/turns/tools/token in-out）。

### Root Cause

**1) worker 端 trace 機制與 head 完全相同，但落地路徑是「執行機本地路徑」**：worker 執行的是與 head 完全相同的程式碼（`sync-workers.sh:27-31,76-88` 用 `git pull --ff-only`），trace 功能存在、也會落地 `logs/agent-traces/<ticket>/*.json`。但 collector 寫進共用 MySQL `agent_runs` 表的 `path` 欄位是**執行機當下的本地絕對路徑**（`agent-runs-collector.ts:50-51`），這條路徑字串在 worker 機器上有效，在 head 檔案系統上不存在對應檔案。

**2) 沒有任何機制把 worker 端的 trace/stdout 檔案內容同步回 head**：`sync-workers.sh` 只 `git pull` 程式碼，不碰 `logs/`；log-shipper（`log-shipper/mount.ts:130-140`）只收集 `logs/` **頂層**的 `*.log`（非遞迴），agent trace JSON 在子目錄、副檔名不同，完全不在收集範圍。只有摘要數字（model/tokens/turns）能回到 head，**原始逐輪對話內容完全沒有回傳機制**。

**3) head 端 `/api/agent-trace` 讀檔邏輯完全沒考慮「worker 執行」情境**（`tg-monitor/server.ts:470-484`）：直接把 `agent_runs.path`（worker 本地路徑）當成 head 本地路徑做 `existsSync`/`readFileSync`，沒有 host 判斷、沒有向 worker 取回內容的 fallback。只要該 run 是 worker 執行的，點進去必定 404，這是使用者截圖看到退化現象的直接成因。

**4)「Pipeline 階段檢核表」也是純本機檔案掃描**：`ingest.ts:746,976-1017` 的 `computeBugStages()` 逐一檢查 `obsidian/Debug/{ticket}/*.md`、`worktrees/<ticket>/bootstrap.log` 的 mtime。這些檔案在 worker 執行時只落在 worker 自己的目錄，head 讀不到，除固定的 `claim` 步驟外其餘一律顯示 `pending`——與是否有 trace 無關，是另一條獨立的本機路徑假設。

**5)「進度 log」固定文字其實是 head/worker 共通的既有設計**（`PipelineDetailView.tsx:225-244`：`progress.length === 0` 就固定顯示該文字），不是 worker 專屬退化；真正因 worker 而額外退化的是上面第 3、4 點。

**6) 進度輪詢資料源確實不同**：head 對「進行中」判定用 `ps` 掃描本機子行程；worker 執行中的票 head 完全沒有對應子行程，只能靠 `GET /jobs/:ticket` 心跳輪詢（`cluster-state.ts:111-119`），資料形狀、更新粒度都與 head 本機的「檔案 mtime 檢核表」不同源——這是「進度顯示與 head 本機不一致」的直接成因。

### 建議修法
- **短期止血**：`/api/agent-trace` 讀檔前先查該 run 的 `host`，非 head 執行時改成向該 worker（`cluster-state.ts` 已有 worker.url 名冊）發新端點請求（`GET /trace?path=`）取回內容；worker 端新增此唯讀端點，掛 `x-cluster-token` 驗證與路徑白名單。
- `computeBugStages()` 與呼叫處：對非 head 執行的 run，改成呼叫同一新端點詢問 worker 端檔案狀態，或至少在 UI 明確標示「此票在 worker X 執行，階段檢核表不可得」。
- **中期**：把 log-shipper 收集範圍擴大到 `logs/agent-traces/**/*.json`（遞迴），並讓 intake-server 在 head 本機依相同相對路徑落地一份精簡副本，維持 `/api/agent-trace` 現有「本機讀檔」邏輯不變，同時真正解決資料回傳缺口。
- 前端：`host !== 'head'` 時把固定文案換成「此票在 worker 執行，進度請看 worker 端心跳」，改接 `/api/cluster/worker?ticket=` 的資料統一呈現。

---

## 問題 6：worker 執行中的票在 pipelines 列表出現兩筆相同資料，結束後變回一筆

### 現象
worker 執行 bug 工單「進行中」階段，列表出現同票兩筆；結束後只剩一筆。

### Root Cause

**不是 DB 寫入層重複，而是前端把兩個獨立資料源無去重 concat**。`tg-monitor/server.ts:291-331` `buildPipelinesPayload()` 回傳三個獨立陣列：`remote`（dispatch-registry，只含「進行中」的派工登記）、`rows`（runs 表，真實 run 紀錄）、`queued`。前端 `PipelinesListView.tsx:22-26` 直接三段 concat，**沒有任何跨陣列的 ticket 去重邏輯**。

**兩條寫入路徑的時序解釋了「進行中兩筆、結束後一筆」**：
1. **dispatch-registry（`remote`）**：head 派工時 `markDispatching` 建一筆 `status:'dispatching'`，worker 接單後轉 `confirmed`，**只有 worker 回報 job-done（或 sweeper 判定逾時）才 `clear`**（`dispatch-registry.ts:17-18,45-46,86,93,98`）——只在「進行中」這段時間存在。
2. **`runs` 表（`rows`）**：`writeRunProgress`（`monitor-db/writes.ts:63-85`）在 pipeline **一開始執行**就寫入，worker 執行同一份程式碼，**worker 一開始執行就直接把這筆 run 寫進共用 MySQL `runs` 表**，與 dispatch-registry 完全獨立、互不知情。

於是「進行中」期間，head 同時看到 `remote` 一筆（還沒 job-done）+ `rows` 一筆（worker 自己寫的），未合併，UI 顯示兩筆相同資料。等 worker 回報 job-done，`remote` 那筆被 `clear()`，只剩 `runs` 表那筆（已更新為終態），列表「變回一筆」。

**DB 層本身沒有重複行問題**：`runs` 表用 `run_id` 為 PK（非 `(host,ticket)`），`ON DUPLICATE KEY UPDATE` + host 守衛寫入紀律良好；`cluster-state.ts` 的心跳輪詢也不寫表，不是第三個 write path。整個現象 100% 是列表組裝層的問題。

### 建議修法
- `buildPipelinesPayload()`：組裝 `remote` 前，先用 `rows` 已有的 `(kind, ticket)` 集合過濾——若某票已在 `rows` 出現，就不放進 `remote`；只有「`rows` 還看不到、但 dispatch-registry 有登記」才走 `remote` 這條「交涉中」顯示路徑。
- 或改在前端 `PipelinesListView.tsx` 組陣列時對 `remote`/`history` 做一次以 `ticket`(+`kind`) 為 key 的去重合併，`history` 優先，風險較小、不用動後端。
- 兩種修法都要保留 `remote` 唯一的獨特價值：顯示「派到哪個 worker、交涉中還沒有 run_id」的極短暫空窗期，只在 `rows` 已出現同票資料後才隱藏 `remote` 那筆。

### 問題 2 與問題 6 的共通根因
两者都是「worker 與 head 之間欠缺一致的資料同步/去重設計」的不同症狀：問題 2 是「該同步的細節資料完全沒同步」，問題 6 是「該去重的兩個獨立來源完全沒去重」，本質上都是 worker 端被視為「另一台獨立機器」接進來時，原本假設「單機執行」的資料模型（本機檔案路徑、本機 ps 快照、單一寫入路徑）沒有相應擴充成「多機感知」。

---

## 問題 3：head 主機要支援手動中斷並從某 step 續跑，包含控制 worker 主機在進行中的單

> 此題是「現況盤點 + 落差清單」，非單純 bug。

### 現況盤點

**1. 現有的「取消」機制（本機）**：`POST /api/pipelines/cancel`（`tg-monitor/server.ts:521-529`）+ `cancelPipeline()`（`ingest.ts:248-357`）。從 `ps` 快照找 wrapper bash pid，展開全部子孫、最深先送 SIGTERM，1.5 秒後 wrapper 還活著再 TERM，5 秒後殘留補 SIGKILL。**這是單一粒度：整條 pipeline 全殺**，沒有「只中斷到某個 stage 邊界」的概念——因為 `/create-mr` 是單一 `claude -p` 行程，Step 0~8 全部在同一個行程內由 Claude 自己派 subagent 完成，head 端在行程層級完全看不到「現在跑到哪個 stage」。

取消後的清理（`EXIT trap`，`spawn-create-mr.ts:231-241`）：釋放 bug-lock → `cleanup-worktree.ts`**清掉 worktree 但保留 `mr/{ticket}` 分支**（`cleanup-worktree.ts:144,164`）→ 發「異常終止」通知（分類為 `infra_failure`，不會觸發自動重試）。tracker 狀態停留在 `in_progress`，不會自動轉終態。

**2. 現有的「從某個 step 繼續」機制**：存在，但是「基於既有產物盤點的粗粒度續跑」而非精確斷點續傳。入口 `POST /api/pipelines/retry`（`server.ts:569-611`）帶 `--resume` 旗標，真正邏輯在 `/create-mr:create-mr` 自己的 Step 0.2，呼叫 `resume-inventory.sh`（`aladdin_ai/scripts/resume-inventory.sh`），依三類事實（Debug 產物是否存在、三份 review 報告結論、`mr/{ticket}` 分支領先幾個 commit）判斷 `RESUME_POINT`（step1/2/4/5/6/7），矛盾時保守回退（寧可多跑一步）。

差異：判斷粒度是幾個大 milestone，不是「某個 step 細粒度」；命中任何 resume point 仍是**整個重新起一個新的 `claude -p` 行程從 Step 0 開始跑**，只是內部跳過已完成的派工；worktree 每次都全新重建，resume 靠的是「checkout 既有分支重建環境」，不是恢復一個「還在跑的」狀態。

**3. 對 worker 主機的控制能力現況**：`worker-client.ts` 只有三支函式——`fetchWorkerCapacity`、`postWorkerJob`、`fetchWorkerJobStatus`（GET，唯讀）。**完全沒有 `/cancel`、`/abort`、`/kill` 端點**，`worker-agent.ts` 全檔搜尋 `cancel|abort` 零命中。head 端 `/cluster/worker/:name/disable` 是「派工准入」層級（不再收新工作），**明確不影響既有工作**（`cluster-head.ts:298` 註解自承）。前端也刻意不提供：`PipelinesListView.tsx` 對 `row.kind === 'remote'` 的票，取消按鈕 render 條件排除它（`:215`）；就算硬呼叫既有 `/api/pipelines/cancel`，`cancelPipeline()` 只查本機 `ps`，worker 上的行程本來就看不到，會直接回 `not running`。head↔worker 目前只有「派工」與「完工回報」兩條流量，完全沒有為「中途下指令」設計過任何通道。

### 落差清單

| # | 現況 | 目標需要 | 落差 |
|---|---|---|---|
| 1 | 本機取消是整條全殺，無 stage 邊界保護 | 安全點中斷 | pipeline 框架（單一 `claude -p` 行程）沒有可觀測/攔截的 stage 邊界 |
| 2 | resume 是 milestone 級盤點 + 整單重觸發 | 精確到「某個 step」續跑 | 沒有結構化的逐 step checkpoint，只能靠檔案存在與否事後反推（且刻意保守） |
| 3 | head 對 worker **完全沒有取消 API** | head 能中斷 worker 上的單 | worker-agent.ts 缺 `/cancel` endpoint；worker-client.ts 缺對應呼叫；tg-monitor 的 cancelPipeline 缺轉發判斷 |
| 4 | `disable` 只影響新單派工 | 中斷 worker 上「這一張」單 | 名冊層級開關是「整台機器」粒度，不是「單張票」，語意不同 |
| 5 | worker 端收尾邏輯（釋放鎖/清 worktree/留 commit）**已存在**，與 head 共用同一套 `spawn-create-mr.ts` | 遠端取消後也要跑一樣的收尾 | 真正缺的只是「head 如何把 SIGTERM 送到 worker 上那個行程」這段傳輸層，不需重寫收尾邏輯 |
| 6 | tracker 合法狀態無 `cancelled`/`paused`，取消後停留在 `in_progress` | 清楚反映「手動中斷、等待續跑」而非跟卡住的 `in_progress` 混在一起 | tracker 狀態機語意不夠細 |
| 7 | worker 的 `GET /jobs/:ticket` 只回唯讀摘要 | 用來決定中斷後要不要接續 | 現有 `stages` 是不錯基礎，但目前只給查詢用，未接進中斷/續跑決策 |

### 建議實作方向（分階段）

**階段一（低成本，可與階段二一起做）**：不強求「安全點才能中斷」（結構上做不到），改為強化取消後的可診斷性——cancel 時額外記錄「取消當下 `ticket-progress.ts` 判斷的 stage 快照」；tracker 狀態機加 `cancelled`（或沿用 `in_progress` 但通知/留言明確標註「使用者手動中斷」而非「異常終止」），與系統自發的 `infra_failure` 區分開來。

**階段二（本次需求核心缺口，優先做）**：
- `worker-agent.ts` 新增 `POST /cancel`（或 `/jobs/:ticket/cancel`），內部複用 tg-monitor `cancelPipeline()` 同一套邏輯（需抽成共用模組，或在 worker-agent 內重新實作等價邏輯）。
- `worker-client.ts` 新增 `cancelRemoteJob(url, secret, ticket)`。
- tg-monitor 的 `/api/pipelines/cancel` 先判斷該票是本機跑還是某 worker 在跑（查不到本機 `ps` 時查 `dispatch-registry`），轉發到對應 worker。
- 前端補上 `remote` 分支的取消按鈕（目前刻意 render null）。
- 安全邊界沿用既有 `/cluster/*` guard（`rejectTunnel: true`，只認 LAN + shared secret）。

**階段三（工程量最大，建議先觀察真實使用頻率再決定是否投入）**：在 `/create-mr:create-mr` 內部落一份結構化 checkpoint（每 Step 完成寫 `.checkpoint.json`），取代目前「產物是否存在」的間接推斷。但現有 milestone 級 resume 已解決多數「不要浪費已完成工作」的痛點，精細化的 ROI 主要在「單一 step 內部耗時很長被砍」的情境才明顯，且 subagent 執行狀態本身難以序列化恢復，不是簡單 checkpoint 檔能完全解決的。

---

## 問題 4：需求單 token 計算顯示異常

### 現象
截圖範例：`ALDREQ-794`（worker，20m20s）顯示 `17.44M / 159.7k`；`ALDREQ-782`（本機，40m55s）顯示 `162.63M / 314.8k`。經直接讀取 ALDREQ-782 在本機的 9 份 trace 檔重算，**結果與畫面數字完全對得上**（total_input=162,626,987、total_output=314,828）——**這不是顯示層計算錯誤，是資料本身（Claude Code CLI 回報的 usage）就長這樣，再被 tg-monitor 忠實加總出來**。

### Root Cause

**1) 一張需求單會呼叫 9 次 `claude -p`，每次各自落一份 trace 檔**：`spec-gate` → `repo-scope` → `draft-A`/`draft-B`（平行×2）→ `review-convention`/`review-conflict`/`review-security`（平行×3）→ `synthesize` → `classify`（`demand-plan-pipeline.ts` 各處、`spec-sufficiency-gate.ts:201`、`repo-scope-gate.ts:58`）。每次呼叫用 `--output-format json`，落地邏輯在 `claude-exec.ts:98-104`，完整保留 CLI 回傳的全部事件。

**2) tg-monitor 收檔時只取「最後一個 result 事件」的 usage，沒有跨事件相加——這一步是對的**：`ingest.ts:1127-1153` `summarizeEvents` 碰到 `result` 事件是覆寫不是累加，一個 trace 檔正常只有一個 `result` 事件，這一層沒有重複疊加。

**3) 真正的量級來源：CLI 自己回報的 `result.usage.cache_read_input_tokens` 本身就是「整個 session 內每一輪 cache_read 讀取量的累加總和」，不是「最後一輪 context 大小的快照」**。實測 ALDREQ-782 的 `draft-A` stage（單一 session，142 轮）：最終 `result.usage.cache_read_input_tokens = 69,986,342`（約 70M）；逐輪拆開看，`message.usage.cache_read_input_tokens` 是單調遞增的快照序列（turn 0=0 → turn 247=597,015），而**最終 result 事件的總量正是把 142～248 輪各自的 cache_read 原始相加**——長對話（多輪工具呼叫）天生會讓這個欄位以接近 `O(輪數 × 平均 context 大小)` 膨脹，142 輪 × 幾十萬 token 加總破億完全合理，**這是 Claude Code CLI 對 usage 的既有回報方式，不是 tg-monitor 生造出來的數字**。

**4) tg-monitor 再把已膨脹的 cache_read 無差別併入 input，跨 9 個 stage 相加**：`server.ts:285-286` `attachAgentRuns`：
```ts
r.total_input = r.agents.reduce((n, a) => n + (a.input_tokens ?? 0) + (a.cache_read_tokens ?? 0) + (a.cache_create_tokens ?? 0), 0)
r.total_output = r.agents.reduce((n, a) => n + (a.output_tokens ?? 0), 0)
```
逐 stage 攤開（ALDREQ-782 實測）：draft-A cache_read=69,986,342、draft-B cache_read=45,005,031、review-convention=20,059,598、review-conflict=19,632,081、review-security=4,912,584… 9 個 stage 加總 `SUM(input+cache_read+cache_create) = 162,626,987`，與截圖一致。

**結論**：使用者懷疑的三個方向同時成立，且是疊加關係——
- (a) cache token 被無條件併入「input」（`server.ts:285`），而 cache_read 本身已是 CLI 側多輪累加的巨量值（(b)）。
- (c) 9 個 stage 各自獨立呼叫的 usage 相加成 ticket 總量，這一步邏輯上合理（真實加總），但每個 stage 都已膨脹到千萬級，加總後破億。
- (d) 畫面完全沒有把 cache_read（佔 total_input 99%+）與真正「新產生」的 input 區分開，使用者看到大數字會誤以為是「新處理的 token」。

**ALDREQ-782（本機 162.63M）vs ALDREQ-794（worker 17.44M）差距近 10 倍**：本機找不到 ALDREQ-794 的 trace 檔（派到 worker 執行，trace 落在 worker 檔案系統），head UI 是透過共用 MySQL 的 `agent_runs` 表讀到 worker 收集寫入的摘要，兩邊走**同一套 `summarizeEvents` + 加總公式**，沒有發現本機/worker 用不同演算法的證據。差距最可能是**內容/複雜度差異**（token 總量幾乎由 `num_turns` 主導，draft-A 142 輪 vs draft-B 94 輪就差 35%，跟耗時不是線性關係）而非聚合機制差異。**保留項**：未能連線 worker 檔案系統或唯讀查 `mon_ui` MySQL 核對 794 是否完整收到 9 個 stage 的 trace，不能 100% 排除「worker 端有 stage trace 遺漏、796 數字反而是少算的」這個可能性；但即使完整收到，17.44M 這個量級本身依然是同一套會膨脹的機制的產物。

### 建議修法
1. **`ingest.ts:1127-1153` `summarizeEvents`**：新增獨立欄位改抓「最後一輪 assistant 訊息自己的 `message.usage`」（單次 API 呼叫的 snapshot），與現有「session 累加值」分開存成不同語意欄位；或改成 sum 每輪 assistant 訊息各自的 `input_tokens`（fresh，未快取部分）而非 `cache_read_input_tokens`，fresh input 才是「這一輪新讀進來的東西」。
2. **`agent_runs` 表 schema**：新增 `fresh_input_tokens` 與 `cache_read_tokens` 分開欄位，避免下游加總邏輯無腦混算。
3. **`server.ts:285-286` `attachAgentRuns`**：`total_input` 只加總 fresh input；`cache_read`/`cache_create` 分開成獨立欄位，UI 以不同顏色/次要文字呈現（例如「in: 496 / cache: 162.6M」），欄位名稱與文案要明確標成「累積 cache 命中量（含重複讀取）」而非「input tokens」。
4. **前端**（`frontend/src/pages/pipelines/PipelinesListView.tsx` 等）：`in / out` 兩欄拆成至少三欄（新輸入/cache 命中/輸出），或至少 tooltip 說明「in 欄包含 session 內重複讀取的快取內容，並非新處理的資料量」。
5. **不需要改動**：`claude-exec.ts` trace 落地邏輯、`summarizeEvents` 對單一 trace 檔只取最後 result 事件、跨 9 個 stage 相加的做法——這些都不是 bug，問題完全出在「被相加的數字語意是什麼」與「UI 怎麼呈現」。

---

## 附錄：本次調查涉及的主要檔案索引

**telegram-dispatcher/**
- `lib/pipeline-runner/classify-result.ts`、`post-run-notify.ts`、`spawn-create-mr.ts`、`stale-lock-reaper.ts`、`ticket-progress.ts`、`active-pipeline-marker.ts`、`claude-exec.ts`
- `lib/cluster/remote-sweeper.ts`、`dispatch-registry.ts`、`cluster-head.ts`、`local-activity.ts`、`worker-client.ts`
- `lib/monitor-db/collectors/agent-runs-collector.ts`、`collectors/index.ts`、`writes.ts`
- `lib/log-shipper/mount.ts`、`intake-server.ts`
- `lib/pipeline-runner/demand-plan-pipeline.ts`、`spec-sufficiency-gate.ts`、`repo-scope-gate.ts`
- `worker-agent.ts`、`deploy/sync-workers.sh`
- `.claude/commands/create-mr/create-mr.md`（Step 7 出口表）
- `aladdin_ai/scripts/resume-inventory.sh`

**tg-monitor/**
- `server.ts`（`/api/pipelines/cancel`、`/api/pipelines/retry`、`/api/agent-trace`、`buildPipelinesPayload`、`buildPipelineRunPayload`、`attachAgentRuns`）
- `lib/ingest.ts`（`cancelPipeline`、`listRunningPipelineProcs`、`computeBugStages`、`summarizeEvents`）
- `lib/cluster-state.ts`
- `lib/read/single-track-consistency.ts`、`lib/read/mysql.ts`
- `frontend/src/pages/pipelines/PipelinesListView.tsx`、`PipelineDetailView.tsx`

---

## 問題 4 補充：為什麼需求單 token 看起來比 create-mr 整體還多（2026-09-04 補充調查）

### 背景

問題 4（上面）已修正 tg-monitor 的顯示層（`total_input` 不再無差別併入 cache，見
`tg-monitor/lib/agent-runs-summary.ts`）。但使用者提出一個更根本的疑問：**同一天的兩張票**，
需求單 ALDREQ-782 顯示 `162.63M / 314.8k`，create-mr 的 FAQ-4866（21 turns、461 tools）只顯示
`1.04M / 8.4k`，差距約 150 倍——「create-mr 明明要改程式碼、跑更多工具呼叫，照理應該消耗更多
才對，怎麼反而少了 150 倍？」這一節用兩張票的真實 trace 檔逐行核對，找出真正的原因。

### 結論先講：不是「demand-plan 做的事比較多」，是兩種執行方式的 token 記帳方式天生不同

**一句話版本**：demand-plan 的 9 個階段裡有 5 個是「同一個 AI 對話視窗自己來回講了幾十到一百多輪」，
每多講一輪就要把「目前為止講過的所有內容」重新讀一次（這就是 cache_read）——講得越久，重讀的
累計量滾雪球式增加，9 個階段的滾雪球結果加在一起就是那個 1.62 億。create-mr 剛好相反：它的
「主對話」自己只講了 21 輪，大部分實際幹活（追查根因、改程式碼、三位審查員各自審查）都是**外包
給另外開的 10 個獨立小對話**（Task 工具派工），每個小對話都是從零開始、講的輪數少很多，滾雪球
滾不大；而且 tg-monitor 目前**只讀主對話自己的記帳**，10 個外包小對話各自滾出來的雪球完全沒被
算進畫面數字——所以畫面上看起來「消耗特別少」，但那只是「沒被算到」，不是「真的沒消耗」。

### 逐步核對（實際讀 trace 檔，不是推測）

**1) ALDREQ-782（需求單）：9 個階段各自獨立起一次 `claude -p`，各自的 usage 直接加總**

實讀 `telegram-dispatcher/logs/agent-traces/ALDREQ-782/` 底下 9 份 trace 檔的 `result.usage`：

| 階段 | 輪數（num_turns） | cache_read（累計重讀量） | output |
|---|---:|---:|---:|
| spec-gate | 8 | 93,097 | 2,635 |
| repo-scope | 1 | 0 | 25 |
| **draft-A** | **142** | **69,986,342** | 93,141 |
| **draft-B** | **94** | **45,005,031** | 93,789 |
| **review-convention** | **43** | **20,059,598** | 36,666 |
| **review-conflict** | **41** | **19,632,081** | 37,531 |
| review-security | 21 | 4,912,584 | 21,605 |
| synthesize | 1 | 394,631 | 29,426 |
| classify | 1 | 2,016 | 10 |
| **加總** | — | **160,085,380** | **314,828** |

9 階段的 `input`（666）+ `cache_read`（160,085,380）+ `cache_create`（2,540,941）＝
**162,626,987 ≈ 162.63M**，`output` 加總 314,828 ≈ 314.8k——與畫面數字逐位元組吻合，證實這不是
顯示層算錯，是 9 個真實存在的 stage usage 老實加總的結果。

**關鍵觀察**：cache_read 幾乎完全由「這一階段跑了幾輪」決定——draft-A 跑 142 輪、cache_read 就
飆到 7000 萬；review-security 只跑 21 輪、cache_read 只有 490 萬，量級差了 14 倍，跟兩者
「輸出了多少內容」（93,141 vs 21,605，只差 4 倍）不成比例，說明主要膨脹來源是**輪數**，不是
「產出的東西比較多」。這正對應 `demand-plan-pipeline.ts` 的設計：draft-A/draft-B/三個 review
stage 都是**同一個 session 內部自己反覆讀檔、寫檔、呼叫工具的 agentic loop**，每一輪都要把
「目前為止這個 session 講過的所有內容」重新當作 prompt 前綴送一次——這個前綴每輪都在變長，
Claude API 把「重讀到的前綴」算成 cache_read，所以**同一個 session 講得越久，cache_read 的
累計總量膨脹得比輪數還快**（不是輪數的等比放大，是輪數的近似平方級放大：第 142 輪要重讀前 141
輪累積的全部內容，第 143 輪要重讀前 142 輪的，逐輪疊加）。9 個階段裡有 5 個是這種「單一 session
內部長輪數迴圈」，各自的雪球滾完再彼此相加，就是 1.62 億的來源。

**2) FAQ-4866（create-mr）：主對話只有 21 輪，但底下開了 10 個獨立子對話**

實讀 `telegram-dispatcher/logs/FAQ-4866.2026-09-03T11-16-50-858Z.stdout.log` 的最終
`result` 事件：

- `num_turns`: 21（主對話/orchestrator 自己的輪數）
- `subagent_stats.spawned`: 10，`by_type`：`bug-report-and-spec-analyst`、`cqa-grounder`、
  `bug-tracer-with-callgraph`、`bug-fixer-with-tests`、`solution-reviewer`、
  `adversarial-solution-reviewer`、`tdd-fidelity-reviewer`、`final-adversarial-reviewer`、
  `drive-uploader-mr`、`mr-pusher`（`/create-mr` pipeline 的 Step 0~8 分工，見
  `.claude/commands/create-mr/create-mr.md`）——這些正是使用者提到的「找根因、改程式碼、三位
  reviewer」，全部是**主對話用 Task 工具另外派工**，不是主對話自己一輪一輪講出來的。
- `result.usage`（主對話自己的記帳）：`input_tokens=30`、`cache_read_input_tokens=968,500`、
  `cache_creation_input_tokens=69,161`、`output_tokens=8,393`——換算成畫面的舊公式
  （30+968,500+69,161）＝1,037,691 ≈ **1.04M**，output 8,393 ≈ **8.4k**，與畫面數字吻合。
- **但同一份 trace 檔裡還有 `result.modelUsage` 欄位**（tg-monitor 目前完全沒有解析這個欄位），
  裡面是**整個 session（含全部 10 個子對話）依模型分類的真實加總**：

  | model | cache_read | output | cost |
  |---|---:|---:|---:|
  | claude-opus-5 | 34,827,566 | 272,288 | $32.69 |
  | claude-sonnet-5 | 2,622,633 | 42,865 | $1.46 |
  | **合計** | **37,450,199** | **315,153** | **$34.14** |

  這個合計的 `output`（315,153）幾乎跟 ALDREQ-782 的 314,828 一模一樣——**兩張票實際「產出的
  內容量」其實差不多**，`total_cost_usd`（$34.14）也精確等於 modelUsage 兩個模型 cost 相加
  （32.69+1.46=34.14，分毫不差），證明 Claude Code CLI 確實有把子對話的花費算進整體帳單。
  真正沒被算進去的，只有 tg-monitor 目前抓的那個 `usage` 欄位——它是**主對話自己這一輪的小記
  帳本**，10 個子對話各自的記帳本沒有被讀取、沒有被加總進 `agent_runs`。

### 為什麼子對話的 cache_read（37M）遠小於需求單 5 個長迴圈階段的加總（160M）

兩邊「累計 cache_read」量級差了 4 倍多，原因回到上一節講的「輪數與 cache_read 近似平方級放大」：

- demand-plan 的 draft-A/draft-B/三個 review stage，**每一個都是單一 session 自己跑 21~142
  輪**，且都是**同一個雪球從頭滾到尾**（session 全程沒有中斷、context 一路累積），5 個高輪數
  階段各自貢獻幾千萬，加總破億。
- create-mr 的 10 個子對話，**每一個都是從零開始的新 session**（Task 工具派工給子代理時，
  子代理拿到的是乾淨、範圍收斂的任務指示，不是父對話累積了 21 輪之後的完整歷史），即使子代理
  自己內部也跑不少輪（例如 bug-tracer 五角度系統性排查、bug-fixer-with-tests 的 RED→GREEN
  循環都需要多輪工具呼叫），**10 個雪球是分開各自滾、彼此不疊加**，任何一個雪球滾到的輪數與
  累積量都遠小於 demand-plan 那種「一路滾 142 輪不中斷」的單一雪球。這正是使用者原本猜測的機制：
  **Task 工具子代理有自己獨立的 context，不會像同一個 session 逐輪累積那樣讓 cache_read
  隨輪數膨脹**——實測數據支持這個猜測成立。

### 誠實記錄一個超出本次任務範圍、但直接相關的既有落差

tg-monitor 目前對 create-mr（bug pipeline）的 token 記帳**只解析 `result.usage`
（主對話自己的），完全沒有解析 `result.modelUsage`（含全部子代理的真實總量）**——這不是本次
任務要修的 bug（`lib/ingest.ts` 的 `summarizeEvents` 沒有被要求改動，且改動它涉及
`agent_runs` 表新增欄位、collector 重新收集歷史資料等更大範圍的變更，超出本次「顯示層拆分
cache/input」的任務範圍），但誠實記錄：**畫面上 create-mr 顯示的 `1.04M/8.4k`，其實系統性低估
了它的真實資源消耗**（真實約為 cache_read 37.45M、output 315k、成本 $34.14）。這代表目前
demand-plan 與 create-mr 兩種票在 tg-monitor 畫面上的數字**不是同一個口徑**：demand-plan 是
「9 個行程各自的真實總量老實加總」，create-mr 是「只有主對話那一小部分，10 個子代理的真實消耗
完全沒算進去」。這個口徑落差會讓兩者的畫面數字對比失真（實際差距是 160M vs 37M，約 4.3 倍，
而不是畫面上看起來的 150 倍）。若之後要讓兩種 pipeline 的 token 數字可以公平比較，建議另開
工單改 `summarizeEvents` 一併解析 `modelUsage`（或至少把 `subagent_stats`／`modelUsage` 存
進 trace 摘要供之後查閱），這裡先如實記錄，不在本次任務內動工。

### 給非工程背景讀者的因果鏈總結

1. 需求單（demand-plan）把一張票拆成 9 個步驟，用 9 次「開新對話視窗」個別問 AI，最後把 9 次
   各自的用量老實加總顯示出來。
2. 其中 5 個步驟（草稿兩份 + 三種審查）AI 自己在同一個對話視窗裡來回講了很多輪（最長 142 輪）
   才把事情做完——AI 每多講一輪，就要把「這個視窗裡已經講過的所有內容」整個重看一次，講越久、
   重看的累計量越大，這個累計量就是「cache_read」。
3. create-mr（自動修 bug）表面上只用「一個對話視窗」講 21 輪，但這個視窗背後偷偷另外開了 10 個
   分身視窗去做細部工作（查根因、改程式碼、三位審查員各查一次），每個分身視窗都是從頭開始講、
   講的輪數也少很多，所以「重看累計量」滾不大。
4. tg-monitor 目前只讀「主視窗」自己的記帳，10 個分身視窗各自的記帳完全沒被讀進來、沒被算進
   畫面數字——所以 create-mr 畫面上顯示的數字，其實只是它真實花費的一小部分（真實約 37M，畫面
   卻只顯示約 1M）。
5. 兩件事疊加，才造成使用者看到的「差 150 倍」的錯覺：demand-plan 是「同一視窗講太久、天生會
   雪球式膨脹」+「9 步驟老實全部加總」；create-mr 是「用分身視窗分攤工作、雪球滾不大」+
   「畫面只顯示主視窗一小部分、分身視窗的消耗完全沒被算進去」。把兩者拉到同一個口徑（都算真實
   總量）後，真實差距其實只有約 4 倍（160M vs 37M），不是 150 倍——demand-plan 確實比較貴，
   但沒有畫面數字暗示的那麼誇張，而 create-mr 也不是真的「幾乎不花錢」，只是分身視窗的花費
   目前沒被顯示出來而已。
