接手 `/Users/user/aladdin/telegram-dispatcher/` 這個專案，照以下流程進行：

1. 讀 `telegram-dispatcher/HOW-TO-CONTINUE.md`，了解接手規則。
2. `bash telegram-dispatcher/tasks.sh validate` 確認 `tasks.json` 沒壞。
3. `bash telegram-dispatcher/tasks.sh next` 找下一個可做的 task。
4. 讀該 task 的 `description`／`acceptance_criteria`／`risk_notes` 三個欄位（`risk_notes` 常附真實案例或 file:line，不是空話）。
5. `bash telegram-dispatcher/tasks.sh set <id> in_progress`。
6. 實作，完成後逐條對照 `acceptance_criteria` 驗證。
7. `bash telegram-dispatcher/tasks.sh set <id> done`（卡住做不完就 `blocked`，並講清楚卡在哪）。
8. commit（程式碼＋tasks.json 狀態變更一起，訊息開頭帶 task id）。
9. 可以一次做多個 task（重複 3–8），直到沒有可做的、或告一段落。
10. 如果這次工作**改了設計本身**（不只是照描述做），在 `tasks.json` 頂層 `changelog` 加一筆記錄決策。

例外規則：
- **T22（正式上線：launchd 常駐＋ngrok tunnel＋註冊 webhook）不可自行判斷時機執行**，一定要我本人在場明確確認才能做。
- T7、T16 的 `risk_notes` 裡有先前定案/暫緩的背景脈絡，改動前先讀完，不要重新猜一次已經討論過的東西。
- 這個專案跟 aladdin 主線的 `bug_analysis_tracker.md`／`scripts/tracker.sh`（bug 認領池）無關，不要混用心智模型——這裡的認領判斷完全來自 Notion。
