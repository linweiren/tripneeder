# PROJECT_SPEC.md

TripNeeder 是一個 AI 即時行程決策 Web App。此檔為目前有效主規格與交接文件，已精簡過；完整歷史紀錄已歸檔於 `docs/archive/PROJECT_SPEC_FULL_BEFORE_COMPACTION_2026-04-18.md`。

讀取規則：必須以 UTF-8 讀取本檔，避免繁體中文亂碼。若本檔與 archive 歷史紀錄衝突，以本檔最新狀態為準。

---

# 1. 永久協作規則

* 全程使用繁體中文回覆，不要使用簡體中文。
* 每個 phase / 子階段完成後，必須先讓使用者驗收；驗收通過後才可以進下一階段。
* 任何新增或修改後確認下來的規格，都要同步寫進 `PROJECT_SPEC.md`。
* 不要擅自跳 phase。
* UI 細節不清楚時要先問使用者，尤其是資訊顯示位置、卡片內容、詳情頁內容、按鈕文案等。
* Figma MCP 先不介入早期功能開發，除非使用者後續明確確認要用。
* 本機驗收網址優先使用 `http://localhost:5173/`，不要優先給 `127.0.0.1`。
* 避免用 `cmd /c start` 啟動 dev server；若需要啟動 dev server，使用 PowerShell / Start-Process 或一般 `npm run dev`，並確認 `localhost:5173` 回應。
* 不要 reset、checkout 或 revert 任何使用者 / 前面 agent 的變更。
* OpenAI API key 不可放前端，AI 呼叫需走 Vercel Function server-side。
* `SUPABASE_SERVICE_ROLE_KEY` 只供本機工具使用，不放進前端或 Vercel client bundle。

---

# 2. 專案目標與產品邊界

TripNeeder 的核心目標：使用者輸入行程偏好後，AI 產生三個可比較的一日行程方案，使用者可查看詳情、調整交通、收藏方案、查看最近生成，並透過登入與點數制控制 AI 使用成本。

產品邊界：

* 主流程是「即時行程決策」，不是完整訂票、付款或社群平台。
* AI 必須回傳可解析資料，不可依賴自由文字顯示。
* 目前主要支援：首頁偏好輸入、AI 三方案、結果頁、詳情頁、雨天備案、交通切換、收藏、最近生成、登入、點數、PWA 基礎。
* 未來功能如完整地圖選點、多人共編、社群分享、商業後台等不在目前已驗收範圍。

---

# 3. 目前功能重點

主要頁面：

* 首頁：行程偏好輸入與 AI 分析送出。
* 結果頁：三方案比較。
* 詳情頁：時間軸、雨天備案、交通切換、拖曳排序、收藏。
* 收藏頁：已收藏行程。
* 最近生成頁：最近 AI 生成方案。
* 登入頁：Supabase Google 登入。
* 點數頁：點數餘額與最多 30 筆交易紀錄。

首頁輸入重點：

* 行程類型：約會、放鬆、探索、美食、戶外、室內、一個人、其他。
* 時間：支援 2 到 24 小時，可跨日。
* 預算：小資、一般、輕奢、豪華。
* 人數：支援 1 到 5+。
* 偏好 tags：不要太累、室內優先、小眾、短距離、美食優先、拍照優先、不吃正餐。
* 起點：目前以位置 / 地名輸入為主，完整地圖選點尚未進入目前已驗收範圍。
* 送出按鈕文案：`出發！GO！（扣除20點數）`。

AI 與結果重點：

* AI 固定產生三方案：保守型、平衡型、探索型。
* AI 回傳需符合嚴格 JSON schema。
* 分析成功扣 20 點；格式錯誤、分析失敗或取消不再追加扣點。
* 分析中可取消；取消確認文案需保留「點數已確定扣除」的提醒。

資料重點：

* 收藏 / 最近生成已同步到 Supabase `trip_records`。
* 最近生成最多 12 筆。
* 點數交易最多保留最新 30 筆。
* 舊版 localStorage 資料已透過 legacy migration 搬到目前登入帳號。

---

# 4. 目前技術狀態

* 前端：Vite + React + TypeScript + React Router。
* AI：Vercel Function `api/generate-trip.ts` server-side 呼叫 OpenAI。
* Auth / DB：Supabase。
* PWA：manifest、icon、service worker、手機加入主畫面可用。
* 收藏 / 最近生成：已同步到 Supabase `trip_records`，並保留 localStorage fallback / legacy migration。
* 點數制：已上線，AI 分析成功扣點，失敗不扣點。
* 點數管理器：本機工具 `點數管理器`，使用 service role key，不能外流。
* 正式站：Vercel production 可用。

目前已套用 Supabase migrations：

