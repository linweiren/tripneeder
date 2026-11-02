# TripNeeder 天氣與旅人分享整合報告

日期：2026-11-02（Asia/Taipei）。整合分支：`codex/integrate-weather-community`。

基底是本機最新已提交 dev `6a4798f5b490b49d4e2e5c950cabd706a1d5b036`，合併來源為 `fix/weather-integration` 的 `ab2fae8e40ba3392644ce4c87009bbbbe8dea2ed`，包含 origin/weather `a8ce99c`。使用新的獨立 worktree，未改動 dev、main、weather 或修補分支。

**結論：本機程式整合與測試門檻通過，可進入審查後合併回 dev；尚未授權發布，也不代表正式服務已完成驗收。** 原工作區有重疊檔案的未提交修改，合併前須先由使用者保存／提交並協調這些內容，不能直接覆蓋。本輪沒有操作原工作區的修改。

## 修補提交審查

已檢視 ab2fae8 的 SQL、共享資料驗證、快取、權限與歷史帳目顯示，未發現明顯資料破壞或安全退步。舊分享、互動與交通原始 JSON 留存於受限資料表，公開 feed 套用允許欄位及有效性檢查。升級不自動刪除或去重，函式型別轉換不使用 CASCADE。分享獎勵持續停用，舊交易只恢復可讀標籤。019 為向前修補，無法復原歷史上已經刪掉的資料。

使用者先前已確認 011～018 尚未部署。本輪沒有變更這項資料政策，也沒有執行任何正式 SQL。

## 衝突及處理

Git 實際產生 **9 個衝突檔案、24 個區塊**。逐區塊結合兩側邏輯，未使用整檔 ours/theirs 覆蓋。

| 衝突檔 | 區塊 | 解法 |
| --- | ---: | --- |
| `api/generate-trip.ts` | 4 | 保留 dev 的 claim/complete/fail、generationId、原子扣點、預覽及所有推薦品質流程；接上 weather 輸入／座標防護與 IP／使用者限流。完成或執行中的生成直接恢復，不新增配額消耗；限流拒絕會釋放本次 fenced lease 且不扣點。 |
| `api/generate-trip-details.ts` | 6 | 保留 dev 的認證、行程身分、文字一致性、雨備與交通改善，加入型別驗證及限流。詳情不新增扣點。 |
| `api/geocode.ts` | 2 | 保留 dev 的免費登入驗證先於付費查詢、OPTIONS 及無快取規則；結合 weather 的座標／地址格式與台灣地址限制，回傳 city、lat、lng。 |
| `api/get-candidates.ts` | 2 | 使用 dev 的同一登入驗證與 Places 核心，加入資料大小／座標驗證及限流，不重複驗證身分。 |
| `api/recompute-routes.ts` | 3 | 保留 dev 的 Routes 修復，結合 weather 站點／交通型別驗證與限流。 |
| `package.json` | 1 | 同時保留 dev 的 test 入口、完整單元回歸與 weather 原生 SQL 測試命令，合併測試相依套件。 |
| `src/contexts/AnalysisSessionContext.tsx` | 2 | 保留 dev 的登入 token、生成恢復、取消／重試及 Session；共享詳情使用獨立快取與身分，不呼叫付費詳情或寫回觀看者的歷史／收藏。 |
| `src/pages/HomePage.tsx` | 1 | 保留 dev 的有驗證反查與表單，加入組員天氣側欄及 GPS 名稱重設。 |
| `src/pages/ResultsPage.tsx` | 3 | 保留 dev 的實際交付數量、方案排序、預算提示及導覽，加入分享按鈕與原輸入傳遞。 |

推薦輔助模組、prompts、生成客戶端、generationInput、generation Session 保存與 `api/trip-generations.ts` 均沿用 dev，沒有調整推薦公式、門檻、候選分類或 repair 政策。生成 API 內的變更限於邊界驗證、有效座標判斷與限流等整合保護。

## 跨版本修正與保留功能

- 新增共同地理查詢 adapter，首頁原反查與天氣 GPS／地址查詢都傳送登入 token。沒有登入時不呼叫付費地理端點，失敗時保留 GPS 座標。實測前端 adapter → 真實 geocode handler → mocked Auth／Google 回應，座標及地址均成功；錯誤 token 不會接觸付費供應商。
- 天氣資料與生成流程獨立。天氣失敗只顯示區塊錯誤，行程表單仍可使用。保留首頁儀表板、行程詳情觀測／預報與空氣品質選用能力。
- 保留分享、我的分享、留言、按讚、取消公開、刪除／檢舉留言、收藏分享與登入導向。修正分享對話框受結果卡片 transform／堆疊遮擋，改為 portal；未移除功能來迴避整合。
- 詳情頁與 Session 共用身分計算，既有收藏／歷史 key 不變，分享另加 share ID + plan ID。分享完整資料不會啟動付費詳情補全或更新他人紀錄。
- 分享狀態快取按使用者區分，切換帳號不沿用上一個人的已分享狀態。SQL 及 JSON 保護完整保留。
- Git 版本讀取支援一般 checkout、worktree gitdir／commondir、detached HEAD 與 packed refs，不再直接假定 `.git/HEAD` 是檔案。既有驗收紀錄與完整回歸因此可在 worktree 正確執行。
- 限流 RPC 呼叫納入既有驗收紀錄。舊版比較僅排除明確新增的認證、配額及保存請求，Google／OpenAI 與推薦資料仍做原本的精確比對；另有配額拒絕、lease 釋放與已完成恢復的專門測試。

