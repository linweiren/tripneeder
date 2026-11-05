# Weather RPC 權限修正與正式升級門檻

日期：2026-11-04。基底：`e36195c`；修復分支：`codex/fix-weather-rpc-acl`。

## 原因與修正範圍

前次 21 組驗收的兩個失敗群組分別是：功能／安全驗收 9 個子項中 2 項失敗，以及 11 個 RPC 簽章權限矩陣中 8 項失敗。兩者均受正式備份中的函式預設權限影響：`postgres` 建立函式時，`anon`、`authenticated`、`service_role` 會取得明確的 EXECUTE。只撤銷 PUBLIC，無法移除其他角色的明確授權。七個分享 RPC 的內部驗證會阻止匿名寫入，但其 EXECUTE 仍不符合預期；限流 RPC 沒有內部使用者驗證，因此匿名／一般登入角色可實際寫入限流桶。

新增 `20261104075000_weather_rpc_execute_acl.sql`，不改寫任何已存在的 Migration、函式內容、資料、全域預設權限或角色關係。依目前程式中的呼叫來源設定：

| 函式 | anon | authenticated | service_role | 呼叫來源 |
| --- | --- | --- | --- | --- |
| `consume_api_rate_limit(text,integer,integer)` | 拒絕 | 拒絕 | 允許 | `api/_lib/request-guards.ts`，伺服器憑證 |
| `share_trip(jsonb,jsonb,text[])` | 拒絕 | 允許 | 拒絕 | 登入後的 communityService |
| `unshare_trip(uuid)` | 拒絕 | 允許 | 拒絕 | 同上 |
| `toggle_shared_trip_like(uuid)` | 拒絕 | 允許 | 拒絕 | 同上 |
| `add_shared_trip_comment(uuid,text)` | 拒絕 | 允許 | 拒絕 | 同上 |
| `delete_shared_trip_comment(uuid)` | 拒絕 | 允許 | 拒絕 | 同上 |
| `record_shared_trip_view(uuid)` | 拒絕 | 允許 | 拒絕 | 同上 |
| `report_shared_trip_comment(uuid,text)` | 拒絕 | 允許 | 拒絕 | 同上 |

這八個函式皆撤銷 PUBLIC。擁有者仍保有管理權限；PostgreSQL 超級使用者的固有權限無法以 ACL 排除。公開 feed、私人 helper、原子扣點、初始化、收藏與 LINE RPC 依原契約保留。

修補先檢查八個完整函式簽章，再撤銷／授權，最後用 `has_function_privilege` 驗證實際有效權限，並檢查未審查的直接授權。遇到未知授權、繼承權限或缺漏 schema 即失敗並回滾，不擅自撤銷其他角色或調整預設權限。廣泛的既有預設權限仍存在，後續新增／重建 RPC 必須在同一交易中明確設定 ACL；本次只修復這八個已審查函式。

## 正式備份隔離驗收

來源為 `supabase-production-20261104`，未連正式 Supabase。新證據存於專案外私人目錄 `C:\Users\wr124\TripNeeder-Backups\supabase-rpc-acl-fix-20261104`，未加入 Git。原備份 25 個頂層清單雜湊及全部 48 個檔案在演練前後均未變更。

隔離 PostgreSQL 17.11 以正式備份角色、權限、資料及 Migration 紀錄還原，基準確定為 001–010 加 `20261027103330`、`20261027111646`、`20261027220000`。只代表備份當時狀態，不宣稱目前線上狀態未變。

| 檢查 | 結果 |
| --- | --- |
| 正式備份隔離演練 | 27／27 組通過 |
| 原生 PostgreSQL 升級／異常舊資料／權限／併發矩陣 | 31／31 通過；包含於前述一組驗收，勿重複計數 |
| 分享、留言、按讚、取消分享、RLS、RPC、點數權限 | 9／9 子項通過；包含於演練一組 |
| 實際函式 EXECUTE 矩陣 | 11／11 簽章通過，涵蓋八個目標及 feed、helper、生成 RPC |
| 完整單元與回歸測試 | 1,784 項：1,781 通過、0 失敗、3 既有略過 |
| TypeScript、Lint、Build | 全部通過 |

3 個略過項目是缺少選用的 Central Park 本機調查快照，未計為通過；本次權限測試沒有略過。單元測試使用既有離線網路阻擋器，未呼叫付費 API。

