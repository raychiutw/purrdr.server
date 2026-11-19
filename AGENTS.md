# AGENTS.md

## 專案性質

Purrdr 的後台：Cloudflare Worker + D1,負責會員登入、訂閱權限、推播轉送與主機同步(聊天與終端機不經過這裡)。從 app repo [`raychiutw/purrdr.ios`](https://github.com/raychiutw/purrdr.ios) 的 `backend/` 抽出(保留歷史),**私人 repo**。API、資料表與上線前設定見 `README.md`。

這個 repo 沒有自己的 ADR、行為規格與詞彙表，一律引用 app repo:
- 詞彙 [`GLOSSARY.md`](https://github.com/raychiutw/purrdr.ios/blob/master/GLOSSARY.md)
- 決策 [`docs/adr/`](https://github.com/raychiutw/purrdr.ios/tree/master/docs/adr)(推播 ADR-0004、會員與訂閱 ADR-0007、改名 ADR-0009)
- issue 與 spec 都在 app repo 的 GitHub Issues。本 repo 提到 issue 一律寫成 `raychiutw/purrdr.ios#<數字>`(抽出前的舊 commit 寫的 `#<數字>` 也是指 app repo)。
- 主機端(主機服務、主機外掛)在 [`raychiutw/purrdr.host`](https://github.com/raychiutw/purrdr.host)。

## 技術棧

TypeScript、Cloudflare Workers、D1(`migrations/`)、`jose`;測試用 vitest + `@cloudflare/vitest-plugin`(Workers 本機測試環境與本機 D1)。

## 常用指令

```bash
npm ci
npm run typecheck   # tsc + 檢查 worker-configuration.d.ts 是否與 wrangler.jsonc 一致
npm test            # vitest run;不連 Cloudflare、不連 Apple／Google、不用真金鑰
npm run types       # 改了 wrangler.jsonc 之後重新產生 worker-configuration.d.ts
```

CI(`.github/workflows/ci.yml`,PR 與推到 `master`):`npm ci`、`npm run typecheck`、`npm test`。actions 一律 pin 到 commit SHA。

## 部署

**後台由使用者手動部署**(`npx wrangler d1 migrations apply purrdr --remote`、`npx wrangler deploy`),不會跟著 app 發布上線，CI 也不部署。Agent 不要執行 deploy、migration `--remote` 或 `wrangler secret`。

## 規範

- 語言與 TDD 依 app repo 的 [`AGENTS.md`](https://github.com/raychiutw/purrdr.ios/blob/master/AGENTS.md):文件、註解、commit message 用繁體中文(台灣用語),技術名詞保留英文。
- TDD:production code 變更先寫失敗測試，真的跑出紅燈再實作;紀錄放 `.tdd-logs/`(不進 git),摘要寫在 PR。
- 新增的會員資料表一律 `REFERENCES members(id) ON DELETE CASCADE`;API 與 app 的對應改動(例如主機同步欄位)要兩個 repo 一起改。
- 不直接 commit 到 `master`:開 feature branch,push 後開 PR,CI 全綠後以 merge commit 合併。
