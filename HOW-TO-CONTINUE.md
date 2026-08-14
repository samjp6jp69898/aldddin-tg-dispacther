# 怎麼接手這個專案（給任何 session / agent）

這份文件是給「不是我、也不是這次對話」的未來 session 看的——目標是不用回頭問人就能接著做。

## 每次開工的固定流程

1. **看現況**：`bash telegram-dispatcher/tasks.sh validate`（先確認 tasks.json 本身沒壞）
2. **找下一個可做的 task**：`bash telegram-dispatcher/tasks.sh next`
   - 規則：`status == todo` 且它 `depends_on` 的每一個 task 都已經是 `done`。
   - 沒有回傳（`NO_CLAIMABLE`）代表要嘛全部做完了，要嘛剩下的都卡在別的 task 上——用 `tasks.sh list` 看全貌，`tasks.sh show <id>` 查某個卡住的 task 依賴什麼。
3. **開工前讀完那個 task 的四個欄位**：`description`（做什麼）、`acceptance_criteria`（怎樣算做完）、`risk_notes`（來自可行性調查/使用者定案的具體風險，不是空話，通常附 file:line 或真實案例）、`suggested_agent`（建議怎麼派工，不是強制）。
4. **標成進行中**：`bash telegram-dispatcher/tasks.sh set <id> in_progress`（避免同一個 task 被兩個 session 重複認領——這個檔案設計上假設人會看 `list`，不像 bug_analysis_tracker.md 有 bug-lock.sh 那種強制鎖，純粹是紀律）。
5. **標 done 之前，先做兩件事**（使用者 2026-08-14 定案，見 tasks.json changelog）：
   - **派至少三個 review agents** 去檢驗這次的實作（不用三個都做一樣的事，可以各自聚焦這個 task 的不同風險點）。
   - **實際跑起來測試**，不能只憑程式碼審查就判定完成。會打真實 Notion／真實 bug-lock／spawn 真實背景 process 的高風險 task，**先在對話裡跟使用者討論怎麼測**（例如要不要用假資料、要不要隔離環境變數、會不會碰到共用檔案），不要單方面決定測試方式就下手。
   - 兩件事都過、對照 acceptance_criteria 逐條驗證過，才標記：`bash telegram-dispatcher/tasks.sh set <id> done`。做不完/卡住 → `set <id> blocked`，並在對話或後續 commit message 講清楚卡在哪，方便下一個人接。
6. **commit**：跟這個 task 有關的程式碼變更 + tasks.json 的狀態變更放同一個 commit（或至少同一輪），commit message 開頭帶 task id（例如 `T1: 專案骨架與依賴`），方便之後回溯。
7. **有大架構決定要記錄**：不是每次 `set` 都要寫，但如果這次工作**改變了設計本身**（不只是照著 task 描述做），要在 `tasks.json` 的頂層 `changelog` 陣列加一筆（用 `Edit` 工具直接改，格式跟既有幾筆一致：`{"date": "...", "note": "..."}`），讓下一個 session 知道發生過什麼決策，不用重新爬對話紀錄。

## 派工方式

- 小 task（單一檔案、邏輯直接）可以自己直接做，不用開 subagent。
- 大一點、或 `suggested_agent` 有指名的，照 `.claude/doctrine/10-model-dispatch.md`（怎麼選 model/effort）與 `30-delegation-templates.md`（派工 prompt 模板）的既有規則走，不用重新發明一套。
- 這個專案目前沒有自己的 agent 定義，`suggested_agent: "general-purpose"` 只是提示這類 task 適合用通用 agent 做，不是要求。

## 幾個容易忘記的邊界

- `tasks.json` 只能用 `tasks.sh` 改狀態；欄位內容（description/acceptance_criteria/risk_notes 本身）如果要修，直接用 Edit 工具改沒問題（不像 `bug_analysis_tracker.md` 那種大檔才需要嚴格走腳本），但改完務必跑一次 `tasks.sh validate` 再 commit。
- T16、T7 目前都標註「使用者定案/暫緩」的背景，改動前先讀那兩個 task 的 `risk_notes` 全文，不要重新猜一次已經討論過的東西。
- T22（正式上線：launchd + ngrok tunnel + 註冊 webhook）**任何 session 都不能自己判斷時機執行**，需要使用者本人在場確認——這條寫在 T22 的 `suggested_agent` 欄位裡，是這份清單裡唯一一個「做完不能算完成、還要等人」的 task。
- 這是獨立於 aladdin 主線的新子專案，跟 `bug_analysis_tracker.md`／`tracker.sh`（主線的認領池）無關，不要混用同一套心智模型；`telegram-dispatcher/` 觸發的是既有 `/create-mr` pipeline，但**認領判斷完全來自 Notion**，不是 tracker（見 tasks.json 的 architecture_summary 與 changelog）。
