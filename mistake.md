# TripNeeder 生成流程事故復盤

## 2026-05-05 跨日餐期 occurrence 遺失

問題：`14:30-11:30` 這種跨日長行程會與「隔天午餐」重疊，但舊邏輯只回傳 lunch/dinner 的日內分鐘數。結果補餐和對齊檢查把隔天午餐誤當成當天 `11:00-13:00`，補餐被插到行程一開始，最後三個方案都因「餐飲停留未對齊午餐時段」被硬擋。

修正：`getRequiredMealWindows` 現在會回傳實際時間軸 occurrence，跨日餐期的 `start` / `end` 可以大於 `24 * 60`。例如 `14:30-11:30` 會需要晚餐與隔天午餐，隔天午餐 target 是 `24:00 + 12:00`。

驗證：新增單元測試覆蓋跨日餐期 occurrence。瀏覽器回歸重測 `21h` 從 0 方案恢復為 3 方案，且 `2h / 3h / 10h` 在修正後也維持 3 方案。

## 2026-05-05 雨天備案重複站點

問題：短行程詳情補完可產生雨備，但 AI 可能在 rainBackup 裡排入同一個 `placeId` 兩次，畫面看起來像同一家店來回跑。

修正：`/api/generate-trip-details` 在雨備 Places 驗證後、Routes 修復前，依 `placeId` 去重；沒有 `placeId` 時改用正規化後的 `name + address`。去重只作用在 `rainBackup`，不碰主行程。

驗證：重新生成 `3h` 並開啟 safe 詳情，切換雨天備案後顯示 2 個站點，沒有重複名稱，Google Maps 連結正常。

日期：2026-05-05

## 目前已成功穩定的功能

- 生成流程在真實 UI 測試中已通過 `2h / 3h / 10h / 21h` 四種時長。
- 同一手動起點 `澄清湖風景區` 下，四輪測試皆成功輸出三案：`safe`、`balanced`、`explore`。
- 詳情頁不再把目前生成中的方案替換成最近生成或收藏裡的舊方案。
- 生成完成後不再卡在分析畫面；前端收到完成事件即可結束等待。
- 失敗方案不會存入最近生成；最近生成會清掉上一輪固定方案 ID 的殘留。
- Google Places 驗證改成硬性要求真實地點、穩定 `placeId`、營業時間已知。
- 營業時間未知維持硬擋。
- 每站依實際時間軸驗證營業時間，不再用使用者開始時間檢查所有站。
- 停留結束需早於打烊前 30 分鐘。
- 後端可在本地用 10 分鐘粒度搜尋合法行程起點，不會為了試不同起點重複打 Places API。
- 凌晨到早晨的行程不再固定把站點塞到 `06:00`；會用完整時間窗與有效活動窗判斷。
- 餐飲規則已收斂為：只要 food stop 與餐期有重疊即可，不要求完整落在餐期內，也不因「看起來太早/太晚」硬殺。
- 長時間行程可補長、補站、調整餐飲位置，並重算交通與營業時間。
- 跨方案多樣性只做 soft diagnostic，不再因局部重複刪掉合法方案。
- 本地補案組合器預設停用，只能透過 `ENABLE_LOCAL_FALLBACK_REFILL=true` opt-in。
- `npm run lint` 與 `npm run build` 已通過；build 只有 Vite chunk size 警告。

## 這次真正卡住的地方

這次不是單一 bug，而是生成流程被多個「看起來合理」的保護機制互相干擾。

### 1. 後端太早、太用力干預 AI 原案

AI 初產的三案很多時候其實可用，但後端最後流程又做了：

- Google Places 修正
- 時段候選替換
- 營業時間驗證
- 交通重算
- 覆蓋率補長
- 餐飲補站
- 跨方案避讓
- 去重
- AI 補案
- 本地補案

問題是這些步驟不是單向收斂，有些會改動已經合法的方案，導致「原本可用」的 AI 方案被替換壞、刪掉，甚至剩一案或零案。

### 2. 營業時間驗證一開始沒有和實際時間軸完全一致

早期邏輯曾把同一個開始時間套到所有站，或固定用 `06:00` 當排程起點。結果是：

- 凌晨行程被錯誤塞到還沒開門的景點。
- 長時間行程後段被推到打烊後才檢查出錯。
- 10h / 19h / 21h 這類跨餐期或跨清晨行程特別容易歸零。

