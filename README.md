# TripNeeder

AI 即時行程決策工具。核心場景為「使用者已經在現場，快速規劃接下來幾小時行程」。

## 🚀 快速啟動

1. **安裝依賴**：
   ```bash
   npm install
   ```
2. **啟動開發伺服器**：
   ```bash
   npm run dev
   ```
   存取 `http://localhost:5173`。

## 🛠️ 技術架構

- **前端**：Vite + React + TypeScript + React Router
- **後端**：Vercel Functions (API) + OpenAI API
- **資料庫/認證**：Supabase (Google 登入)
- **快取策略**：本地優先 (Optimistic UI) + 背景背景雲端同步

## 🔑 環境變數 (.env)

前端雲端登入、行程生成與地點搜尋需設定以下變數；天氣與伺服器端 Supabase API 請依下方清單補齊：

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
OPENAI_API_KEY=...
GOOGLE_PLACES_API_KEY=...
CWA_API_KEY=...
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

Vercel 需要設定 `OPENAI_API_KEY`、`GOOGLE_PLACES_API_KEY`、`CWA_API_KEY`、`SUPABASE_URL` 與 `SUPABASE_ANON_KEY`；`MOENV_API_KEY` 只在啟用環境部空氣品質資料時需要。`SUPABASE_SERVICE_ROLE_KEY` 可選，用於跨 Vercel 執行個體共用的持久限流；未設定或服務暫時不可用時，API 會改用執行個體內限流，不會因此全面回傳 503。此 Key 只能設為 server-side 環境變數，絕不可加上 `VITE_` 前綴或傳入瀏覽器。

## 📖 開發規範

- **單一真相來源**：主規格與進體進度以 `PROJECT_SPEC.md` 為準。
- **本地優先**：行程紀錄優先讀取 `sessionStorage` 與記憶體快取，異步同步至 Supabase。
- **分支管理**：開發請在 `dev` 分支進行。`main` 分支推播會自動部署至 Vercel Production。
- **測試**：本地測試腳本存放在 `tests/` 資料夾。

## 📦 部署

專案連接至 Vercel。`git push origin main` 觸發正式站部署。

Pull request 會執行 GitHub Actions：lint、production build 與單元測試。合併前請檢查 [部署清單](DEPLOYMENT_CHECKLIST.md)，尤其是 Supabase migration 與依賴 RPC 的程式部署順序。GitHub 分支保護需另外設定 `Lint, build, and unit tests` 為必要檢查。
