# Coverage v2 Phase 1：時間依據與補救決策基礎

基準：本機 dev `12d11cd`。本期只有內部 sidecar、診斷和免費測試；正式 Coverage、Repair、Refill、餐期、營業、Optional Activity Protection、成功狀態、API schema 與 UI 均沿用原政策。未新增搜尋、評分公式、AI Judge 或外部請求。

## 接入位置

| 既有位置 | 本期觀測 |
| --- | --- |
| `applyCandidateGroundingToPlan` | 保留 AI 骨架原始 duration，記錄 Grounding 造成的身份／用途／分鐘修正 |
| `rememberPlanTextTransition` | 沿用既有方案 lineage，攜帶每站時間追蹤；不能歸因的變動明記 unknown |
| 既有延長／縮短函式 | 分別記錄 meal_alignment、capacity、opening_alignment、coverage_existing、coverage_target、duration_bounds、redistribution |
| `getNearbyPlaceCandidates`／`searchPlaces` | 記錄實際查詢階段、文字、半徑、回傳數與 placeIds；區分 succeeded、failed、unavailable，保留既有回傳／快取行為 |
| `SupplementRouteContext` | 共用既有比較預算與 memo；附加補救事件，不改呼叫次數或限制 |
| `chooseSupplementalInsertion` | 候選考慮／排除、實際完成 Routes 比較、容量／營業／餐期拒絕、可行但未被選中、未比較候選與位置 |
| 既有餐期／需求替換／Optional Activity 保護 | 明確需求缺口、比較結果、選擇或拒絕及活動損失原因 |
| `repairAndValidatePlanForDelivery` | 對最後選中的方案或被拒絕的實際 Repair 結果計算影子判斷；不重新驗證或呼叫 API |
| `TripCandidateDebugSession.buildReport` | 既有 opt-in 非 production 診斷下新增 `coverageV2.attempts`、`coverageV2.final` |

`trip-coverage-v2.ts` 的 WeakMap 以物件生命週期保存資料，不在 TripPlan／Stop 上新增回傳欄位。Production 也計算內部影子結果；既有診斷開關只控制報告輸出。

## 時長依據

每站可讀取 AI 原始分鐘、初始來源、調整事件、前後 placeId／duration／delta、最終分鐘、活動依據 reference、Coverage 補時總量與目前保留補時量。正向 Coverage 差額永遠標為 `coverage_padding`；最低／最高參考界線調整另標 `duration_bounds`，不混成純補時。

來源區分 `confirmed_activity`、`type_reference`、`ai_unverified`、`coverage_padding`、`unknown`；混合來源另顯示 mixed。Google types、名稱參考上限、模型描述一律不能建立 confirmed_activity。已確認活動時長必須經內部明確入口附上營運時程或經驗證活動紀錄與 reference；目前沒有任何正式資料來源自動呼叫此入口。

`currentMinuteSources` 使用「最後加入的分鐘先被縮減」做帳務歸屬，並非驗證真實活動內容。`coverageAddedMinutes` 是歷史正向補時總量，`coverageRetainedMinutes` 是按此帳務規則尚留在該站的補時。替換地點／用途時會清除舊活動確認，保留調整歷史。

## 時間帳與影子 A／B／C／D

五小時、實際停留加交通 190 分鐘、正常最低門檻 225 分鐘：

- `requestedMinutes = 300`
- `actualMinutes = 190`
- `coverageGapMinutes = 35`
- `unarrangedMinutes = 110`
- 如從使用者指定起點連續安排，`tailBlankMinutes = 110`

門檻沿用正常 Coverage helper，不套用黎明尾段容忍值；使用者總時段始終保留完整跨日分鐘。03:00→12:00 的既有 06:00 活動窗口例外獨立記錄，不與 23:00→01:00 或跨日黎明尾段規則混用。

- A：核心需求確認符合、必要條件通過且正常 Coverage 達標。
- B：仍待補救，或證據不足以宣告合理停止。
- C：可能符合有條件尾端留白；核心需求與必要條件通過，正常 Coverage 未達標，同一時間軸下既定候選／位置比較已完成且至少有實際 Routes 比較，查詢來源可追溯，沒有未處理候選、來源失敗或預算耗盡。
- D：核心需求未完成／無法確認，或有必要可執行條件失敗。具用途證據且合法的替代方案明記 `legal_alternative_original_unmet`；不能冒稱原需求完成。

C 的必要條件包括既有餐期、禁忌、最短停留、營業與 closing buffer、第一站距離，以及連續時間軸。實際交通段需對應目前站序，不能使用缺漏／過期／估算段取得 C。未授權延後開始不取得 C；既有早晨活動窗口例外另記。模型未提供可獨立表達的站間等待欄位，因此本期只支援停留加站間交通的連續模型，不推論站間空檔合法性。

補救紀錄以時間軸 signature 綁定請求時段、有效開始、站序／身份／時長／座標和交通。比較後任何相關變動都使舊紀錄無法支持 C。先前候選失敗／預算耗盡也保守保留，不能被一次成功結果洗掉。只有單輪沒有選中補站、空候選池或類型排除不足以證明合理補救完成；`nearbyOptionsAvailability` 一律 unknown。

## 已知判斷界線與第二期條件

