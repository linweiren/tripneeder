# 初始贈點併發安全修復 v1

日期：2026-10-27（Asia/Taipei）。基準：本機 dev `c5e83a595aea6329c0b220cf8bb9fe2cf89b9434`。本輪未 Commit、Push、Merge、Deploy，未連正式 Supabase、未執行正式 SQL 或修改 Migration History，未處理 SSE 扣點。

## 結論及實際重現

**已確認可重現的重複贈點，是「既有 Profile 且 has_received_initial_points=false」的併發初始化。** 這不是只靠靜態分析推測：本輪取得免費的原生 PostgreSQL 17.11 Windows binaries，以八個不同 PostgreSQL backend PID 的 TCP 連線直接呼叫原版 `initialize_user_profile()`。

| 原始情境 | 併發請求 | 修復前實測 | 修復後實測 |
| --- | --- | --- | --- |
| 既有 Profile，餘額 7、旗標 false | 8 | 8 次成功；餘額 **807**；8 筆 initial | 8 次成功；餘額 **107**；1 筆 initial |
| auth.users 已有帳號，尚無 Profile | 8 | 1 次成功、7 次 `23505` 主鍵錯誤；100 點、1 筆 initial | 8 次全部成功；100 點、1 筆 initial |
| 既有已領點 Profile，餘額 42、旗標 true | 8 | 8 次成功；42 點、不新增 initial | 8 次成功；42 點、不新增 initial |

第二列表示資料庫主鍵已阻止全新 Profile 重複建立與贈點，不能把它描述成已重現重複領點；但原 RPC 未讓所有併發呼叫正常返回。第三列也沒有再次領點。

測試使用監控連線持有 Profile row lock（既有 Profile）或 SHARE table lock（尚無 Profile），等到 `pg_stat_activity` 證明八個 RPC 都在等待資料庫鎖後才釋放。row lock 不阻止原版的普通 SELECT，table lock 不阻止其初始 SELECT、只阻止 INSERT；因此能在**不改寫原函式、不在函式注入 sleep** 的前提下固定觸發順序。所有查詢採 `SELECT * FROM public.initialize_user_profile()`，每次查詢只呼叫一次 RPC。

這證明資料庫層確實存在可達的競態，**不代表正式環境已有受影響帳號，或所有新註冊帳號都會重複領點**。本輪沒有查詢正式旗標分布、交易紀錄或真實帳號。

## 根因與呼叫來源

`008_fix_initial_points_logic.sql` 的流程是：

1. 無鎖 SELECT 將 `has_received_initial_points` 讀入區域變數。
2. 旗標為 false 時執行 `UPDATE ... SET points_balance=points_balance+100, has_received_initial_points=true WHERE id=current_user_id`。
3. 不論其他連線是否已領點，該分支都新增 initial 交易。

