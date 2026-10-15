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

需設定以下環境變數才能正常運行 AI 與雲端同步：

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
OPENAI_API_KEY=...
GOOGLE_PLACES_API_KEY=...
```

## 📖 開發規範

- **單一真相來源**：主規格與進體進度以 `PROJECT_SPEC.md` 為準。
- **本地優先**：行程紀錄優先讀取 `sessionStorage` 與記憶體快取，異步同步至 Supabase。
- **分支管理**：開發請在 `dev` 分支進行。`main` 分支推播會自動部署至 Vercel Production。
- **測試**：本地測試腳本存放在 `tests/` 資料夾。

## 📦 部署

專案連接至 Vercel。`git push origin main` 觸發正式站部署。
