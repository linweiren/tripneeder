# 首頁進階設定收合後的 Safari 空白修正

日期：2026-11-05。基底：dev `582cd0a`。

## 根因與範圍

`HomePage.tsx` 的 `showAdvanced` 正常切換 class 並掛載／移除
`.advanced-settings-panel`，收合後該節點已不存在。

`.home-page-layout` 是依內容決定列高的 Grid；其中 `.home-page` 及
`.home-trip-form` 在展開、收合狀態都設了 `height: auto; min-height: 100%`。
百分比最小高度與外層自動列高形成尺寸依賴，WebKit 在內容移除後仍保留
展開時的列高。Chrome 可正常縮回，因此單看 Chrome 無法發現此問題。

WebKit、390px 手機模擬的實測：首次首頁高度 675.78px，展開後 2678.69px；
修正前收合仍為 2678.69px。只將這兩層的百分比最小高度改成 `0` 的對照測試，
即可讓每次收合恢復 675.78px，確認問題來自尺寸限制而非殘留 React 內容。

修正僅變更 `App.css` 三處 `min-height: 100%` 為 `min-height: 0`，
保留 `height: auto` 與原有 Grid、Flex 配置。已檢查 `.app-main` 的
`flex: 1 0 auto` 與 `.home-page-layout`，無須變更它們的高度或斷點。
未增加固定高度、負 margin 或 JavaScript 重排處理。

## 驗證

透過實際 React 首頁，使用本機登入、定位及天氣 fixture，攔截網路請求；
未連正式資料庫、天氣服務或行程生成 API。Playwright 1.64.1、WebKit 27.2
及本機 Chrome 完成以下 7 組測試，每組首次載入後展開／收合 5 次：

| 瀏覽器與視窗 | 結果 |
| --- | --- |
| WebKit iPhone 模擬 390×664 | 通過 |
| WebKit iPhone SE 模擬 320×568 | 通過 |
| WebKit 900×1200 | 通過，天氣面板在下方 |
| WebKit 901×1200 | 通過，天氣面板在右側 |
| WebKit 1360×1000 | 通過，保留桌面側欄 |
| Chrome 手機模擬 390×844 | 通過 |
| Chrome 1360×1000 | 通過，保留桌面側欄 |

檢查內容：進階區塊展開後位於設定卡片之後、收合後完全移除、首頁與表單
恢復首次高度、手機首頁與天氣側欄保留原 18px Grid gap、桌面維持雙欄。
瀏覽器未發生未處理例外或非預期 API 請求，並已檢視手機展開／收合及桌面截圖。

- `npm run build`：通過。
- `npm run lint`：通過。
- `npm test`：1784 項，1781 通過、3 跳過、0 失敗。

人工回歸時，以已登入帳號開啟首頁，先記錄 `.home-page` 的高度，再點擊
「更多偏好設定」及「收起進階設定」，反覆操作並比較收合後的高度。
手機天氣面板應接在設定區之後；大於 900px 時應維持右側 sticky 側欄。

此變更只涉及首頁 CSS 與本驗證紀錄；不更動 API、行程生成或資料庫。