* `supabase/migrations/001_points_schema.sql`
* `supabase/migrations/002_points_consumption.sql`
* `supabase/migrations/003_trip_records.sql`
* `supabase/migrations/004_point_transactions_retention.sql`
* `supabase/migrations/005_user_persona.sql`

重要資料表 / RPC：

* `profiles`：使用者點數、帳號資料與人設資訊（同行對象、預算感、體力、飲食禁忌）。
* `point_transactions`：點數交易紀錄。
* `trip_records`：收藏 / 最近生成。
* 點數交易每位使用者最多保留最新 30 筆。
* 最近生成最多 12 筆。

---

# 5. 已驗收 Phase 狀態 (Phase 1 - 8A)

* **基礎架構與核心 (P1-P3)**：Vite/React/TS 骨架、行程偏好表單、AI 三方案生成 (含嚴格 JSON schema 與 sessionStorage 暫存)。
* **詳情、交通與排序 (P4A-P4E)**：時間軸、雨天切換、交通段模型、交通切換、`@dnd-kit` 拖曳排序、超時確認、`不吃正餐` 規則。
* **功能擴充與 PWA (P5-P6B)**：本機收藏/最近生成、PWA 基礎 (Manifest/SW)、Session 有效期管理、App 內 Dialog 系統、Prompt 與錯誤文案微調。
* **全站視覺整理 (P6C)**：首頁、結果頁、詳情頁、收藏頁之視覺 UI 收斂與全域一致性優化。
* **帳號、點數與 API 安全 (P7A-P7G)**：Supabase Auth (Google 登入)、點數制 (20點/次)、Vercel Functions OpenAI Proxy、點數管理器本機工具。
* **雲端同步與正式站 (P8A)**：收藏/最近生成同步至 Supabase、Legacy 資料遷移機制、穩定 Fingerprint 比對修正。

---

# 6. 目前可給組員測試的穩定版本

可提供組員測試的版本：

* Git commit：`bd11d8b`
* commit message：`Handle legacy trip record fingerprints`
* Vercel production deployment 狀態：`READY`

最新文件整理提交：

* `e11cb48`：`Add handoff for next chat`
* 本次 SPEC 精簡整理已完成；完整舊版已歸檔到 `docs/archive/PROJECT_SPEC_FULL_BEFORE_COMPACTION_2026-04-18.md`。

組員測試前可提醒：

* 手機已加入主畫面的網頁式 APP 不需重新加入；重新打開通常會載入新版本。
* 若看起來仍是舊版，請關掉 TripNeeder 後重新打開，或稍等再重開。
* 測試重點：登入、點數、AI 扣點、收藏、最近生成、重新整理後資料是否保留、問題回報。

---

# 7. Phase 8A 事故摘要與日後規則

完整歷史與長版復盤已保留在 `docs/archive/PROJECT_SPEC_FULL_BEFORE_COMPACTION_2026-04-18.md`。

Phase 8A 曾出現：本機收藏 / 最近生成同步正常，但正式站不正常。最後確認不是單一 bug，而是跨版本資料混在一起。

根因：

* 正式站瀏覽器保留最舊版未分帳號 localStorage：
  * `tripneeder.favoritePlans`
  * `tripneeder.recentPlans`
* 後續版本曾改成 user-scoped localStorage：
  * `tripneeder.favoritePlans.<userId>`
  * `tripneeder.recentPlans.<userId>`
* Phase 8A 再新增 Supabase `trip_records`。
* 初版 Phase 8A 只遷移 user-scoped localStorage，漏掉最舊版未分帳號 localStorage。
* 原本 `createPlanFingerprint` 包含交通段 `label` 等顯示文字；詳情頁會清洗 / 重建 label，導致同一方案在列表與詳情頁 fingerprint 不一致。

最後有效修正：

* 穩定 fingerprint：不納入交通段 `label` 等顯示文字。
* 向後相容：若 DB `plan_fingerprint` 查不到，讀取遠端收藏清單並用新版穩定 fingerprint 比對每筆 `plan`。
* 新增收藏前也掃遠端既有收藏，避免舊 DB fingerprint 不同造成假重複。
* legacy localStorage migration：將 `tripneeder.favoritePlans` / `tripneeder.recentPlans` 一次性搬到目前登入者的 Supabase `trip_records`。
* 收藏後同步更新 localStorage fallback、module-level memory cache、sessionStorage cache，並用 `tripneeder:favoritesChanged` 通知詳情頁刷新。

日後效率規則：