後來改成依 `stop.duration + transportSegments` 推整條路線時間軸，並在本地用 10 分鐘粒度找合法 timeline start。

### 3. 餐飲規則太疑神疑鬼

一度要求餐飲不只要開門，還要接近餐期中心或完整落在餐期中。這讓很多其實合理的餐廳被硬殺。

最後收斂為：

- 若行程時間窗與餐期有任何重疊，就要求該餐期有 food stop；12:45-09:45 這種長時間跨日行程需同時有午餐與晚餐。
- food stop 只要與餐期有任何重疊就通過餐期覆蓋。
- 餐廳本身仍需在安排的完整停留時間內營業，且離開時間需早於打烊前 30 分鐘。
- 補餐排序可以偏向餐期中段，但那只是排序策略，不是硬性門檻。

### 4. 跨方案多樣性被誤當硬規則

一開始為了避免兩案一模一樣，加入了 placeId 避讓與高度重複排除。這確實能增加多樣性，但也會在候選池不夠寬時把合法方案刪掉。

後來改成：

- 已合法方案不因多樣性被刪。
- 重複只記 log。
- 只有在 coverage repair 需要補站/補餐時，才對補進來的候選做輕量輪替。

### 5. 本地補案組合器解決錯問題

本地補案原意是補足少於三案，但它引入了新的風險：

- title / id / type 容易對不上，例如方案三 title 叫方案二。
- 用 Google 候選硬組路線容易不像 AI 原本語意。
- 它會遮住真正問題：為什麼合法 AI 原案會被後端弄掉。

所以目前決策是預設停用本地補案，只保留 opt-in fallback。

### 6. 詳情頁狀態用固定方案 ID 造成串案

`safe / balanced / explore` 是固定 ID。使用者在新一輪生成期間去看最近生成時，歷史詳情資料可能覆蓋目前生成中的同 ID 方案，造成 3h 方案二變成 13h 舊方案。

後來改成詳情狀態要依來源 scoped：

- 目前生成：`generated:<planId>`
- 歷史紀錄：`<source>:<recordId>`

## 這次如何解決

核心原則改成：

> 保留 AI 原始合法方案優先，不破壞已合法方案；只有真的缺失或不合法時才修復。

具體做法：

- final repair 分成保守模式與 coverage repair。
- 保守模式只補齊 Google 地點資訊與交通段；若通過硬性驗證，直接保留。
- 只有短站、時長不足、超出時間、缺餐等可修復問題存在時，才進 coverage repair。
- Places 查無地點、第一站超距、未知營業時間、實際營業時間不符仍維持硬擋。
- 交通占比高、同質景點多、局部重複只做診斷，不硬殺。
- AI 補案只補缺少的 plan ID，且補案 ID 需被收斂回指定的 `safe / balanced / explore`。
- 本地補案預設停用。
- 所有少案與零案要寫入 debug log，不能只回通用錯誤。
- 前端與最近生成狀態改成依來源隔離。

## 這次測試結果

最後真實 UI 回歸測試：

| 時長 | 時間窗 | 結果 |
|---|---:|---|
| 2h | 12:45-14:45 | 三案成功，三個詳情頁正常 |
| 3h | 12:45-15:45 | 三案成功，三個詳情頁正常 |
| 10h | 12:45-22:45 | 三案成功，晚餐 food stop 正常 |
| 21h | 12:45-隔日 09:45 | 三案成功，跨午夜時間軸正常 |

最新 debug log 四筆皆為 `generate-trip-done` 且 `planCount: 3`。

## 是否留下屎山代碼

誠實結論：有留下技術債，但不是完全不可救的屎山。

目前可接受的原因：

- 主要修正都有對應明確規格，不是純靠硬編例外。
- 最終流程已經回到「合法原案優先」這個正確方向。
- soft rule 與 hard rule 已分開，避免再次因節奏偏好殺光方案。
- 已有 debug log 能看出少案原因。
- 真實 UI 回歸測試已涵蓋短、中、長、跨日。

目前危險的地方：

- `api/generate-trip.ts` 承擔太多責任：串流、JSON fallback、Places grounding、Routes、營業時間、補案、補長、餐飲、品質診斷、最近紀錄提示幾乎都塞在一起。
- final repair 內部仍有多層 pass：保守修復、coverage repair、fallback attempt、post-timing alignment、meal realignment。雖然現在能跑，但閱讀成本高。
- 開放空間/公園偏多目前只做 soft diagnostic；產品體驗上可能仍顯得單調。
- 長時段行程為了滿足覆蓋率，仍會把一些公園拉長到很長，合理性可再優化。
- Debug log 有些中文因編碼問題變成亂碼，會影響日後追查。

