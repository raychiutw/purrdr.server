# Purrdr 後台

[Purrdr](https://github.com/raychiutw/purrdr.ios) 的後台。Purrdr 讓你在手機上看著、指揮電腦上跑的 AI 寫程式 Agent;這個後台是手機 app 背後幫忙的那一小塊,聊天與終端機的內容不會經過這裡。

## 它做什麼

- **會員登入**:用 Apple 或 Google 帳號登入,一個會員可以綁多種登入方式,重複的會員可以合併。
- **訂閱權限**:對照 App Store 與 Google Play 的訂閱狀態,決定會員有沒有 Purrdr Plus。
- **推播轉送**:Agent 需要你、完成了、可能卡住時,把通知轉給你的手機;每個會員每天有通知則數上限。
- **主機同步**:把你設定好的電腦清單同步到不同裝置(Purrdr Plus)。

## 更多說明

- 版本更新紀錄:[CHANGELOG.md](CHANGELOG.md)
- API、資料表與運作規則:[docs/backend.md](docs/backend.md)
- 開發與發行流程:[AGENTS.md](AGENTS.md)