16 個原角色及 19 個原角色關係均核對。43 個來源盤點資料表的 579 筆資料／RLS 旗標吻合；另外用 archive COPY 比對全部 45 個非 Vault 資料表。升級後除了新增 Migration 紀錄，原使用者、收藏、餘額、帳本及所有原表資料指紋保持一致；原有函式內容、擁有者、ACL、欄位、索引、政策與預設權限保持一致。

手動增加的 `profiles.line_user_id`、`profiles_line_user_id_key` 及 `bind_line_user`、`unbind_line_user`、`get_line_user_profile`、`consume_points_for_line_user` 完整保留。四個 LINE RPC 原先僅授權 service_role／擁有者，修補前後一致。使用合成使用者在升級前後實際驗證綁定、重複綁定拒絕、查詢、每次扣 20 點及帳本、餘額不足拒絕、解除綁定；測試全部回滾。這不代表真實 LINE OAuth／Webhook 已測試。

單檔、整批 SQL 遇到意外相依 view 時，DDL、ACL、資料與 Migration 歷史可完整回滾。也從未變更的原備份重新還原，得到相同基準指紋。011–019 與權限修補共十份 SQL 的單一交易成功路徑已驗證。修補重跑不改資料或函式內容；額外測試覆蓋不完整 schema、繼承權限、錯誤預設授權與修補失敗的交易回滾。

## 安全升級順序及尚未通過的門檻

1. 正式執行前另取得新備份，重新唯讀比對實際版本、手動 LINE 結構、相依物件及角色權限；本次禁止連正式環境，因此只確認現有備份。
2. 在相容 Supabase 測試環境完成下列真實認證及平台還原缺口，再核准正式執行方式。不可把目前結果當成完整 Supabase 還原成功。
3. 已確認 011–019 尚未部署的路徑：保留已套用的 13 筆歷史，在**同一交易**依序執行 011–019，接著執行 `20261104075000_weather_rpc_execute_acl.sql`，最後驗證有效 ACL 及資料指紋後才提交。Migration 紀錄須與 SQL 同交易寫入。不可在 015／019 與權限修補間先行提交並對 API 開放。
4. 若已有 011–019，先核對實際 schema／歷史並在其備份複本演練，只套用新修補，不重播舊檔。未知／部分部署版本立即停止。
5. 正式執行工具、舊數字版本落在時間戳歷史之前的排序、交易與歷史登記方式，仍須對指定版本 CLI／SQL 操作方式做最後審查；本次不執行 `db push`、`migration repair` 或修改正式歷史。不假設 CLI 會自動把十份檔案包成單一交易。
6. 失敗時停止並回滾；提交後有問題需另行批准備份還原，不以重播舊 SQL 或刪除資料回復。

目前**資料庫權限與資料保全門檻通過，尚未具備無條件正式升級資格**。未驗證項目：

- 缺 Docker／可用 Linux 環境；此 Windows 主機無法執行受支援的完整原生 Supabase stack。官方 Windows 本機方案使用 Docker：[Supabase runtime 說明](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)。沒有安裝或改動系統服務。
- Auth／PostgREST 尚未實際啟動。SQL 測試使用還原的 `auth.uid`／`auth.jwt` 及角色切換／合成 claims，沒有驗證 JWT 簽章、到期／無效 token、Auth 登入／更新 session、HTTP schema cache 或正式 OAuth。仍需在隔離 Supabase 環境驗證匿名公開讀取、匿名寫入拒絕、登入分享／留言／收藏、service_role 限流、無效／過期 token 拒絕與登入生成／恢復／僅扣點一次。PostgREST 的有效 JWT 才會決定實際資料庫角色：[官方認證契約](https://github.com/PostgREST/postgrest/blob/main/docs/references/auth.rst)。
- 缺 `supabase_vault` 0.3.1；還原排除 10 個 Vault archive 項目，未驗證 Vault 解密／平台金鑰。完整 Vault 資料仍保留在原備份。其餘非 Vault 還原及權限核對通過，不等於完整平台可還原。
- 原 `pg_dump` 未捕捉資料庫層級 owner／ACL，不能宣稱與正式資料庫完全一致；原平台網路服務、LINE OAuth／Webhook、CWA 實網尚未測試。

未改 main／dev、未 Push、未部署、未執行正式 SQL；未修改推薦核心；原 WIP 104 檔案已逐一比對雜湊，完全未變。
