# 可行方案保底 v1：最小實作判斷與防過度篩選驗收

日期：2026-10-26（Asia/Taipei）。基準仍為本機 `dev / bc246d25fd189298c452bcfafdbd6324d8d9fd1c`。

## 結論

**本輪不新增正式保底系統。僅提交回歸測試與必要驗收文件，鎖定既有保護行為。**

本次從完整 Repair、可選後處理與最終接受階段檢查，未能重現「現有保護不足，導致已完整驗證且可交付的方案，只因非必要優化而消失」的案例。已建立的失敗 trial 都被現有機制保護，因此不新增 Map、checkpoint 資格判斷、快取失效協調或另一套 Repair。

這是有範圍的驗收結論，不是所有可能輸入均無缺陷的證明。也沒有擴大研究 Retry／Refill 來源覆寫、跨請求快取新鮮度或 Coverage v2 正式交付。

## 實際檢查的保護與未修改原因

| 程式位置 | 實際行為與驗收 | 決定 |
| --- | --- | --- |
| `api/generate-trip.ts:1880` `repairAndValidatePlanForDelivery` | core 成功後才進停留重分配；comparison 失敗呼叫 `finish(result)`。新增測試在真實拒絕事件保存完整 before 快照，確認最後 plan 就是同一個 before 物件，所有欄位完整相等。 | 已有局部原結果保護，不新增保存系統。 |
| `api/_lib/trip-stop-duration-quality.ts:38` `proposeStopDurationRedistribution` | 建立新 stops 陣列及新 stop 物件；不原地更改來源。duration-only trial 使用原路段陣列作唯讀證據，不改其內容。 | 新增不可變性與完整回傳斷言；不因唯讀共享而重寫既有快取。 |
| `api/_lib/trip-stop-duration-quality.ts:77` `getDurationRedistributionIssues` | 拒絕營業／closing buffer、餐窗、容量、Coverage、身分及路段變更；路段重用另受可信 static memo 限制。 | 原驗證保留；非法 trial 不取得採用資格。 |
| `api/generate-trip.ts:2042` `restoreOptionalLoss` | 可選替換失敗時，最多一次完整 diversity fallback；fallback 仍須通過原交付檢查與 Routes。新增三種 trial 失敗：營業、容量與路段無法解析，都選回完整合法方案。 | Optional Activity Protection v1 不改。 |
| `api/generate-trip.ts:1680` 補站整體比較 | 既有 skip-supplement 比較會保留必要修復，避免可選補站以原活動損失換資格。 | 沿用原專項及完整 Unit Tests，不包第二層相同 Repair。 |
| `api/generate-trip.ts:1942` `repairPlanVisitRequirements` | 從 selected=plan 開始，只有合法且保住已滿需求的 trial 才更新；沒有合格 trial 時返回 selected。 | 沿用 Q2／Q3／Q6 等原有驗收，不加新的拒交條件。 |
| handler `generate-trip.ts:714,742,763,950` | 成功風格加入最終結果，Refill 僅針對缺風格，部分失敗不抹掉成功風格；全失敗維持既有 error 分支。 | 原身分／三風格專項及本輪混合結果測試通過；不改 Retry／Refill。 |

需求或交通確實改善的兩個正向案例仍採用替換場館，沒有無條件偏好原案。新增測試也確認：較晚處理的風格成功／失敗，不會改動先前已得到的完整結果。

## 新增測試與證據界線

新增 `tests/unit/feasible-plan-protection.test.mjs`，共 **19 項測試（18 個具體函式執行、含 1 個三風格父測試）**。使用正式 `repairAndValidatePlanForDelivery` 與既有 tracked Fixture，沒有替換 optimizer、注入假的成功結果或複製 Repair 實作。

覆蓋：

1. Safe／Balanced／Explore 各自遇 closing-buffer trial 失敗，返回完整已驗證原結果，且保留同一 plan 物件。
2. 午餐衝突的重分配失敗，完整保留時間、路段、活動及其他欄位；失敗後不新增 Repair 或遠端檢查。
3. 可選換站遇營業、容量或路段失敗，完整 diversity fallback 正確，沒有只回復 placeId 卻混用新路段。
4. 有可信交通增益或已確認需求增益時，仍採用合法新場館。
5. AI 宣告的分鐘及路段不是可信交通證據；真實 resolver 在 Mock 邊界重新解析路段，不直接以 raw plan 當交付結果。
6. 原來源的營業、容量、餐期、Coverage 不能通過時，沒有回復原來源冒充完整成功。
7. Routes 失敗仍帶 routesFailed 與估算標記，不能計為 complete；沒有把既有可回傳警告結果改成新增拒交。
8. Safe 保留原結果、Balanced 採用重分配、Explore 容量失敗的同組混合結果互不干擾。
9. 失敗路徑 Repair 有界、相同 edge 在同一 context 只解析一次；來源及共享候選資料在 trial 前後完整相等。

「新可靠證據」負向案例使用候選仍顯示可訪、但後續 Mock Details 已確認關門的衝突，測試不會盲目信任原草稿。沒有聲稱本輪新增了跨請求證據更新或長期保存憑證；若要求完整的跨請求失效協調，已超出此次最小範圍。

Q2 明確需求、Q3 禁咖啡、Q6 夜間替代、Optional 原有正反例、補站回退、缺風格及全失敗 handler，均由現有專項與完整套件繼續驗收，未複製其 Fixture 或修改既有期望值。

