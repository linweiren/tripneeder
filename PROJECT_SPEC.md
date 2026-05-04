# PROJECT_SPEC.md

TripNeeder 是一個 AI 即時行程決策 Web App。此檔為目前有效主規格與交接文件。

讀取規則：必須以 UTF-8 讀取本檔，避免繁體中文亂碼。

---

# 1. 永久協作規則

* 全程使用繁體中文回覆，不要使用簡體中文。
* 任何新增或修改後確認下來的規格，都要同步寫進 `PROJECT_SPEC.md`。
* UI 細節不清楚時要先問使用者，尤其是資訊顯示位置、卡片內容、詳情頁內容、按鈕文案等。
* 本機驗收網址優先使用 `http://localhost:5173/`。
* 避免用 `cmd /c start` 啟動 dev server。
* 不要 reset、checkout 或 revert 任何使用者 / 前面 agent 的變更。
* OpenAI API key 不可放前端，AI 呼叫需走 Vercel Function server-side。
* `SUPABASE_SERVICE_ROLE_KEY` 只供本機工具使用，不放進前端。

---

# 2. 產品定位與核心目標

**產品定位**：Tripneeder 是「使用者已經在現場 / 附近，快速產生接下來幾小時行程」的工具，不是完整旅遊規劃 AI。

**核心目標**：使用者輸入目前位置與可用時間後，AI 產生三個可比較的一日行程方案，使用者可查看詳情、調整交通、收藏方案。

**產品邊界**：
* 主流程是「即時行程決策」，不包含訂票、付款。
* AI 回傳需符合嚴格 JSON schema。
* 僅支援登入使用者（必須有帳號才能使用核心功能）。

---

# 3. 目前功能重點 (V1.0 穩定版)

### 3.1 核心頁面 (全頁面極速加載)
* **首頁 (現場快速模式)**：主 CTA 為「使用目前位置」，支援時長 Chip (1h/2h/3h/半天/全天/自訂)。
* **結果頁**：三方案骨架卡片串流顯示。
* **詳情頁**：時間軸、雨天備案、交通切換、拖曳排序、自動補完細節。
* **個人化中心**：收藏、最近生成、人設設定、點數中心（全部採用快取預載，點擊即顯示）。
* **人設設定重設**：使用者可一鍵清除個性化 override；資料庫 persona 欄位回到未設定狀態，`persona_people` 清為 `null`，人數欄顯示未設定，AI 生成時依既有 fallback 使用系統預設 2 人。
* **首頁偏好來源提示**：首頁「更多偏好設定」需顯示目前偏好來源摘要；展開後逐項標示本次設定、個性化或系統預設，讓使用者理解 AI 生成套用的 fallback 狀態。

### 3.2 AI 生成邏輯
* **兩階段生成**：骨架串流 + 詳情補完。
* **地理約束**：起點 2km 約束、Google Places 驗證與 Search-Inject 修正。
* **權重規則**：進階表單 > 個性化人設 > 系統預設。

### 3.3 數據同步與效能
* **全域預載 (Pre-fetch)**：使用者登入成功後，立即異步抓取所有用戶資料（點數、人設、紀錄）。
* **本地優先 (Optimistic UI)**：任何操作（如收藏、儲存人設）先反映在 UI 並更新本地快取，背景才與伺服器同步。

---

# 4. 技術架構與關鍵事實

* **前端**：Vite + React + TypeScript + Vanilla CSS。
- **後端**：Vercel Function (`api/`) server-side 呼叫 OpenAI。
- **AI 模型**：`gpt-4.1-mini` (NDJSON Streaming)。
- **資料庫**：Supabase (Profiles, Point_transactions, Trip_records)。
- **外部 API**：Google Places (New), Geocoding, Routes API。
- **快取機制**：Memory Cache + SessionStorage。不再支援無帳號 Legacy 遷移邏輯。
- **依賴管理**：Service 層採取懶加載與解耦設計，避免 Context 循環引用。

---

# 5. 已驗收功能清單 (Phase 1 - 9)

本專案已完成第一階段所有核心規劃：

*   **基礎與生成優化 (P1-P3, P9A)**：Vite 骨架、AI 三方案、NDJSON Streaming、兩階段生成。
*   **行程互動與編輯 (P4, P9F)**：時間軸互動、雨天備案、交通切換、`@dnd-kit` 排序。
*   **產品模式與驗證 (P9C-P9E)**：定位反查、現場快速模式、Google Places 驗證修正。
*   **帳號與效能優化 (P7-P9B, P9G, 2026-05 重構)**：Supabase Auth 整合、點數保護、全站快取預載優化、移除 Legacy 冗餘邏輯、建立 `tests/` 管理調試腳本。

---

# 6. 下一階段預告：大改版規劃

*目前 Phase 1-9 已全數結案。新規劃待使用者提交。*