## 更直線的正確做法

若之後有時間整理，建議不要再往 `generate-trip.ts` 繼續塞補丁，而是把生成流程拆成可測的 pipeline：

1. `candidatePoolService`
   - 負責 Places 搜尋、營業時間解析、角色分類、候選評分。

2. `timelineEngine`
   - 輸入 stops + transport。
   - 輸出每站抵達/離開時間。
   - 負責跨日、凌晨有效活動窗、10 分鐘粒度起點搜尋。

3. `hardValidator`
   - 只處理硬規則：Places、營業時間、打烊前 30 分鐘、超時、最低覆蓋率、最低停留、必要餐期。

4. `softQualityAnalyzer`
   - 只輸出診斷：同質景點、交通占比、跨方案重複、節奏單調。

5. `planRepairer`
   - 只在 hardValidator 失敗且問題可修復時動手。
   - 每次 repair 後重新跑 timelineEngine + hardValidator。

6. `planSelection`
   - 負責保留合法原案、補缺案、排序、少案提示。
   - 不直接改站點內容。

7. `detailStateScope`
   - 保證 generated / recent / favorite 的詳情狀態永遠隔離。

更理想的測試方式：

- 為 `timelineEngine` 寫純單元測試，不打 API。
- 為 `hardValidator` 建固定假 Places opening hours 測試，不打 API。
- 為 `planRepairer` 建 snapshot case，確保修復是單調改善，不會把合法案弄壞。
- 真實 UI 測試只跑少量 smoke cases，避免 API 成本爆炸。

## 下次避免重演的規則

- 新增硬擋前，先證明它不會刪掉已合法方案。
- AI 原案通過硬性驗證後，不得再被多樣性、節奏偏好、補案策略替換。
- 任何 repair 都必須說明它修的是哪個 hard issue。
- 補救功能不能遮住主流程錯誤；少案時先看 log，不先加 fallback。
- 長時間行程要先處理時間軸與候選池，再考慮補長。
- 規格變更要同步寫入 `PROJECT_SPEC.md`，事故復盤寫入本檔。

## 2026-05-05 第一階段重構紀錄

已完成第一階段「不改產品行為、先抽純規則」重構：

- 新增 `api/_lib/trip-planning-rules.ts`
  - 固定方案 ID。
  - 時間字串解析與格式化。
  - 跨日可用時間。
  - 凌晨有效活動窗。
  - 最低覆蓋率與補長目標。
  - 餐期需求啟用門檻。
  - 餐飲與餐期任意重疊判斷。

- 新增 `api/_lib/trip-plan-metrics.ts`
  - 方案實際總時長。
  - 本地估算交通總時長。
  - 長行程最低站數。
  - 預設停留時間與最低停留時間。

- 新增 `npm run test:unit`
  - 使用 Node 內建 test runner。
  - 不呼叫 OpenAI、Google Places、Google Routes 或 Supabase。
  - 第一階段時先覆蓋時間窗、覆蓋率、餐期與時長度量。

這一階段刻意沒有重寫整個 final repair，原因是 final repair 已經經過真實 UI 回歸測試，直接大改會增加重新打壞的風險。比較穩的路線是先把不碰 API 的純邏輯抽出來並上測試，下一階段再拆 `candidatePoolService`、`timelineEngine`、`hardValidator`、`planRepairer`。

## 2026-05-05 第二階段重構紀錄

已完成第二階段「繼續拆主流程，但仍避免重寫 final repair 行為」：

- 新增 `api/_lib/trip-timeline.ts`
  - 站點抵達時間推算。
  - early / middle / late 可用性 slot 判斷。
  - 餐期插入位置推算。
  - 整案抵達時間序列。

- 新增 `api/_lib/trip-quality-rules.ts`
  - 短站硬性門檻。
  - 午餐/晚餐必要覆蓋檢查。
  - 交通占比、同質景點、連續開放空間等 soft diagnostic。
  - 站點 rhythm role 分類。

- 新增 `api/_lib/trip-repair-strategy.ts`
  - safe / balanced / explore 顯示順序。
  - coverage repair target minutes。
  - 跨方案候選輪替 offset。
  - rotated item pick。