## 最終測試

| 項目 | 結果 |
| --- | --- |
| 全部單元及回歸 | **1,767 項：1,764 通過、0 失敗、3 跳過**。 |
| TypeScript | `tsc -b` 通過；production build 再次包含此步驟。 |
| Lint | 通過，0 警告／錯誤。 |
| Build | 通過。 |
| 原生 PostgreSQL 17.11 | **26／26 通過**，新建專用叢集 `127.0.0.1:56590`，每情境獨立資料庫。 |
| 真實元件與完整 App 的離線瀏覽器流程 | **11／11 通過，0 pageerror**，所有外部流量攔截，使用假 Auth、RPC 與天氣回應。 |
| 格式與衝突標記 | `git diff --check` 通過，無未解決衝突。 |
| 原工作區保全 | **104 個原有修改／未追蹤檔案 SHA-256 全部相同**，status 不變；dev、main、weather、fix/weather-integration 指標均未變。 |

3 個 skip 是 dev 原有的可選調查快照測試（candidate availability／classification／quota consistency），快照不在已提交的 checkout；沒有新增 skip 或跳過整合失敗。其餘回歸包含實際生成、去重交付、恢復、失敗不扣點、一次生成一次扣點、詳情、驗收紀錄、推薦品質及收藏刪除過濾。

原生 SQL 執行整合 checkout 全部 001～019 + dev 三個時間戳 Migration，以及歷史分段升級、異常 JSON、原始資料／交通／帳本保全、兩種套用順序、舊獎勵停止、正常扣點、ACL、相依造成失敗的完整回滾與兩條連線並發分享。原生測試資料庫已清除、專用叢集已關閉。

瀏覽器測試走完整 App／router／Auth／Session：首頁 GPS、手動天氣地址搜尋、天氣故障隔離、兩方案交付與分享、發布分享後進入詳情、分享時間／交通、留言及按讚、同 plan 不同 share 切換、收藏、取消公開，以及確認分享／天氣不啟動生成或詳情付費 API。資料庫端授權與持久化另由 SQL 實測覆蓋。並非真實 OAuth／CWA／正式 Supabase 串接。

證據檔保留於此 worktree 上一層 `C:/Users/wr124/Projects/tripneeder/.tmp/weather-dev-integration/`：`conflicts.json`、`unit-tests.log`、`typescript.log`、`lint.log`、`build.log`、`sql-native.log`、`bridge-final.log`、`browser-results.json`、`browser-tests.mjs`、`browser-final.png`、`preservation-results.json`。第一輪失敗紀錄另存 `unit-first.log`，未用其結果作為通過證據。

## 環境與部署前事項

| 設定 | 需求 |
| --- | --- |
| `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` | 瀏覽器公開設定。 |
| `SUPABASE_URL`、`SUPABASE_ANON_KEY` | 伺服器認證，原有公開別名可作 fallback。 |
| `SUPABASE_SERVICE_ROLE_KEY` | **dev 的生成 Session／恢復與原子扣點保存必需**；也提供持久限流。只有限流可以退回單執行個體備援。 |
| `OPENAI_API_KEY`、`GOOGLE_PLACES_API_KEY` | 沿用既有生成、Places、Geocoding、Routes，皆僅 server-side。本輪全部 mock。 |
| `CWA_API_KEY` | 天氣觀測與預報所需，僅 server-side；缺少時天氣顯示錯誤、生成不受影響。 |
| `MOENV_API_KEY` | 空氣品質選用；缺少時天氣仍可顯示。 |

已更正 README、部署清單與 .env.example 將 service role 誤列為可選的跨版本敘述。CI 增加 dev 分支與原生 PostgreSQL；本輪未 Push，故未執行遠端 CI。

正式部署仍須：

1. 保存並審查原工作區尚未提交的顯示名稱等修改，再安全合併 dev；沒有把這些未提交內容偷偷混入整合。
2. 取得正式 Migration history、備份／還原點與待套用順序；在備份複本演練後依 [升級路徑](weather-integration-upgrade.md) 審核。不能因為 011～019 數字較小而重播已部署的 dev 時間戳 SQL，也不能擅改 history。
3. 確認 Development／Preview 使用獨立、正確的 server-only 設定與資料庫權限，驗證真實 OAuth、CWA、MOENV、Supabase 與正式打包後的深連結／恢復流程。部署與付費驗證需另外授權。
4. 取得歷史 CWA 金鑰已撤銷／替換的證據；本輪未使用、顯示或撤銷金鑰。Git 歷史未改寫。
5. 持久限流故障時仍會退回程序內備援，不保證跨 instance 的共享額度；確認這個既有可用性策略符合發布要求。

本輪未 Push、部署、操作正式 Supabase、呼叫付費 API、修改 main 或清理原工作區資料。
