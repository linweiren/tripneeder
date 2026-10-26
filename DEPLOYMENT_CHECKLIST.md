# TripNeeder 部署檢查清單

本清單用於 Preview 與 Production 發布，涵蓋程式檢查、Supabase migration、Vercel 環境變數及登入與點數流程。

## 本機確認

- 執行 `npm run lint`。
- 執行 `npm run build`。
- 執行 `npm run test:unit`；此命令包含分享資料安全、行程多樣性、天氣解析與隔離 PostgreSQL migration 測試。
- 開啟 `http://localhost:5173/login`，確認登入頁可載入。
- 未登入呼叫 `/api/generate-trip` 應回 401。
- 登入後送出 AI 分析，成功時扣 20 點。
- AI 分析失敗時需顯示 `分析失敗不扣除點數`，且不扣點。
- `/points` 可顯示帳號、餘額與交易紀錄。
- `npm run points:manager` 可啟動本機點數管理器。

## 合併與 CI

- Pull request 必須通過 GitHub Actions 的 lint、production build 與 unit checks。
- 在 GitHub 分支保護設定中，將 `Lint, build, and unit tests` 設為必要檢查；workflow 本身不會自動設定分支保護。
- 程式碼若依賴新的資料表、函式或 RPC，先部署相容的 Supabase migration，再發布會呼叫它的前端/API。
- Production 僅由確認過的 `main` 版本部署；`weather` 上的修改需經 review 與 CI 後再合併。

## Supabase migrations

- 先在 Supabase Dashboard 備份或確認可用的還原點。
- 使用 Supabase CLI 確認連結的是正確專案，並檢查 `supabase migration list`。
- 執行 `supabase db push --dry-run`，確認待套用 migration 與預期一致，再執行 `supabase db push`。
- 套用完成後再次檢查 migration list，確認版本沒有缺漏或分歧。
- 若目標資料庫停在 010，應依序套用 011～018；套用期間避免發布依賴新 RPC 的網站版本。
- 014、016、017 會清理舊分享資料。正式套用前要確認分享表狀態與資料影響；若已存在分享資料，先在 staging 驗證並確認備份，不要略過直接執行。
- migration 執行失敗時先保留錯誤訊息並調查 schema 與 migration 紀錄；不要只修改 migration history 來標記成功。

## Vercel Environment Variables

瀏覽器可讀取的變數僅限 Supabase URL 與 anon key：

```txt
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Vercel server-side 需要設定：

```txt
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
OPENAI_API_KEY=...
GOOGLE_PLACES_API_KEY=...
CWA_API_KEY=...
```

依功能選用：

```txt
OPENAI_MODEL=gpt-4.1-mini
MOENV_API_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

`SUPABASE_SERVICE_ROLE_KEY` 在 Vercel 可選，用於跨執行個體共用持久限流；缺少或服務故障時，API 會退回執行個體內限流。若設定，只能放在 server-side 環境變數，不可加上 `VITE_` 前綴。`MOENV_API_KEY` 僅在啟用空氣品質資料時需要。私密 API key 絕不可放入任何 `VITE_` 變數。

## Vercel 專案設定

- 專案類型：Vite。
- Build Command：`npm run build`。
- Output Directory：`dist`。
- Install Command：預設 `npm install` 即可。
- 已加入 `vercel.json`，將 SPA 深層路由 rewrite 到 `/index.html`，避免 `/login`、`/points`、`/plans/:id` 重新整理時 404。

## Supabase

- 遠端 migration 狀態需依目標 Supabase 專案確認，不可假設所有環境都已套用相同版本。
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

- production `dist` 不應出現 OpenAI、Google Places、CWA、MOENV 或 service role key。
- `.env` 不應提交。
- `.env.example` 只能放 placeholder。
- `點數管理器` 不放到使用者端導覽或 App UI。
- 部署後確認安全回應標頭存在，且 Google OAuth、地理定位與 SPA 深層路由仍正常。

## 組員試用驗收路徑

- 組員開啟正式網址。
- 點 `登入`，使用 Google 登入。
- 登入成功後回到首頁。
- `/points` 顯示初始 100 點。
- 首頁送出 AI 分析。
- 成功產生三方案後，點數從 100 變成 80。
- `/points` 出現 `分析扣點` 紀錄。
- 收藏與最近生成只顯示該組員自己的資料。