* localStorage 遷雲端前，必須列出所有歷史 key，包含 legacy global key 與 user-scoped key。
* fingerprint 不可包含會被格式化、清洗、重建或只用於顯示的欄位。
* 正式站 bug 若本機無法重現，優先檢查：
  * 正式站 localStorage / sessionStorage。
  * Supabase 既有資料是否與目前 schema / fingerprint 相容。
  * Vercel 環境變數與本機是否指向同一 Supabase project。
  * 同 email 是否在不同 auth project 產生不同 user id。
* 對正式站既有資料修正時，要同時保證：新資料可寫、舊資料可讀、舊資料不假重複、遷移不重複執行。

---

# 8. Phase 9 規劃（產品核心功能優化）

Phase 8B（`正式試用前資料與營運收尾`）已於 2026-04-18 永久取消，不再執行，不再保留建議範圍。

下一階段為 Phase 9，主題：**產品核心功能優化，對齊「到當地快速排行程」定位**。

## 8.1 設計原則

* 速度優先：目前 AI 分析約 2 分鐘，是目前最大痛點。
* 人設系統降低輸入門檻，但絕不強制。
* 權重單欄覆寫：進階表單有填的欄位 > 人設 > 系統中性預設。
* 節流 AI：能前端做的不叫 AI，能局部改的不整體重生。

## 8.2 關鍵技術事實（設計時務必記住，避免白費力氣）

* 三方案是**單次** API call 產生，不是三次；並行化不成立。
* 目前使用 `gpt-4.1-mini`（Responses API）。已驗證 `gpt-4o` 沒快到哪且品質較差，不要再嘗試換模型。
* Prompt 含 34 條硬性規則 + 長 schema 範例，input/output token 都大，有瘦身空間。
* 前端尚未啟用 streaming。
* 核心檔案：
  * `api/generate-trip.ts`
  * `src/services/ai/tripPlanPrompt.ts`
  * `src/services/ai/tripPlanResponseSchema.ts`
  * `src/services/ai/proxyTripPlanner.ts`
  * `src/pages/HomePage.tsx`
  * `src/types/trip.ts`

## 8.3 Phase 9 子階段順序（不可自行跳 phase）

每個子階段（例如 9B-1、9B-2）完成後都要先讓使用者驗收，通過才進下一個子階段。

### 9A：AI 生成速度優化（已全部驗收通過）

完整實作、驗收切點與事故復盤見 8.5 Phase 9A 進度紀錄。

* 9A-1　Prompt / Schema 瘦身
* 9A-2　前端 streaming（NDJSON + 骨架卡片）
* 9A-3　兩階段生成（骨架先出、詳情後補；含 context 架構提升與 loading 動畫）

### 9B：人設系統（已全部驗收通過）

原則：不強制；沒填人設也能正常使用，AI 會退用系統中性預設。

* 9B-1　Supabase migration 新增人設欄位：已於 `profiles` 擴充 `persona_companion`, `persona_budget`, `persona_stamina`, `persona_diet` 欄位。
* 9B-2　選單新增「個性化設定」入口：已實作 `/persona` 頁面，支援讀取、編輯與儲存人設，並具備 UI 回顯與儲存狀態提示。
* 9B-3　生成時套用人設：已整合至 `api/generate-trip.ts` 與 `api/generate-trip-details.ts`。權重規則：進階表單 > 人設 > 系統中性預設。
* 9B-4　系統中性預設：已設定為「情侶 / 約會、一般預算、體力普通、無飲食禁忌」。

### 9C：地理約束 + 起點體驗（已全部驗收通過）

* 9C-1　Prompt 加硬規則：第一站距離起點 ≤ 2 km。
* 9C-2　Prompt 加軟規則：相鄰站交通時間 ≤ 30 分鐘；整日累積交通 ≤ 總時長 25%。
* 9C-3　定位後反查地名（Google Geocoding API），UI 顯示「目前位置：高雄市鼓山區」等可讀地名，而非原始座標。
* 9C-4　Prompt 強化「以使用者目前位置為中心規劃」。

### 9D：Google Places 地點驗證（治 AI 幻覺）

前置：使用者完全不會用 Google API，9D-1 教學文件必須非常詳細、可獨立操作。

* 9D-1　新建 `docs/setup/google-places-setup.md`，內容至少包含：
  * Google Cloud Console 建立 project
  * 啟用 Places API (New) 與 Geocoding API
  * 產生 API key、設定 HTTP referrer / IP 限制
  * 本機 `.env` 加 `GOOGLE_PLACES_API_KEY`
  * Vercel 環境變數設定步驟
  * 付費帳戶、配額上限、預算警報設定