本輪沒有產品修正的「舊版失敗、新版通過」案例。新增斷言在未修改的 HEAD 即通過。最初測試試跑曾因靜態 import 早於 Mock API key 設定而未啟用 Places 驗證；已改成先設環境再載入應用模組，並以實際 Places 次數確認。這屬於測試初始化修正，不算產品缺陷修復或挽回方案。

## 方案數、品質與成本前後比較

逐案診斷由新增測試的 `t.diagnostic()` 產生，不需要讀取另存的研究 JSON。比較是「未修改 HEAD 的純 tracked 原始碼快照＋新增測試」對「工作區相同函式＋新增測試」，逐案診斷深度相等；不是不同正式版本的品質實驗。先前另存的 results JSON 保留於本機，不納入本次提交。

| 指標：18 個函式案例 | HEAD 快照 | 工作區 | 差額 |
| --- | ---: | ---: | ---: |
| 回傳 plan 物件 | 13 | 13 | 0 |
| 影子 complete 且 Routes 未失敗 | 12 | 12 | 0 |
| 回傳但 Routes 未驗證的控制 | 1 | 1 | 0 |
| 無 plan | 5 | 5 | 0 |
| 正常成功案例的必要違規 | 0 | 0 | 0 |
| 原活動影響（每案 identity／removed／stay／purpose） | 逐案記錄 | 逐案相等 | 0 |
| Mock Places | 56 | 56 | 0 |
| Mock Routes | 55 | 55 | 0 |
| Mock AI | 0 | 0 | 0 |
| Repair 進入次數 | 34 | 34 | 0 |
| Retry／Refill | 0／0 | 0／0 | 0／0 |

這批函式入口沒有執行 handler 的 Retry／Refill；0 是此入口未進入該流程，不是對所有真實生成的成本承諾。既有完整 handler 測試另外檢查其原有請求及交付契約。

12 個 complete 是合成 Fixture 判斷，不是真實旅遊品質或市場成功率。Routes 失敗控制雖回傳 plan，明確排除在 complete 外。壓力案例相對最初 357 分鐘草稿保留 57 分鐘必要容量縮時；可選 trial 失敗並沒有額外增加此損失，也不為了原案優先把容量超限分鐘恢復。

沒有正式函式變更，所以新增 OpenAI／Places／Routes／Repair 成本皆為 0，沒有新增長期儲存、Map、快取物件或 Repair 迴圈。新增測試中的記錄僅存於各測試生命週期。

## 驗收與研究資料獨立性

- 修改前完整 `npm run test:unit`：**1708／1708 通過，0 失敗、0 略過**。
- 新增專項：**19／19 通過，0 失敗、0 略過**。
- 修改後工作區完整 `npm run test:unit`：**1727／1727 通過，0 失敗、0 略過**。
- TypeScript：`tsc -b --pretty false` 通過。
- Build：`npm run build` 通過；仍有既有大於 500 kB bundle 提示。
- `git diff --check` 及新檔 `git diff --no-index --check`：通過。

乾淨來源驗收以 `git archive HEAD` 解出正式 tracked 檔案，只額外放入本輪新測試；沒有放入原 untracked 研究、備份、Phase 2A／2A-1 實驗檔或其 JSON。專項在該快照 **19／19 通過**，18 個逐案診斷與工作區完全相等。

依賴使用本機既有安裝的套件，沒有宣稱獨立完成全新安裝：嘗試 `npm ci --offline` 時本機快取缺少 `zod-validation-error` 套件，沒有改用網路下載。快照另有自己的 Git HEAD 與唯讀歷史 object 參照，供原有歷史重播及 acceptance manifest 檢查；原工作區分支與 Git metadata 未修改。這個驗證證明不需要未追蹤研究來源，不代表套件安裝環境完全隔離。

乾淨來源完整套件最終共 **1586 項，1583 通過、0 失敗、3 個既有可選研究快照測試略過**。略過來自 candidate-classification、candidate-availability-slots、candidate-quota-consistency 既有的 `snapshotAvailable()` 條件；本輪沒有新增 skip。工作區較多的測試數包含未追蹤 Phase 2A／2A-1 研究專項及可選保存資料的巢狀案例，不能以較高總數冒稱純 tracked 驗收。

初次 archive 沒有 Git HEAD 時，acceptance evidence 正確回報 source_version_unknown／incomplete，不能用那次結果當成功；已補足快照自己的版本資訊及可讀歷史物件，重新完整驗收，沒有修改或略過測試來配合。

## 提交範圍與驗收方式

僅新增：

- `tests/unit/feasible-plan-protection.test.mjs`
- 本報告 `docs/feasible-plan-protection-v1-verification.md`

正式函式修改 **0 個**。不改 Optional Activity Protection、Retry、Refill、Coverage 門檻、正式留白、點數、Auth、Schema、資料庫或 API 契約。不啟用 B2。

前輪開始時的65個untracked研究／備份（含設計文件）逐檔SHA-256核對維持一致；前輪新增測試、報告及本機results JSON。本次只納入上列兩檔，其餘研究／備份及results JSON維持原樣，不連帶Stage。

提交前以明確限定的Stage內容建立Git tree，再由該tree產生全新的隔離來源快照。核對快照包含新增測試，檔案內容與tree相符，且沒有其他untracked研究輸入；在快照執行19項專項、完整Unit Tests、TypeScript、Build及diff check。只有全部必要檢查通過、Stage仍僅含上述兩檔時，才執行指定Commit。

Commit訊息為 `test(trip): lock feasible plan protection regressions`。此提交不宣稱新增正式保底或提升交付率；不Push、Merge、Deploy，不切換原工作區分支。
