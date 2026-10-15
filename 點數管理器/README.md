# 點數管理器

這是 Tripneeder 專案資料夾內的本機管理小工具，用來在點數管理正式後台完成前，讓專案持有人手動調整使用者點數。

## 使用前設定

工具會讀取專案根目錄的 `.env`。

需要既有設定：

```txt
SUPABASE_URL=https://<project-ref>.supabase.co
```

另需新增 Supabase service role key：

```txt
SUPABASE_SERVICE_ROLE_KEY=<Supabase service_role key>
```

`SUPABASE_SERVICE_ROLE_KEY` 只能留在本機或 server-side 環境，不可放到前端 bundle，不可命名成 `VITE_` 開頭。

## 啟動

在專案根目錄執行：

```bash
npm run points:manager
```

啟動後打開：

```txt
http://localhost:4174/
```

## 功能

- 列出已登入並建立 profile 的帳號。
- 顯示目前點數。
- 手動增加點數。
- 手動減少點數，但最低只能減到 0。
- 每次調整都會寫入 `point_transactions`，類型為 `admin_adjust`。

## 注意

這個工具只綁定 `localhost`，不放進 Tripneeder 使用者端 UI。安全邊界是專案資料夾與 `.env` 內的 server-side key 只由專案持有人保管。