* 9D-2　Vercel Function 端新增 server-side Places Text Search，驗證每個 stop 是否真實存在。
* 9D-3　驗證通過 → 用 Places 正式名稱、完整地址、`place_id` 覆寫 AI 原始輸出。
* 9D-4　Google Maps 連結改用 `place_id` 精準連結。
* 9D-5　單一方案 ≥ 2 個地點查無此地時，自動重試該方案 1 次；仍失敗回明確錯誤。
* 9D-6　成本與 quota 監控提醒寫進設定文件。
* 9D-7　智慧前置搜尋（Search-Inject）策略（治本）：
  * 在呼叫 OpenAI 前，根據 `category` 與 `tags` 動態產生搜尋關鍵字。
  * 透過 Google Places API 抓取 15-20 個與使用者偏好匹配的真實地點清單。
  * 將清單注入 AI Prompt，指示 AI 優先從中選點編排行程。
  * 此舉可從根源降低 AI 幻覺，減少後續驗證失敗與重試的機率。

### 9E：現場快速模式（On-site Quick Start）

產品定位調整：Tripneeder 不跟完整旅遊規劃 AI 正面競爭；核心場景是「使用者已經在當地 / 已經到附近，不知道接下來幾小時怎麼玩」。因此首頁預設應以**目前位置 + 可用時間**為主，而不是要求使用者輸入目的地做長期規劃。

依賴：9B 已完成；9C / 9D 已改成 Places / Routes 驅動，快速模式可直接使用目前位置與真實候選地點。

* 9E-1　首頁預設「現場快速模式」：主 CTA 為「使用目前位置」，位置成功後顯示可讀地名；不再把手動輸入地點作為主要入口。
* 9E-2　時長 chip：`1h` / `2h` / `3h` / `半天 (6h)` / `一天 (10h)` / `自訂`。
* 9E-3　目前位置流程：時間起點 = 目前系統時間；結束 = 起點 + 選定時長。若跨日，UI 需明確顯示「到明天 HH:mm」。
* 9E-4　保留手動地點輸入，但降級為「不在現場？改用指定起點」的次要/折疊入口；此功能只代表「從該起點附近開始」，不承諾完整旅遊目的地規劃。
* 9E-5　指定起點流程需同時提供「抵達起點時間 / 從這裡出發時間」。預設可帶入目前時間，但 UI 必須讓使用者修改；結束 = 抵達起點時間 + 選定時長。
* 9E-6　「進階設定」折疊區塊：展開可填類型、預算、人數、tags、指定起訖時間；若使用指定起點，起始時間應放在指定起點區塊內優先顯示，而不是藏到進階設定。
* 9E-7　進階表單所有欄位皆選填，不阻擋送出；快速模式至少需要目前位置或指定起點 + 起始時間 + 時長。
* 9E-8　權重規則（**單欄覆寫**）：
  * 進階表單**有填**的欄位 → 這次使用進階值。
  * 進階表單**沒填**的欄位 → 使用人設值。
  * 人設也沒設 → 使用系統中性預設。
* 9E-9　送出按鈕維持「出發！GO！（扣除 20 點數）」文案。
* 9E-10　長時段行程不設 stop 硬上限；後端以 Places 候選池補足更多真實 stop，避免少數站點停留時間被不合理拉長。

暫不做：

* 不做「輸入想去的城市 / 景點，規劃整趟旅行」的完整旅遊規劃模式。這會讓產品定位與通用行程 AI 重疊，且不是 Tripneeder 的差異化優勢。
* 不把手動輸入起點做成主 CTA；它只作為定位失敗、使用者幫朋友規劃附近行程、或即將抵達某處時的備援入口。

### 9F：局部編輯 + Places / Routes 重算（重新設計，暫不立即執行）

原 SPEC 的「節流 AI」方向需要調整。9C / 9D 後，地點與交通已改由 Places / Routes API 驅動，局部編輯不應再讓 AI 主導地點真實性，也不應用純前端估算假裝精準。

新方向：

* 9F-1　詳情頁「刪掉這站」：可以做，但刪除後需呼叫 server-side route recompute，重算相鄰交通段、總時長與時間軸；不可只用純前端估算。
* 9F-2　詳情頁「換掉這站」：不優先呼叫 AI。由 Places 候選池找同類型真實地點，避開已使用 `placeId`，套入後用 Routes API 重算前後交通。
* 9F-3　MVP 先不扣點；因為換站本質是 Places 候選替換 + Routes 重算，不是一次新的 AI 生成。未來若加入「AI 根據文字理由重新設計這站」再考慮扣 5 點。
* 9F-4　刪站 / 換站前需有確認或 undo，避免使用者誤改整條路線。
* 9F-5　若 Routes API 未啟用，局部編輯可 fallback 成估算，但 UI / 文件不可宣稱為 Google 真實交通時間。

暫不做：