在 Read Committed 下，八個連線可先各自讀到 false，再排隊更新同一列。PostgreSQL 會在前一個更新提交後使用最新資料列重新判斷 UPDATE 的 WHERE；但是既有 WHERE **只有 id，沒有領點旗標**，所以每個連線都繼續 +100。把旗標寫成 true、RLS 或上輪的直接寫入 ACL 限制都無法保護這個已獲授權的 SECURITY DEFINER 分支。參考：[PostgreSQL Read Committed 與 UPDATE 行為](https://www.postgresql.org/docs/17/transaction-iso.html)。

呼叫來源檢查：

- `src/contexts/AuthContext.tsx` 取得 session、監聽 auth state 並設定 user；沒有跨請求的資料庫互斥機制。
- `src/pages/HomePage.tsx` 在 user effect 呼叫初始化；`PersonaPage.tsx` 的載入／儲存／重設流程也呼叫初始化。
- `src/services/points/pointsService.ts` 的 `initializeUserProfile()` 直接呼叫 RPC；`loadPointsSnapshot()` 與 `getMyPointsBalance()` 也經過它，沒有共享的 in-flight promise。
- `api/generate-trip.ts` 的 `getAvailablePoints()` 在讀餘額前再次初始化。

這些入口、不同分頁或直接 RPC 都可能形成並行請求。不能只靠單一頁面的前端去重保證一次贈點。本輪沒有修改前端、API handler、登入或 SSE 流程。

原有測試使用單連線 PGlite，已涵蓋依序初始化、初始紀錄被清理後不再贈點；其報告也明確指出未實測並行競態。本輪補上真正多連線原生 PostgreSQL 測試。

## 最小修正

新增 **`supabase/migrations/20261027111646_initial_points_concurrency.sql`**，不修改任何已部署的舊 Migration。

新 Migration 在交易中 `CREATE OR REPLACE FUNCTION public.initialize_user_profile()`，保留 migration 008 的原函式本文，只在「已驗證 auth.uid() 非空」之後、「讀取領點旗標」之前新增：

```sql
perform pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('tripneeder:initialize_user_profile:' || current_user_id::text, 0)
);
```

這是依帳號 UUID 取得的交易範圍 advisory lock，同帳號第二個初始化必須等第一個交易提交或回滾，再讀取旗標。Profile 尚未存在也能取得鎖，避免只鎖現有資料列時仍留下新帳號競態。交易結束自動釋放，錯誤不會留下 session lock。不同 UUID 通常不互相等待；雜湊碰撞最多造成額外序列化，不會額外贈點。參考：[PostgreSQL advisory lock](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)、[transaction lock 函式](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)。

不改贈點額度、旗標語意、ledger 寫入與 retention trigger、service_role 管理器、20／2 點扣款、函式參數／回傳型別／owner／SECURITY DEFINER／search_path／EXECUTE ACL；不新增資料表、索引、RLS policy 或角色授權。初始化的 Profile、餘額、旗標及 ledger 仍屬同一筆交易。新 Migration 自身保留 BEGIN／COMMIT 與 5 秒 lock_timeout。

採此方式是為了保留既有三個初始化分支，避免為修復已確認的併發問題同時重寫贈點流程。鎖只協調這個 RPC 的初始化；它不阻止已獲授權管理員手動重設旗標，也不自動修復過去已多領的點數。

`has_received_initial_points` 在現有 Schema 仍可為 NULL；原函式會把既有 NULL 誤走「新 Profile」分支而撞主鍵。這是不同的既有資料異常路徑，本輪不替 NULL 推斷領點資格、不批次改資料，也沒有將此狀態宣稱為已修復。更高隔離等級下 PostgreSQL 可能要求整筆交易重試；本次成功返回的併發測試以預設 Read Committed 為範圍。

## 版本選擇與發布前檢查

版本 `20261027111646` 取自本輪 UTC 時間，排序在已提交的 ACL 版本 `20261027103330` 後。重新唯讀檢查 GitHub dev、main、weather 目錄與本機參照：dev/main 為 001–010，weather 仍使用 011–018，未發現本次時間戳衝突或額外保留版本。未占用、改寫或套用組員 Migration。

未來正式發布前仍須另行核准並檢查：

- 使用 `supabase migration list` 比對本機與遠端 Migration History；SQL Editor 修補過 ACL 不等於已記錄版本。
- 使用 `supabase db push --dry-run` 核對完整待執行清單。
- 特別核對尚未整合的 011–017、遠端分支 018、ACL 時間戳版本及本次初始化時間戳版本的順序。
- 不得因順序問題自行套用組員未完成或未核准的功能 Migration，不得直接修改正式 history 或盲目用 `--include-all`。
- 正式切換時需讓已在執行的舊版初始化交易結束，避免尚未取得 advisory lock 的舊函式呼叫與新版混跑。
- 本輪僅保留上述檢查，不連正式、不處理歷史差異，也不預設原生 PostgreSQL 測試等於已完成 Supabase CLI 部署驗證。

## 免費本機測試結果

環境：**原生 PostgreSQL 17.11、Windows x64、Read Committed、node-postgres 8.16.3**。僅監聽 `127.0.0.1:55439`；使用獨立新建的測試資料庫、假 UUID／電子郵件，沒有讀取 .env、正式帳號、API Key 或付費 API。Supabase 管理的 auth schema helper、roles 與預設 grants 在測試庫中模擬建立；原始 dev migrations 001–010 與已提交 ACL Migration 則原樣依序執行。

**20／20 PASS**：4 項修復前基準／重現，16 項修復後驗證；詳見 `initial-points-concurrency-v1-results.json`。包括：

- 真正的八連線並行：新 Profile、legacy false、已領點 true 三種狀態。
- 首次初始化、連續重複、無 UID 拒絕、不同使用者可獨立完成。
- 新／舊 Profile 在明確 ROLLBACK 後不留下 Profile／旗標／餘額／ledger 變更，重試只贈一次。
- 人工注入 ledger BEFORE INSERT 失敗：新／舊 Profile 整筆還原；移除故障後可領一次。
- 第一個初始化交易尚未提交時，其他連線看不到半套 Profile／ledger；第一個交易回滾後，等待中的同帳號初始化可正常贈一次。
- 人設儲存與重設、service_role 修改其他帳號及寫入 ledger、20 點與 2 點扣款及餘額查詢。
- 超過 retention 門檻只保留 30 筆，initial 交易被清掉後並行初始化不再次贈點。
- 新 Migration 前後完整表級／欄位級／函式 ACL 相同，其他函式、RLS／policies、欄位、constraints、triggers 不變；函式 OID／owner／SECURITY DEFINER／search_path 不變；Migration 可重複套用。
- authenticated 僅可更新八個人設欄位，直接改點數／領點旗標、DELETE、UPSERT 或偽造 ledger 均拒絕；跨帳號人設仍受 RLS 隔離。

測試沒有使用 PGlite 假裝多連線，也沒有呼叫 HTTP 管理器、PostgREST 或真實 JWT 驗章；本輪原生測試不套用組員 011–018。應用程式未變更，因此未跑付費 API 或全站生成流程。

可重跑腳本（須先啟動專用、可拋棄的本機 PostgreSQL，預設 port 55439；不接受遠端連線 URL）：

```powershell
node scripts/security/test-initial-points-concurrency-v1.mjs
```

免費 driver 安裝位置與可選參數：

```powershell
npm install --prefix .tmp/initial-points-concurrency-v1/runtime --no-audit --no-fund --ignore-scripts pg@8.16.3
node scripts/security/test-initial-points-concurrency-v1.mjs --port 55439 --driver .tmp/initial-points-concurrency-v1/runtime/node_modules/pg/lib/index.js --report .tmp/initial-points-concurrency-v1/rerun-results.json
```

腳本會建立唯一命名的 `initial_points_before_*`／`initial_points_after_*` 資料庫，不重設或刪除既有資料庫。測試 RPC 皆以 authenticated／anon／service_role 切換執行；bootstrap 及測試屏障使用本機 postgres 管理連線。請勿將此測試 bootstrap 放到正式資料庫。

本輪 PostgreSQL binaries 來源：[EDB 官方下載](https://www.enterprisedb.com/download-postgresql-binaries)。ZIP `postgresql-17.11-3-windows-x64-binaries.zip` SHA-256 與供應方公布值相符：`4b8db0930c38f6ef845db919551dedda3b6b845aeb0927b3d79a6e8e9e4537cf`。來源與 binaries、driver、測試庫皆留在本輪 `.tmp/initial-points-concurrency-v1/`，不列入建議提交；沒有安裝系統服務或修改專案 dependencies／lockfile。參考：[EDB checksum 回覆](https://github.com/EnterpriseDB/edb-installers/issues/682)。

測試完成後已停止本輪專用 PostgreSQL 程序，保留測試證據與暫存資料。

## 交付及建議

建議審閱後 Commit 以下四個檔案：

- `supabase/migrations/20261027111646_initial_points_concurrency.sql`
- `scripts/security/test-initial-points-concurrency-v1.mjs`
- `docs/security/initial-points-concurrency-v1.md`
- `docs/security/initial-points-concurrency-v1-results.json`

不要使用 `git add .`。本輪保留原有研究檔案及正式 rollback 備份，未更改上輪 ACL Migration／測試／報告、舊 Migration、組員 Migration 或 .gitignore。沒有以 ledger 的永久唯一索引當作領點防線，因為現有 retention 會清除舊 initial 紀錄；防線仍是 Profile 的持久旗標與 RPC 交易鎖。