1. 尚無正式活動內容／場次／營運時長資料串接；目前只能定位政策補時、軟參考與未驗證 AI 時長，不能自動判定全部真實活動分鐘是否合理。
2. 未辨識的自由文字需求保持不確定；需求履行沿用 Trip Demand Compliance 的有限語法與既有證據。
3. 候選紀錄只涵蓋既定查詢、既有候選池及比較預算。未處理、營業／座標未知、歷史失敗或變動後時間軸均保守阻擋 C；不聲稱證明附近沒有其他好活動。
4. 分組 Repair 中未被細部 hook 覆蓋的修改保留 unknown；不事後臆測餐期／營業原因。分鐘帳務歸屬不等於實際活動證明。
5. 資料是 request／plan 生命週期 sidecar；持久化仍沿用既有 opt-in 診斷／acceptance evidence，沒有建立新正式儲存服務。
6. 第二期正式啟用 C 前，需要批准可交付的留白政策與上限、可靠活動依據及其驗證來源、核心需求／合法替代的交付契約、同一最終方案上的補救充分性與失敗處理規則，以及正式驗收／快取／前端說明的一致設計。站間等待與任意延後開始需要另外的時間軸授權模型。

## 持久化修正與安全投影

最終提交檢查發現 `buildReport().coverageV2` 曾被 `captureAcceptanceDiagnostics()` 的根欄位白名單排除。現在僅在此邊界呼叫 `projectCoverageDiagnostics()`，將安全投影後的結果放入既有 `c.diagnostics`；沒有直接展開原始 coverageV2。

資料流為 `buildReport()` → `captureAcceptanceDiagnostics()` → 有界 Coverage 投影 → `finish()` 的 JSON envelope／序列化 → `diagnostics.json`。後續沒有第二次欄位投影；原有整檔 2 MiB 大小保護仍可能把超大檔案改為明確的 `omitted: size_limit`，manifest 會標為 incomplete。

保存位置仍為 `.tripneeder-acceptance-evidence/<requestId>/diagnostics.json`，或既有 `TRIP_ACCEPTANCE_EVIDENCE_DIR` 指定的位置；只有非 production 且 `TRIP_CANDIDATE_DEBUG=true` 時啟用。不改 API、回傳內容、資料庫或快取政策。

新增區塊的安全規則：

- 僅保存代碼白名單、有限數值、布林值與必要的時間帳；未知代碼轉為 null 並標示投影不完整。
- 保留各方案分類／理由、原需求履行狀態、分鐘帳、來源分類、duration 前後差額、Coverage 增加／保留分鐘、停止原因及未評估／預算／技術失敗標記。
- stopId、placeId、活動 reference 與時間軸 signature 只保存 SHA-256；不保存新增區塊中的原始查詢、名稱、座標、私人位置輸入、自由文字 details、Prompt、憑證、候選池或外部回應。
- 最多 3 個 final、12 個 attempts；每方案最多 40 站、每站 16 個時長事件／來源片段、64 個補救事件、16 個補救 pass、32 個搜尋摘要及 16 個原因／需求。另有每列 64 KiB 與區塊 256 KiB 大小保護，優先保留 final 的明細。
- 超限時保留分類、分鐘帳及不確定旗標，省略明細並明記 `projection.incomplete`／固定原因；manifest 加上 `coverage_v2_projection_incomplete`。不將不完整診斷當成合理停止證明。
- 舊資料未提供 coverageV2 時不新增虛構結果，原格式仍可序列化及讀取。上述投影不改動其他既有診斷區塊。

新增 `trip-coverage-persistence.test.mjs` 的 9 項測試使用真實 writeFileSync 寫入隔離暫存目錄，結束 acceptance context 後重新讀取 diagnostics.json，驗證 A／B／C／D 與三方案、35／110 分鐘差額、補時與縮短、不同停止原因、敏感資料排除、大小限制、舊版相容及檔案雜湊；完成後清除測試目錄。三組生成重播 fixture 也檢查 write boundary 的 JSON 讀回結果，逐方案對照記憶體中的關鍵數值。

## 免費驗證

新增 `trip-coverage-v2.test.mjs` 的 26 項測試涵蓋需求中的差額、補時、來源隔離、候選未處理、Routes 預算、API 失敗、原需求與替代、跨午夜／黎明及時間軸變動。`coverage-v2-replay.mjs` 以讀取 `git show 12d11cd:api/generate-trip.ts` 的方式重播基準，沒有 checkout 或改動 Git 歷史。

三種完整 Mock 生成（positioning、missing-balanced refill、stream tail）的正式回應、串流事件及所有服務呼叫次數皆與基準一致；debug off／on 也一致：

| 情境 | AI | Places | Routes | 點數 RPC |
| --- | ---: | ---: | ---: | ---: |
| positioning | 1 | 10 | 9 | 1 |
| missing-balanced | 2 | 10 | 8 | 1 |
| tail | 1 | 10 | 9 | 1 |

以上均為 Mock 計數，沒有付費請求。完整 Unit Tests、TypeScript、Build 與 diff check 的最後結果列於交付回報。

保留原有 51 個 untracked 研究／備份檔案；本期新檔僅此文件、兩個內部模組、兩份測試及 Mock 重播 fixture。只允許在本機 dev 驗收通過後 Commit；不 Push、Merge、Deploy。

最後驗證結果：

- Coverage v2 原始專項：26／26 通過；新增實際落盤／讀回專項：9／9 通過。
- `npm run test:unit`：1511／1511 通過，0 失敗、0 skipped。
- `npx tsc -b --pretty false`：通過。
- `npm run build`：通過；Vite 提示既有主 bundle 超過 500 kB，非阻擋錯誤。
- `git diff --check`：通過。
- 原有 51 個 untracked 研究／備份檔案逐一以 SHA-256 核對保留，不納入 Stage。
- 最終提交只 Stage 本期明列的 12 個檔案，檢查 staged diff，使用 `feat(trip): add coverage v2 decision diagnostics`。