* 不新增 `api/replace-stop.ts` 的 AI 版換站 endpoint。
* 不做「換站扣 5 點」。
* 不做純前端刪站後只用本地估算的版本。

### 9G-lite：失敗 / 扣點 / 最近生成一致性收尾驗證

9G 不再作為大型功能開發。9C / 9D 已把主要風險改掉：可修復的地點與時長問題由 server repair，不再丟給使用者；扣點已延後到最終可交付結果後；最近生成只在 `generateTripPlans` resolve 後寫入。

仍需做一輪小型驗證：

* 9G-1　OpenAI 失敗：不寫最近生成、不扣點。
* 9G-2　Places API key 缺失 / Places API 失敗：不寫入明顯壞資料；必要時走可接受 fallback，且不顯示內部驗證失敗語言。
* 9G-3　Routes API 未啟用：不阻斷生成，交通段 fallback 為估算；文件提示啟用 Routes API 才能取得 Google 官方交通時間 / 距離。
* 9G-4　使用者取消：重新確認取消前 / 取消後扣點語意與 UI 文案一致。
* 9G-5　streaming 中途錯誤：partial plan 不寫入最近生成；若已扣點需有明確策略（退款 / 不扣 / 可重試）。

建議順序：

1. 先做 9G-lite 收尾驗證。
2. 再做 9E 現場快速模式。
3. 9F 等 Routes API 啟用且 9E 驗收後，再以「局部編輯 + Places / Routes 重算」重開。

## 8.4 Phase 9A 扣點邏輯（兩階段生成）

* 第一階段（骨架）扣滿 20 點。
* 第二階段（點進詳情才補細節）**不再扣點**。
* 沒被點開的方案不補細節，節省 API 成本。

## 8.5 Phase 9A 進度紀錄

**9A-1　Prompt / Schema 瘦身**（2026-04-18 已實作，已驗收通過）

實作內容：

* `src/services/ai/tripPlanPrompt.ts`：34 條硬性規則壓成 15 條（合併午晚餐 7 條為 1 條、合併覆蓋率 3 條為 1 條、刪除 schema 已管的重複規則）。prompt 底部 JSON 範例從完整雙段縮為單行精簡格式。
* `src/services/ai/tripPlanResponseSchema.ts`：
  * 從 stop schema 移除 `googleMapsUrl` 欄位（AI 不再輸出）。
  * plan item、stop、transportSegment 三層 `additionalProperties` 由 `true` 改為 `false`，禁止模型產出多餘欄位。
* `src/pages/DetailPage.tsx`：新增 `buildMapsSearchUrl(stop)` helper，優先使用 legacy `stop.googleMapsUrl`（為相容舊收藏 / 最近生成資料），缺值時用 `name + address` 自組 `https://www.google.com/maps/search/?api=1&query=...`。原條件式 render 改為常駐顯示「開啟 Google Maps」按鈕。

相容性：

* Parser（`isStop`）仍接受 `googleMapsUrl` 為可選欄位，舊資料可讀。
* 舊 favorites / trip_records 的 stop 仍帶 `googleMapsUrl`，前端優先使用。
* `Stop` type 維持 `googleMapsUrl?: string`，無 breaking change。

驗收切點：

* 平均生成秒數需較瘦身前下降 ≥ 20%（以約 120s 基準 → ≤ 96s）。
* 相同輸入跑 5 次取中位數比較。
* 三方案結構與 UI 顯示不得退化：title / subtitle 字數、午晚餐排餐、交通 label 格式、雨天備案、stop 數量、「開啟 Google Maps」按鈕皆需正常。

**9A-2　前端 streaming**（2026-04-18 已實作，已驗收通過）

實作決議（使用者確認）：

* Q1 串流協定：**NDJSON**（每行一個事件）。
* Q2 增量 JSON 解析：**自寫 brace counter**，無額外依賴。
* Q3 扣點語意：**(A) 有東西出來就扣**——只要第 1 張 plan 成功 emit 就扣 20 點；若取消發生在第一張 plan 前則不扣。
* Q4 `vercel.json` 加入 `functions."api/generate-trip.ts".maxDuration = 300`。
* Q5 UI：三張 skeleton 卡片先佔位（手機優先），AI 回一張就填實該卡；採垂直 stack，不會跳版。
* Q6 取消：前端 `AbortController.abort()`；cancelAnalysis 時清除 session、abort controller。

實作內容：

