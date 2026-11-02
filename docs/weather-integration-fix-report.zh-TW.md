# TripNeeder weather 修復交接

日期：2026-11-02（Asia/Taipei）。基底：`a8ce99cf277c34601a340cd7356e3e38df61eb51`。修復分支：`fix/weather-integration`。

**本輪 SQL 升級與分享資料阻擋已修正並通過隔離測試；尚未達到與最新版 dev 完整整合／發布的條件。** 未執行合併、Push、部署或正式 Supabase 操作；推薦核心、生成處理器與畫面均未修改。

## 修復內容

- 使用者已明確確認 011～018 全部尚未部署，因此可修正其中的危險邏輯。保留原始歷史 SQL 作為唯測試用途的固定 fixtures，另新增 019 作為已部署歷史結構的向前修補。
- 在 013 起移除舊唯一內容索引，改成非唯一查找索引。所有舊分享 ID、重複分享、互動與原始 JSON 都保留，不做自動去重或資料清洗寫回。
- 防護 JSON null、object 代替陣列、錯誤數值／布林、重複 stop ID 與交通引用。公開 feed 只投影允許欄位，原始表拒絕匿名／一般使用者查詢。異常或未完成分享不公開，資料仍留存。
- 不再由升級清空交通段。主行程與雨備均保留原始交通資料，公開版本重新對應安全 stop ID，保留合法時間與交通模式。
- RPC 回傳型別改變時，以精確 signature 的 DROP／重建與授權處理，禁用 CASCADE。019 可重跑；非預期相依物件會讓交易失敗並完整回滾。
- 分享寫入以擁有者 advisory lock 序列化，比較正規化內容後回傳最早既有分享，避免並發重複新增，也不刪除既有重複分享。
- 前端驗證時間僅接受合法 HH:mm、null 或省略。分享快取同樣驗證，異常 JSON 不會進入詳情。googleTypes、空值、時間與公開交通經真實 SQL 讀回後有一致 signature。留言也驗證型別後才交給畫面。
- 分享獎勵持續停用。舊帳本 share_reward 的顯示名稱恢復為「歷史分享獎勵」，不新增獎勵、不回溯改餘額或帳本。

## 修改檔案

| 類別 | 檔案 |
| --- | --- |
| SQL | `012_community_discussions_and_filters.sql`、`013_community_privacy_controls.sql`、`014_shared_trip_access_and_privacy.sql`、`016_community_hardening_and_pagination.sql`、`017_shared_trip_validation_and_completion.sql`、`018_preserve_shared_interactions_and_transport.sql`、新增 `019_weather_integration_forward_repair.sql`，均在 `supabase/migrations/`。011、015 不需改動，完整鏈仍包含其原檔實測。 |
| 分享／快取 | `src/services/community/communityData.ts`、`communityService.ts`、`src/utils/tripPlanStorage.ts`。 |
| 歷史帳目顯示 | `src/services/points/pointsService.ts`，僅恢復歷史交易型別與名稱。 |
| 測試與 CI | `tests/unit/community-migration-compatibility.test.mjs`、`community-migration-postgres.test.mjs`、`community-sharing-safety.test.mjs`；新增 `tests/fixtures/weather-upgrade-cases.mjs`、`offline-network-guard.mjs`、`weather-legacy/` 與 `dev-points/` 固定 SQL；新增 `scripts/test-weather-postgres.mjs`；`package.json`、`package-lock.json`、`.github/workflows/ci.yml`。 |
| 交接文件 | 本文件、`docs/weather-integration-upgrade.md`、fixtures README。 |

## 驗證結果

| 項目 | 結果 |
| --- | --- |
| 完整單元／回歸（含 PGlite 完整 SQL） | **151／151 通過，0 skip**。保留原有全部測試，擴充完整升級與異常資料案例。 |
| 原生 PostgreSQL 17.11 | **25／25 通過**；獨立新建叢集、固定 loopback、每情境獨立資料庫。 |
| TypeScript | `tsc -b` 通過，Build 亦再次包含 TypeScript。 |
| Lint | 通過。 |
| Build | 通過。 |
| 格式檢查 | `git diff --check` 通過。 |
| 原工作區 | 104 個原有已修改／未追蹤檔案 SHA-256 全部一致，原工作區 status 不變；dev、main、weather 的既有本機分支指標未變。 |

原生測試包括完整 001～019、修正版 011～018 每個階段起升級、舊 de069c6 的 011～017 每個階段起升級、歷史 016／017 直接升 019、a8ce99c 已套用 018 後只升 019；每階段插入 16 種有效／異常舊行程，逐次比對分享、互動、交通原文及點數帳本。另測 89 組前後端 JSON 契約、11 人按讚無獎勵、正常扣點、dev 三個點數 Migration 的兩種順序、ACL、兩條真實連線並發、函式相依造成失敗時 DDL／ACL／資料回滾，以及合法新分享不會誤用到隱藏的異常舊分享 ID。

單元測試預設封鎖未 mock 網路並移除憑證環境變數；原生測試不讀取 .env 或 Supabase 設定。免費下載的 pg 僅為開發測試相依套件。未呼叫付費 API。原生測試建立的資料庫已清除，專用叢集於交接前關閉。

實測記錄位於 worktree 的上一層：`unit-tests.log`、`sql-native.log`、`typescript.log`、`lint.log`、`build.log`、`preservation-results.json`。可重現方式與已部署／尚未部署升級路徑見 [升級文件](weather-integration-upgrade.md)。

## 整合判斷與剩餘風險

**SQL 與分享修補可進入審查；不可據此直接把整個 weather 覆蓋到 dev 或發布。**

1. 此分支依要求從 weather 建立，沒有實際整合 dev。先前驗收指出的 8 個文字衝突、地理查詢認證／地址格式差異、generationId 與生成恢復協定差異仍須在後續 dev 整合處理；本輪不以替換推薦核心解決這些問題。SQL 的點數相容測試不代表整個產品流程已整合驗收。
2. 正式部署前仍須確認實際 migration history、備份與待套用順序。若後續發現有人已執行歷史 SQL，應依版本採向前升級，不重播破壞性舊檔，也不自行修改 migration history。使用者目前確認尚未部署。
3. 已遭舊 Migration 刪除的分享／互動／交通不能由 019 憑空復原；需要備份與明確復原政策。本輪只保留仍存在的資料。未決定異常資料清理、重複分享合併或保留期限。
4. 原始舊 plan/input 仍存於受限資料表；這是保全原始資料的結果。若要真正刪除歷史敏感欄位，須另行決定並審核。一般公開 feed 不回傳這些欄位。
5. 未做真實 OAuth／CWA／正式 Supabase 串接。CWA 歷史金鑰撤銷狀態仍未取得證據；原有程序內限流備援仍無跨執行個體共享能力。這些既有風險沒有因本輪 SQL 測試而消失。
