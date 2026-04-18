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

重要資料表 / RPC：

* `profiles`：使用者點數與帳號資料。
* `point_transactions`：點數交易紀錄。
* `trip_records`：收藏 / 最近生成。
* 點數交易每位使用者最多保留最新 30 筆。
* 最近生成最多 12 筆。

---

# 5. 已驗收 Phase 狀態

* Phase 1：Vite + React + TypeScript + React Router 專案骨架，已驗收通過。
* Phase 2：首頁一頁式行程偏好表單，已驗收通過。
* Phase 3：OpenAI 三方案生成、嚴格 JSON schema、loading/error flow、sessionStorage 暫存、結果頁三方案卡片，已驗收通過。
* Phase 4A：詳情頁閱讀版、時間軸、雨天整頁切換、景點簡介、Google Maps / 開始導航按鈕，已驗收通過。
* Phase 4A-1：交通段模型、卡片間交通快速瀏覽、交通時間納入時間軸計算、大眾運輸細分欄位，已驗收通過。
* Phase 4B：交通資料模型整理，`Stop.id`、`TransportSegment.fromStopId/toStopId/label`、舊 sessionStorage fallback，已驗收通過。
* Phase 4C：`@dnd-kit` 拖曳排序，一般 / 雨天各自排序，拖曳後時間軸與交通段重算，超時 confirm rollback，已驗收通過。
* Phase 4D：全域 / 單段交通切換、本地估算、超時確認 rollback，已驗收通過。
* Phase 4E：首頁新增 `不吃正餐` tag，午餐 / 晚餐任意重疊規則，早餐不列入本階段正餐判斷，已驗收通過。
* Phase 5：收藏與最近生成，localStorage 最多 12 筆，收藏整個目前編輯後 TripPlan，收藏 / 最近卡片，收藏移除確認，已驗收通過。
* Phase 6A：Mobile polish / PWA 基礎，manifest、icon、service worker、手機版主要頁面微調，已驗收通過。
* Phase 6A-1：分析流程狀態保留、行程規劃導覽回到目前流程位置、結果頁 `重新選擇偏好`、10 分鐘 session 有效期，已驗收通過。
* Phase 6A-2：App 內 modal / dialog 系統，替換原生 `alert` / `confirm`，已驗收通過。
* Phase 6B：prompt 微調、其他類型欄位必填提示、使用者可理解錯誤文案、時間偏鬆柔性提示，已驗收通過。
* Phase 6C-1：首頁行程規劃視覺整理，已驗收通過。
* Phase 6C-2：結果頁三方案比較視覺整理，已驗收通過。
* Phase 6C-3：詳情頁視覺整理收斂與雨天備案按鈕主次調整，已驗收通過。
* Phase 6C-4：收藏 / 最近生成頁視覺整理與全域一致性收尾，已驗收通過。
* Phase 7A：Supabase Auth、登入頁、未登入阻擋、選單新增點數管理，已驗收通過。
* Phase 7B：Supabase 點數 schema、profiles、point_transactions、點數頁讀取，已驗收通過。
* Phase 7C：Vercel Functions OpenAI proxy，API key 移出前端，已驗收通過。
* Phase 7D：點數檢查、成功扣 20 點、點數不足阻擋、失敗不扣點，已驗收通過。
* Phase 7E：點數管理器本機工具，已驗收通過。
* Phase 7F / 7G：正式站登入、OAuth session handling、正式站修正，已驗收通過。
* Phase 8A：收藏 / 最近生成同步到 Supabase，正式站已驗收通過。

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

# 8. 下一階段規劃

下一階段可進入 Phase 8B：`正式試用前資料與營運收尾`。

Phase 8B 建議範圍：

* 組員試用說明：登入、點數、扣點、收藏 / 最近生成、問題回報方式。
* 點數管理器使用 SOP：補點、扣點、防呆、service role key 不外流。
* Supabase 資料檢查 SOP：`profiles`、`point_transactions`、`trip_records`。
* Vercel domain / Supabase redirect 設定變更注意事項。
* 試用回饋清單模板：登入問題、AI 結果品質、扣點問題、收藏同步問題。

重要：不可由 agent 自行跳入 Phase 8B；必須等待使用者明確指示開始 Phase 8B。

---

# 9. 最新交接

目前任務暫停，使用者準備切換新聊天框。

新聊天框接手時：

* 必須先用 UTF-8 讀取 `PROJECT_SPEC.md`。
* 以本檔最新狀態為準；完整歷史只在需要查細節時讀取 `docs/archive/PROJECT_SPEC_FULL_BEFORE_COMPACTION_2026-04-18.md`。
* Phase 8A 已正式站驗收通過。
* 可給組員測試的穩定版本是 `bd11d8b`。
* 下一步是 Phase 8B，但必須等使用者明確指示開始。
* 若使用者要求查歷史規格或事故細節，再讀 archive；不要每次都把完整 archive 載入上下文。
