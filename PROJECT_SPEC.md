# TripNeeder 核心技術規格書 (精簡交接版)

本文件為 TripNeeder 的核心規格與技術實作指南。旨在保留「產品定義」、「現有功能」以及「深度技術邏輯」，並移除開發過程中的冗餘流水帳。

---

## 1. 專案核心介紹 (Core Vision)

### 1.1 產品定位
TripNeeder 是一個 **AI 即時行程決策 Web App**。
其核心場景是：使用者已經在當地或即將抵達某處，需要在極短時間內（< 1分鐘）獲得 3 個可選的一日行程方案，並能快速調整交通與查看備案。

### 1.2 產品邊界
*   **核心功能**：偏好輸入、AI 三方案生成、兩階段細節補完、雨天備案、交通切換、收藏同步、點數管理、PWA。
*   **非目標**：本產品不處理完整訂票、複雜社群分享或長期旅遊規劃。

---

## 2. 功能地圖 (Feature Map)

| 頁面/模組 | 檔案位置 | 核心功能說明 |
| :--- | :--- | :--- |
| **首頁 (Home)** | `src/pages/HomePage.tsx` | 偏好表單（人設自動填入）、現場快速模式、AI 生成啟動與串流顯示。 |
| **結果頁 (Results)** | `src/pages/ResultsPage.tsx` | 三方案骨架展示、比較。點擊方案觸發「預先細節補完」。 |
| **詳情頁 (Detail)** | `src/pages/DetailPage.tsx` | 時間軸、**兩階段自動補完**、雨天備案切換、`@dnd-kit` 拖曳排序、收藏。 |
| **收藏頁 (Favorites)** | `src/pages/FavoritesPage.tsx` | 展示 Supabase 同步的收藏行程。 |
| **個人設定 (Persona)** | `src/pages/PersonaPage.tsx` | 編輯人設（同行對象、預算、體力、飲食）。 |
| **點數中心 (Points)** | `src/pages/PointsPage.tsx` | 查看點數餘額與最新 30 筆交易紀錄。 |
| **生成代理 (Proxy)** | `api/generate-trip.ts` | Vercel Function：處理 Auth、扣點、OpenAI 串流。 |

---

## 3. 核心技術邏輯 (Technical Deep Dive)

這部分詳細記錄了系統最複雜的運作邏輯，請在維護或重構時優先參考。

### 3.1 AI 兩階段生成機制 (Two-Stage Generation)
為了解決 AI 生成過慢（> 2分鐘）的問題，系統採用了兩階段策略：
1.  **第一階段：骨架生成 (Skeleton)**
    *   **發起點**：首頁送出表單。
    *   **輸出內容**：三方案的標題、摘要、站點名稱、時間點。**不包含** 景點詳細描述、雨天備案內容。
    *   **技術特點**：使用 NDJSON 串流。
    *   **扣點時機**：當第一張方案的骨架成功傳回前端時，即扣除 20 點。
2.  **第二階段：細節補完 (Detail Completion)**
    *   **發起點**：結果頁「選擇此方案」或詳情頁掛載。
    *   **輸出內容**：該方案的景點描述、雨天備案細節、精確交通標籤。
    *   **技術特點**：在 `AnalysisSessionContext` 層級執行，切換頁面不中斷；不額外扣點。

### 3.2 NDJSON 串流與 Brace Counter 解析
*   **原理**：AI 一邊產生 JSON，Vercel Function 就一邊將資料推送到前端。
*   **解析器 (`api/_lib/PlanExtractor`)**：使用「括號計數器」狀態機。它會追蹤 `{` 與 `}` 的數量，一旦計數器歸零且非處於字串轉義狀態，即認定一個完整的 `Plan` 物件已完成並立即推送到 UI。
*   **優點**：使用者在第 15~20 秒就能看到第一個方案，而非等待兩分鐘。

### 3.3 方案指紋 (Plan Fingerprint) 計算邏輯
這是判斷方案是否「已收藏」或「重複生成」的核心標識。
*   **公式**：對 `plan` 物件中 **不可變的關鍵欄位** 進行 JSON 序列化後求 Hash。
*   **排除欄位 (重要)**：必須排除 `transportSegments[].label` 與任何可能被前端格式化的顯示文字。
*   **包含欄位**：景點名稱、時間、順序、核心交通類型。
*   **程式碼位置**：`src/utils/tripPlanStorage.ts` 中的 `createPlanFingerprint`。

### 3.4 人設覆寫權重 (Priority Rules)
系統會自動決定 AI 使用哪組資料，優先級如下：
1.  **最高**：首頁「進階設定」手動填寫的值。
2.  **中等**：`PersonaPage` 儲存的人設設定。
3.  **最低**：系統中性預設（情侶/約會、一般預算、體力普通、無飲食）。

### 3.5 地理約束與 Google API 整合
*   **地理權重**：Prompt 硬性規定「第一站距離起點 ≤ 2km」，由 Google Geocoding 確保座標準確度。
*   **目前位置反查**：使用 Google Geocoding API 將 GPS 座標轉換為使用者可讀的行政區地名。
*   **API 代理**：所有 Google API 與 OpenAI 呼叫均經過 `api/` 資料夾下的 Serverless Functions，確保 API Key 不會暴露在瀏覽器。

---

## 4. 資料結構與遷移 (Data & Sync)

### 4.1 Supabase Table 定義
*   **`profiles`**: 儲存 `id`, `email`, `points` (餘額), 以及人設欄位 (`persona_*`)。
*   **`trip_records`**: 儲存行程。
    *   `type`: 'favorite' (收藏) 或 'recent' (最近生成)。
    *   `plan_fingerprint`: 唯一的方案標識。
    *   `content`: 完整的 JSON 內容。
*   **`point_transactions`**: 紀錄點數變動，設有使用者 30 筆上限的 Retention 觸發器。

### 4.2 歷史 Key 遷移紀錄 (LocalStorage Migration)
為了防止舊使用者資料遺失，系統會自動遷移以下 Key：
1.  `tripneeder.favoritePlans` (最早期全域收藏)
2.  `tripneeder.favoritePlans.<userId>` (中期分帳號收藏)
3.  `tripneeder.recentPlans.<userId>` (中期分帳號最近生成)
*   **遷移邏輯**：登入時若偵測到這些 Key，會自動同步至 Supabase 並清空本地快取。

---

## 5. 關鍵技術陷阱 (Critical Gotchas)

*   **React StrictMode 陷阱**：在開發環境會執行兩次 Effect，曾導致串流解析器雙倍初始化，已透過 `AbortController` 與 `ref` 修正。
*   **Z-Index 競爭**：App 內部的 Dialog 系統層級需高於 `@dnd-kit` 的拖曳層，否則拖曳時會被遮蓋。
*   **Vercel Timeout**：AI 生成有時會超過 10s，需在 `vercel.json` 設定 `maxDuration: 300` 確保串流不中斷。

---

## 6. 後續開發路徑 (Roadmap)

*   **Phase 9D**：Google Places 地點驗證（防止 AI 幻覺虛擬景點）。
*   **Phase 9E**：首頁「現場快速模式」UI 優化，強化「目前位置」驅動。
*   **Phase 9F**：局部編輯功能，允許單站替換並透過 Google Routes 重算時間。

---
最後更新時間：2026-04-23
整理者：Gemini CLI (Senior Engineer Mode)
