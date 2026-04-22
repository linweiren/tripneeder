# Google Maps Platform 設定指南

本文件引導您完成 TripNeeder 所需的 Google Places API (New) 與 Geocoding API 設定。這些 API 將用於驗證 AI 產生的景點真實性，並提供精準的地點資訊與地圖連結。

---

## 步驟 1：建立 Google Cloud 專案

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)。
2. 點擊頁面頂端的專案下拉選單，選擇「**新建專案**」(New Project)。
3. 輸入專案名稱（例如：`tripneeder-prod`），點擊「**建立**」。

## 步驟 2：啟用必要的 API

TripNeeder 需要以下兩個 API：

1. **Places API (New)**：用於驗證景點是否存在並取得 Place ID。
2. **Geocoding API**：用於將您的目前座標轉為可讀的地址（如：高雄市鼓山區）。

**操作流程：**
1. 在左側導覽選單中，前往「**API 和服務**」 > 「**庫**」(Library)。
2. 在搜尋框中分別輸入並搜尋 `Places API (New)` 與 `Geocoding API`。
3. 進入該 API 頁面後，點擊「**啟用**」(Enable)。

## 步驟 3：建立並限制 API 金鑰

為了安全起見，API 金鑰必須設定使用限制，防止被他人盜用。

1. 前往「**API 和服務**」 > 「**憑證**」(Credentials)。
2. 點擊「**建立憑證**」 > 「**API 金鑰**」。
3. 系統會彈出一個金鑰（請先複製下來）。點擊該視窗中的「**編輯金鑰**」或「**管理金鑰**」。
4. **API 限制**：
   - 選擇「**限制金鑰**」。
   - 在下拉選單中勾選 `Places API (New)` 與 `Geocoding API`。
5. **應用程式限制**：
   - **本機開發時**：建議先設為「無」，方便開發。
   - **正式上線時**：建議設為「IP 地址」（用於 Vercel Function Server 端伺服器 IP）或「HTTP 參照位址」（如果您會在前端直接呼叫 API，但 TripNeeder 建議走 Server 端）。
   - *註：由於 TripNeeder 的 Places 驗證是在 Vercel Function (Server-side) 執行，最安全的做法是限制該 Key 只能被特定的 API 呼叫。*
6. 點擊「**儲存**」。

## 步驟 4：設定環境變數

請將取得的 API Key 加入以下環境中：

### A. 本機開發 (.env)
在專案根目錄的 `.env` 檔案中加入：
```env
GOOGLE_PLACES_API_KEY=您的金鑰內容
```
*注意：請確保 `.gitignore` 已包含 `.env`，不要將金鑰推送到 GitHub。*

### B. Vercel 生產環境
1. 前往 Vercel Dashboard，選擇 `tripneeder` 專案。
2. 前往 **Settings** > **Environment Variables**。
3. 新增 `GOOGLE_PLACES_API_KEY`，值填入您的金鑰。
4. 點擊 **Save**。

---

## 步驟 5：付費帳戶與預算警報 (重要)

Google Maps Platform 提供每月 200 美元的免費額度，這對個人測試來說通常綽綽有餘，但仍必須綁定信用卡才能啟用。

### 1. 啟用計費
1. 前往「**結算**」(Billing) 頁面。
2. 依照指示連結信用卡或銀行帳戶。

### 2. 設定預算警報（防止意外扣款）
1. 在「結算」頁面中，點擊左側的「**預算與警報**」。
2. 點擊「**建立預算**」。
3. 建議目標金額設為 `$1` 或 `$10`。
4. 設定當預算達到 50%、90% 時發送電子郵件通知。

### 3. 設定配額上限
為了絕對保險，您可以限制每日呼叫次數：
1. 前往「**API 和服務**」 > 「**已啟用的 API 和服務**」。
2. 點擊 `Places API (New)`。
3. 點擊「**配額**」(Quotas) 頁籤。
4. 找到 `Requests per day`，將其限制在一個安全範圍內（例如：1000 次）。

---

## 步驟 6：成本監控與 Quota 提醒 (9D-6)

### 1. 估算成本
- **Geocoding API**：約每 1000 次請求 $5。
- **Places API (New) - Text Search**：約每 1000 次請求 $35。
- **TripNeeder 消耗**：每次「分析行程」會消耗：
  - 1 次 Geocoding (反查起點地名)
  - **(9D-7)** 1-2 次 Places Search (用於前置搜尋真實景點清單)
  - 至少 3 次 Places Search (每個方案產出後進行二次驗證)
  - 每次分析約消耗 $0.6 - $0.8 美元 (視方案站數而定)。

### 2. 設定每日上限
為了避免 API 金鑰被盜刷或程式錯誤造成爆刷，請務必設定上限：
1. 前往「**API 和服務**」 > 「**配額與系統參數**」。
2. 找到 `Places API (New)`，將 `Requests per day` 設為一個合理的數字（例如：500）。
3. 找到 `Geocoding API`，將其 `Requests per day` 設為 1000。

### 3. 定期檢查
建議每週登入一次 Google Cloud Console 檢查「**結算**」頁面，確認費用在預期範圍內。
如果您看到異常流量，請立即：
1. 撤銷舊 API Key 並產生新的。
2. 檢查 Vercel 上的 Log 看看是否有攻擊或重複呼叫。

---

## 驗收檢查清單
- [ ] 已在 GCP Console 建立專案。
- [ ] 已啟用 `Places API (New)` 與 `Geocoding API`。
- [ ] 已產生 API Key 且限制僅能呼叫上述兩個 API。
- [ ] 本機 `.env` 已設定 `GOOGLE_PLACES_API_KEY`。
- [ ] 已在 GCP 設定預算警報。
- [ ] **(9D-6)** 已設定 API 每日呼叫上限 (Quota limits)。