* 2026-04-18 驗收後修正本機 Vite middleware：補上 `write()` / `end()` 串流介面與 abort signal，避免本機 `/api/generate-trip` 在 NDJSON streaming 時連線中斷，造成 skeleton 出現後立刻分析失敗。
* `vercel.json`：新增 `functions."api/generate-trip.ts".maxDuration = 300`。
* `api/generate-trip.ts`：
  * 先做 auth + 點數餘額 preflight，失敗回傳一般 JSON error。
  * 通過後切到 `Content-Type: application/x-ndjson`，開啟 OpenAI `stream: true`。
  * 以 SSE parser 提取 `response.output_text.delta`，累積全文並用 `PlanExtractor`（自寫 brace counter + 字串 / escape 狀態機）切出完整 plan 物件。
  * 每切出一張 plan 推 `{"event":"plan","plan":{...}}`；第一張成功 emit 後扣 20 點（失敗 emit `points_warning`，不中斷串流）。
  * 串流結束後以既有 `parseTripPlanResponse` 做完整驗證與正規化，推 `{"event":"done","response":{plans:[...]}}`；驗證失敗推 `{"event":"error","message":...}`。
* `src/services/ai/types.ts`：`GenerateTripPlansRequest` 新增 `signal?: AbortSignal`、`onPlan?: (plan: PartialTripPlan) => void`。
* `src/services/ai/proxyTripPlanner.ts`：偵測 `application/x-ndjson` 改以 reader 逐行 parse 事件；`plan` 事件 callback、`done` 取最終 response、`error` 拋錯；舊 JSON 路徑保留相容。
* `src/contexts/analysisSession.ts`：`AnalysisSession` 新增 `partialPlans?: PartialTripPlan[]`。
* `src/contexts/AnalysisSessionContext.tsx`：新增 `AbortController` ref；`startAnalysis` 傳入 `signal` 與 `onPlan`（進度寫回 session、同步到 sessionStorage）；`cancelAnalysis` 呼叫 `abort()`。
* `src/pages/HomePage.tsx`：loading 區塊改為三張卡片 `.plan-skeleton-list`；未到的卡片顯示 shimmer bar、到的卡片顯示 title / subtitle / summary；標題改為「已完成 N / 3 個方案」。
* `src/App.css`：新增 `.plan-skeleton-list / -card / -tag / -title / -subtitle / -summary / -bar` 與 `plan-skeleton-shimmer` 動畫；垂直 stack、手機優先。

相容性：

* 舊 `GenerateTripPlansResponse` 結構未變；未帶 streaming header 時 proxy 回退到原 JSON 路徑。
* `partialPlans` 為可選欄位，舊 sessionStorage 可讀。
* 扣點時機改為「第一張 plan emit 後」；與原先「成功扣點、失敗不扣」語意差異：串流途中才失敗會出現「已扣但沒拿滿 3 張」的邊界。9A-3 已沿用此語意：第一階段骨架扣 20 點，第二階段詳情補充不再扣點。

驗收切點：

* 首卡片出現時間 ≤ 30 秒（手機 Safari + Chrome 各測一次）。
* 三張卡片依序浮出；完成後自動前往結果頁，結果頁資料完整。
* 取消按鈕在第一張 plan 前按下：不扣點；第一張 plan 後按下：扣 20 點（語意與 UI 文案「點數已確定扣除」一致）。
* 點數不足 / 未登入 / OpenAI 異常：走 preflight 或 `error` 事件，UI 顯示錯誤訊息。

**9A-3　兩階段生成：骨架先出、詳情後補**（2026-04-18 已驗收通過）

設計切點（2026-04-18 使用者已確認）：

  * 第一階段維持骨架欄位，不先產每站簡短 description。
  * 第二階段在使用者點進詳情頁時觸發；若該方案仍是骨架版，詳情頁自動補細節，完成後留在同頁更新內容。
  * 補細節失敗時，詳情頁保留骨架內容並顯示「細節補充失敗，重新補充」按鈕；重試不扣點。
  * 收藏只允許收完整版；若使用者在骨架詳情頁按收藏，提示「正在補完整細節，完成後再收藏」。
  * 最近生成可先存骨架，之後升級為完整版。
  * 保留 9A-2 streaming：第一階段串流三張骨架卡片，完成後進結果頁；第二階段詳情補充先做一般 loading，不需 streaming。

實作內容：

