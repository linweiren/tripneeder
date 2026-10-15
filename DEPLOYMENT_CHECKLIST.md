# Tripneeder 組員試用發布檢查清單

此清單用於 Phase 7F：部署前安全與環境收尾。目標是在不把 OpenAI key 放進前端 bundle 的前提下，發布給組員試用。

## 本機確認

- 執行 `npm run lint`。
- 執行 `npm run build`。
- 開啟 `http://localhost:5173/login`，確認登入頁可載入。
- 未登入呼叫 `/api/generate-trip` 應回 401。
- 登入後送出 AI 分析，成功時扣 20 點。
- AI 分析失敗時需顯示 `分析失敗不扣除點數`，且不扣點。
- `/points` 可顯示帳號、餘額與交易紀錄。
- `npm run points:manager` 可啟動本機點數管理器。

## Vercel Environment Variables

Production / Preview / Development 建議都設定：

```txt
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
```

不要設定：

```txt
VITE_OPENAI_BROWSER_CREDENTIAL
VITE_OPENAI_MODEL
VITE_GEMINI
SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` 只給本機 `點數管理器` 使用。除非未來要做正式 server-side 管理後台，否則不要放到 Vercel。

## Vercel 專案設定

- 專案類型：Vite。
- Build Command：`npm run build`。
- Output Directory：`dist`。
- Install Command：預設 `npm install` 即可。
- 已加入 `vercel.json`，將 SPA 深層路由 rewrite 到 `/index.html`，避免 `/login`、`/points`、`/plans/:id` 重新整理時 404。

## Supabase

- `supabase/migrations/001_points_schema.sql` 已在 Supabase SQL Editor 執行。
- `supabase/migrations/002_points_consumption.sql` 已在 Supabase SQL Editor 執行。
- Authentication Provider：Google 已啟用。
- Authentication URL Configuration 本機已包含：

```txt
Site URL: http://localhost:5173
Redirect URLs: http://localhost:5173/**
```

- Vercel 網址確認後，補上正式網址：

```txt
Site URL: https://<vercel-domain>
Redirect URLs: https://<vercel-domain>/**
```

## Google Cloud OAuth

Google OAuth Client 的 Authorized redirect URI 應使用 Supabase callback：

```txt
https://<supabase-project-ref>.supabase.co/auth/v1/callback
```

部署到 Vercel 後，一般不需要把 Vercel 網址放進 Google OAuth callback；Vercel 網址需放在 Supabase URL Configuration。

## 試用前安全檢查

- production `dist` 不應出現 OpenAI key。
- production `dist` 不應出現 `SUPABASE_SERVICE_ROLE_KEY`。
- production `dist` 不應出現 `VITE_OPENAI_BROWSER_CREDENTIAL`。
- `.env` 不應提交。
- `.env.example` 只能放 placeholder。
- `點數管理器` 不放到使用者端導覽或 App UI。

## 組員試用驗收路徑

- 組員開啟正式網址。
- 點 `登入`，使用 Google 登入。
- 登入成功後回到首頁。
- `/points` 顯示初始 100 點。
- 首頁送出 AI 分析。
- 成功產生三方案後，點數從 100 變成 80。
- `/points` 出現 `分析扣點` 紀錄。
- 收藏與最近生成只顯示該組員自己的資料。