- 修掉抽檔過程的隱藏危機：
  - `trip-plan-metrics.ts` 的中文 regex 曾在抽檔時變成亂碼，導致 Vite restart 出現 invalid regular expression；已改回與原 `generate-trip.ts` 一致的中文規則。
  - `generate-trip.ts` 中已移除抽出後的重複函式與 unused import，避免同一規則兩份實作再次漂移。
  - `getRequiredMealWindows` 原本仍用餐期重疊至少 45 分鐘才啟用必要餐期，造成 12:45 開始的 21h 行程只要求晚餐、不要求午餐；已改成只要與餐期有任何重疊就啟用，符合「用餐只要跟餐期有重疊」規格。
  - 10h 回歸時發現 `main_activity` 中段低於 45 分鐘仍被硬擋，和已確認的「非餐飲至少 40 分鐘」規格不一致；已改成只保留 soft diagnostic，不再因此刪掉合法方案。

- 測試現況：
  - `npm run test:unit` 目前 27 個測試通過。
  - `npm run lint` 通過。
  - `npm run build` 通過，僅保留 Vite chunk-size warning。
  - 瀏覽器 reload `http://localhost:5173/plans/explore` 後 console 無 error。

這次重構沒有再呼叫真實 OpenAI / Google API；目的就是先把昨晚已用真實 UI 驗過的行為用本地測試鎖住，避免為了測重構一直花 API 額度。

## 2026-05-05 端到端回歸紀錄

實際用 in-app browser 走完整生成流程，起點固定為「澄清湖風景區」、開始時間 12:45：

- 2h：三案成功，無 `Failed to fetch`，無最終驗證全排除。
- 3h：三案成功，無 `Failed to fetch`，無最終驗證全排除。
- 10h：餐期修正後一度只剩兩案，原因是「中段主景點 <45 分鐘」被當硬擋；已改成 soft diagnostic 後三案成功。
- 21h：餐期修正前只有晚餐沒有午餐；修正後三案成功，詳情頁三案皆有午餐與晚餐餐飲停留。
- 詳情頁：21h 的 safe / balanced / explore 三案皆可開啟，雨天備案與換一站入口存在；詳情補完可完成，但 21h safe 曾耗時約 96 秒，balanced / explore 約 45-47 秒，屬後續效能優化點。

這輪實測揭露的核心教訓：

- 單元測試通過不代表長時段餐期真的正確，因為插入位置與 Routes 後時間軸會互相影響。
- 必要餐期不能只看 food stop 數量，要看每個 food stop 實際對齊哪個餐期。
- 當使用者開始時間已落在餐期內，補餐必須允許插到第 0 站。
- 多於已確認規格的硬擋會直接造成少案；若只是節奏偏好，應留在 soft diagnostic。

## 2026-05-05 詳情補完效能錯誤

### 問題
詳情頁原本把「補描述」做成「重新輸出整份完整 plan」：

- AI 被要求回傳主方案所有 stops、transportSegments、rainBackup 與 rainTransportSegments。
- 後端收到後又對主行程跑 Places 驗證與 Routes 修復。
- 21h 長行程的 rainBackup 幾乎無法達到完整長行程覆蓋率，常常生成後又被雨備品質檢查移除。

結果是使用者只是打開詳情頁，卻觸發大量不必要工作。實測舊版 21h 詳情補完：safe 約 52 秒、balanced 約 58 秒、explore 約 47 秒，其中 OpenAI 輸出約 7.6k-8.1k 字，Google Routes 已不是主要瓶頸。

### 修正

- 詳情補完改成增量 schema：主方案只回 `id + description` 與交通 `fromStopId + toStopId + label`。
- 後端合併時保留原本已驗證的主方案地點、placeId、地址、停留時間、順序、總時長與交通 duration。
- 詳情頁不再重跑主行程 Places；只驗證雨備。
- 主行程 Routes 只有缺段或 from/to 對不上時才補算。
- 可用時間超過 8 小時的長行程預設不請 AI 產生雨備，直接空 rainBackup，避免昂貴但必定被移除的補案。
- 加上 `[detail-performance]` 階段 log，之後看到慢就能直接定位。

### 實測結果

同樣 21h 條件重新生成三案後，只打開 safe 詳情頁：

- 生成結果仍為 3 案。
- safe 詳情補完約 11.6 秒完成。
- OpenAI 輸出降為約 2.1k 字。
- `includeRainBackup=false`，未查室內候選，未重跑主線 Routes。
- 主方案站點、時間、placeId 與交通 duration 由原骨架保留。