* `src/services/ai/tripPlanPrompt.ts`：第一階段 prompt 改為骨架方案；新增單一方案細節補充 prompt；新增骨架 response parser 與詳情補充 parser。
* `src/services/ai/tripPlanResponseSchema.ts`：新增骨架 schema 與詳情補充 schema；保留完整版 schema。
* `api/generate-trip.ts`：第一階段改用骨架 schema / parser，仍保留 NDJSON streaming 與第一張 plan emit 後扣 20 點。
* `api/generate-trip-details.ts`：新增詳情補充 Vercel Function；需登入與 server-side OpenAI key，不扣點。
* `src/services/ai/proxyTripPlanner.ts` / `src/services/ai/types.ts`：新增 `completeTripPlanDetails` 前端 proxy。
* `src/types/trip.ts`：`TripPlan` 新增 `isDetailComplete?: boolean`，骨架版為 `false`，完整版為 `true`。
* `src/pages/DetailPage.tsx`：點進骨架詳情頁自動補完整細節；補失敗可重試；骨架狀態下雨天切換停用、收藏按鈕提示需補完整細節。
* `src/utils/tripPlanStorage.ts` / `src/services/tripRecords/tripRecordService.ts`：補完後更新 sessionStorage 詳情 / 結果資料，並嘗試升級最近生成的本機與 Supabase `recent` 紀錄。
* `vite.config.ts`：本機新增 `/api/generate-trip-details` middleware，並避免被 `/api/generate-trip` route prefix 誤吃。
* `vercel.json`：新增 `api/generate-trip-details.ts` maxDuration 300。

驗收切點：

* 首頁送出後第一階段仍是三張骨架卡片依序浮出，第一張 plan emit 後扣 20 點。
* 結果頁三張卡片可先顯示骨架資料，點進詳情頁後自動顯示「正在補完整細節」。
* 詳情補完後，同頁景點 description、雨天備案、交通 label / publicTransitType 皆補齊。
* 詳情補充不再扣點；補失敗時可按「細節補充失敗，重新補充」重試。
* 骨架補完前不能收藏；點收藏會提示「正在補完整細節，完成後再收藏」。
* 最近生成可先出現骨架，補完後同一方案升級為完整版。
* 手機直式詳情頁補細節期間不跳版。

**9A-3 驗收過程事故與二次修正（2026-04-18）：**

初版詳情補細節流程卡死在「正在補完整細節」，等兩分鐘也不會完成。根因有三層，全部修掉後才通過：

1. `lastInput` 每次 render 都從 sessionStorage 建立新物件，reference 不穩定，導致詳情補細節 useEffect 的 cleanup 在 `setDetailCompletionStatus('loading')` 觸發的 re-render 中 abort 掉自己的 fetch。→ 改用 `useMemo` 穩定 reference。
2. 第一個 useEffect 在 mount 後無條件 `setSelectedPlan(nextSelectedPlan)` 建立新 plan reference，也會觸發詳情補細節 effect 的 cleanup 中止 fetch。→ `setSelectedPlan` 改用 updater function，資料相同時回傳 `prev`。
3. React 18 StrictMode 在 dev 模式讓 effect 在 mount 時跑兩次；原本用 `detailCompletionRequestRef` 防重覆 fetch，但它讓 StrictMode 第二次 effect run 直接 return，而第一次 run 的 fetch 已被 cleanup abort。→ 移除 ref guard，讓第二次 effect 能正常重啟 fetch。

**9A-3 二次需求與架構提升（2026-04-18 已驗收通過）：**

使用者反映兩點：

* 「正在補完整細節」需要實際 loading 動畫，不是靜態文字。
* 補細節應在「點選擇此方案」那刻就送出，使用者離開詳情頁也不中斷；回來時若已補完直接看到完整版、若還在跑就保留 loading 動畫。

為此把補細節邏輯從 `DetailPage` 上提到 `AnalysisSessionContext`（app 根層級，頁面切換不會 unmount）：

* `src/contexts/analysisSession.ts`：新增 `PlanDetailStatus`、`PlanDetailState` 型別，`AnalysisSessionContextValue` 新增 `planDetailStates: Record<planId, PlanDetailState>` 與 `requestPlanDetails(planId)`。
* `src/contexts/AnalysisSessionContext.tsx`：
  * 新增 `planDetailStates` state 與 `planDetailControllersRef`（每個 planId 的 AbortController）。
  * `requestPlanDetails(planId)` 為 idempotent：plan 已 `isDetailComplete` 直接標 complete；已 loading 中跳過（以 ref 判斷）；error 或未開始則啟動 fetch，成功後 `updateGeneratedPlan` / `updateDetailPlan` / `upgradeRecentGeneratedRecord`，並透過 `tripneeder:planDetailComplete` CustomEvent 通知。
  * `cancelAnalysis` 也中止所有 in-flight 詳情 fetch、清空 state。
* `src/pages/ResultsPage.tsx`：點「選擇此方案」時同時呼叫 `setFlowRoute` 與 `requestPlanDetails(plan.id)`。
* `src/pages/DetailPage.tsx`：
  * 移除原本自己管理的 fetch useEffect、AbortController、retry state、`supabase.auth` 取 token、`tripPlanner` 呼叫等邏輯。
  * 改從 context 讀 `planDetailStates[planId]` 轉出 `detailCompletionStatus / detailCompletionError`。
  * 進頁仍呼叫 `requestPlanDetails(planId)` 作 fallback（直接打網址或重整後進來時可啟動）。
  * 當 context 標記 `complete` 時，從 sessionStorage 重讀升級後的 plan，同步更新本地 `selectedPlan` 讓詳情頁刷新。
  * 重試按鈕改呼叫 `requestPlanDetails(planId)`。
* `src/App.css`：新增 `.detail-completion-heading`、`.detail-completion-spinner`（旋轉圓）、`.detail-completion-progress / -bar`（綠色漸層滑動條）與 `detail-completion-spin / -progress-slide` keyframes。

UI 文案：收藏按鈕未補完狀態文案為 `補完細節後可收藏`（原本 `補完整細節` 字數太多會換行，已刪掉「整」）。

## 8.6 Phase 9 啟動規則

* 每個子階段（9A、9B、…）完成後必須使用者驗收通過才能進下一階段。
* 不可自行跳 phase；9A-1 / 9A-2 / 9A-3 等細階段同樣需逐一確認驗收切點。
* 新增或修改後確認的規格，同步寫回本章。

## 8.7 Vercel 部署 SOP

目前部署原則：

* Vercel production 目前已連接 GitHub repo：`linweiren/tripneeder`。
* production 以 `main` 分支為準；`git push origin main` 會觸發 Vercel production auto deploy。
* 一般情況不需要手動到 Vercel dashboard promote。
* 若是從 feature branch / PR 產生 preview deployment，才需要在確認 preview 後視情況 merge 到 `main`，或手動 promote 指定 preview deployment。
* 目前可提供組員測試的穩定 production 版本仍是 `bd11d8b`；後續若有新功能通過驗收並推到 `main`，需更新本欄位與最新交接。

發布前檢查：

* 先執行 `git status --short --branch`，確認目前分支、dirty files 與是否有不屬於自己任務的變更。
* 先執行 `git log -1 --oneline`，確認目前 HEAD。
* 先執行 `git remote -v`，確認 remote 是 GitHub repo。
* 若有使用者 / 前面 agent 的未提交變更，不可 reset、checkout 或 revert；需先釐清是否要一起發布。
* 推 production 前至少跑：
  * `npm run lint`
  * `npm run build`

建議發布流程：

1. 確認使用者同意發布到 production。
2. 確認要直接推 `main`，或走 feature branch / PR。
3. 若使用者同意直接推 `main`：
   * 確認目前在 `main`。
   * 整理 commit。
   * `git push origin main`。
4. 推送後確認 Vercel deployment：
   * 用 Vercel dashboard 或 Vercel MCP 檢查最新 deployment。
   * 最新 deployment 應顯示 target：`production`。
   * state 應為 `READY`。
   * `githubCommitSha` 應對上剛推送的 commit。
5. 回報使用者：
   * commit hash。
   * Vercel production deployment 狀態。
   * 是否需要使用者正式站互動驗收。

風險規則：

* `git push origin main` 是公開 production 發布動作，必須先取得使用者明確同意。
* 若目前不在 `main`，或使用者想保守發布，優先走 feature branch + PR / merge。
* 若 Vercel 沒有自動部署，才考慮 dashboard 手動 redeploy / promote；不要預設需要手動 promote。
* 發布 SOP 如有變更，需同步更新本節。

---

# 9. 最新交接

新聊天框接手時：

* 必須先用 UTF-8 讀取 `PROJECT_SPEC.md`。
* 以本檔最新狀態為準；完整歷史只在需要查細節時讀取 `docs/archive/PROJECT_SPEC_FULL_BEFORE_COMPACTION_2026-04-18.md`。
* Phase 1 ~ 8A 已全部驗收通過（含正式站）。
* 可給組員測試的穩定版本：commit `bd11d8b`（Vercel production READY）。
* Phase 8B 已永久取消，不再執行。
* Phase 9A（AI 生成速度優化）已全部驗收通過：9A-1 prompt / schema 瘦身、9A-2 NDJSON streaming + 骨架卡片、9A-3 兩階段生成（骨架先出、詳情後補，含 context 架構提升與 loading 動畫）。
* Phase 9B（人設系統）已全部驗收通過：9B-1 欄位擴充、9B-2 個性化設定頁面（回顯、美化、狀態顯示）、9B-3/4 AI 整合與預設值。
* 下一步：**Phase 9C：地理約束 + 起點體驗**。
* 本地變更尚未推 production，可給組員測試的穩定版仍是 commit `bd11d8b`。9A 與 9B 的所有新實作都在 worktree 分支，尚未 merge 到 main。
* 若使用者要求查歷史規格或事故細節，再讀 archive；不要每次都把完整 archive 載入上下文。
