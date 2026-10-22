# Culture Evidence Projection v1

基準：dev `342847c`。只修改 `api/_lib/trip-intent-candidate-grounding.ts` 的 Prompt 專用投影；沒有修改共用分類 helper、搜尋、排名、個人化、選站、Grounding、Repair、Fallback、Duration、Meal、Validation 或公開 API。沒有付費呼叫。

## 證據與語意

原有 `culture_primary`、`coffee_venue`、`mixed_or_uncertain` 的判斷保持原樣。新增 `culture_related_unverified`，只從本次 `getPromptCandidateSelection(...).promptCandidates` 中，選取未通過原文化主用途 helper、但既有 types 包含 `historical_landmark` 或 `historical_place` 的 ID。

不讀名稱推測藝術，不把 `tourist_attraction`、`scenic_spot`、`main_activity`、`cultural_center`、書店或商場直接升格。這不是新的候選分類、分數或硬性配額。文化相關線索可與既有咖啡／不確定提示並存；它不改變候選角色、不證明文化主用途、獨立咖啡或正式供餐。已通過 culture_primary 的博物館不另列成較弱線索。

實際說明文字：

```text
CURRENT_INTENT_CANDIDATE_LINKS:
本次需求：文化景點＋咖啡廳；文化需求不因歷史咖啡偏好降低。僅列已曝光ID，沿用排序與score。
culture_primary＝文化主用途證據；coffee_venue＝咖啡提示；mixed_or_uncertain＝用途待確認。
culture_related_unverified＝types有歷史線索，非已確認展覽、導覽或文化活動；勿據此虛構內容。
未列不代表沒有文化價值。室內桶不是文化證據，附設咖啡不證明獨立咖啡體驗或正餐。
不強制選用或跨案換點；依可行性兼顧需求、其他活動及各風格。營業、首站、餐期、交通優先；咖啡非可靠正餐，勿猜測展覽、導覽、菜單或活動深度。
{"culture_primary":[],"coffee_venue":[],"mixed_or_uncertain":[],"culture_related_unverified":[]}
END_CURRENT_INTENT_CANDIDATE_LINKS
```

上方空陣列是格式示例。原 parser 啟用條件不變：只有明確、正向、恰為文化＋咖啡的需求使用區塊。其他需求仍回傳空字串。

## 大小與原有資訊保護

整塊仍限制 1,800 UTF-8 bytes（含標記；前方分隔換行沿用原本兩個 bytes）。先分配原有三組，每組最多三個完整 ID；最後才用剩餘空間加入最多四個歷史線索。精簡重複說明已支付新增空 key 的成本；無線索時比原區塊少 1 byte。原三組不被線索擠掉，長 ID 直接略過而不截斷；不裁切或重排候選。

新增資訊仍沿用原本 `nearbyPlaces` 接點，initial、JSON recovery、retry、refill 的 builder 不變，不新增另一份區塊。

## 第三次真實資料的離線比較

來源：`db8ff9ce-96d3-4b22-8527-4dc081ef548e`，2026-10-22，dev `342847c`。只讀原六檔，未重新生成。

自包含 fixture `tests/unit/fixtures/culture-evidence-projection.mjs` 凍結實際38個曝光ID與順序、名稱、types、role、score、距離、slots，以及其他已保存投影可取得的 foodSubtype。未知欄位維持未知。它只供 Prompt 投影測試，不是完整搜尋池或行程重播；未保存的地址不補造，空 opening windows 是 selector 測試轉接，不代表真實營業窗。測試不讀原調查目錄、scripts、舊 mock、Meal 備份或帳號事件。

| 項目 | 修改前 | 修改後 |
| --- | --- | --- |
| 曝光ID／順序 | 38 | 同一38個、同順序 |
| culture_primary | 0 | 0 |
| coffee_venue | 草圖、Delicatesse、Furu | 完全相同 |
| mixed_or_uncertain | 晴。晨、莓塔、小倉廚 | 完全相同 |
| culture_related_unverified | 無此欄位 | 高雄燈塔、雄鎮北門、新濱老街、旗津老街 |
| 光之穹頂、城市光廊、駁二塔 | 非確認文化 | 不猜測升格 |
| 區塊 UTF-8 bytes | 1,030 | 1,148（+118） |
| 區塊本地 token 粗估 | 313–565 | 337–583 |

同一啟發式端點的 token 增量約18–24，不是 tokenizer 或供應商 usage，也不是保證界限。依原保存的全文長度加上區塊差額，initial 為23,601→23,719 bytes、retry 為24,153→24,271 bytes。完整歷史 Prompt 本來就未保存；這是長度推導，不是假稱還原或重送原請求。

四個完整新 ID：

- 高雄燈塔：`ChIJifn-9_ADbjQRTR2Q9DmlzEo`
- 雄鎮北門：`ChIJTc5MKfEDbjQRQ7UUWqpeQhA`
- 新濱老街：`ChIJWSxbrYoDbjQRqKW-W4bCuHQ`
- 旗津老街：`ChIJay59ifEDbjQRld7ipbyyH-4`

## 免費 regression

新增投影測試涵蓋真實38個ID、原三組完整保留、明確博物館／美術館、附咖啡博物館不計獨立咖啡或午餐、同名不同ID、未曝光／未知營業／關閉／無slots、一般公園／河灣／商場／觀景台／藝術商號／書店反例，以及長ID／預算不足時的保留與略過。

既有完整重播擴充歷史線索、失效retry與補案情境，共18組。以 Git `342847c` 的原投影及原 handler 作比較，使用相同目前依賴與固定 AI／Places／Routes／點數回應；未知網路入口拒絕。逐一深度核對正式 response、串流事件、所有外部請求及順序。只有 AI content 的這一區塊不同；原三組ID相同，其餘Prompt及所有請求參數相同。既有非文化＋咖啡情境的 Prompt 逐字不變。每次initial／retry／補案實際mock AI請求都只有一塊，新增的retry與補案均驗證四個非空歷史線索。

固定回應比較不能證明真實AI更願意選歷史地點、能提供文化活動深度或一定減少成本。此投影沒有新增呼叫入口；真實模型如果改選地點，既有下游路線需求仍可能不同。

## 觀測與剩餘限制

本輪依限制不修改 `trip-acceptance-evidence.ts`。目前其 `prompt-evidence.links` 白名單仍只有原三組，所以未來真實生成雖會送出第四組，現有保存檔不會列出第四組內容；Prompt雜湊／長度仍涵蓋它。本輪由全mock請求 body 直接驗證第四組，不能冒充觀測模組已同步支援。若下一次真實驗收需要保存新組，應另行對齊這個內部觀測欄位。

- [ ] 下一次真實生成前，獨立進行 Acceptance Evidence Capture 的最小觀測對齊，保存實際送出 Prompt 的 `culture_related_unverified`；本輪不修改診斷系統。

沒有公共藝術內容、活動時程、展覽、導覽或菜單的新資料。穹頂、光廊等僅有泛觀光類型的場所，仍無法自動辨識文化內容；也沒有把駁二塔擴充成整個藝術園區。沒有硬編場所名單或推論名稱中的藝術字樣。

實作驗收：`npm.cmd run test` **1,369/1,369 通過**；`npm.cmd run build` 通過，保留既有大於500 kB的bundle提示；`git diff --check` 及三個新增檔案的 whitespace 檢查通過。18組固定完整流程的 response／事件／呼叫比較通過。原51個untracked檔案的彙總SHA-256前後一致，Meal實驗備份未動。實作驗收階段未stage、commit、push、merge或真實生成；獨立提交另依使用者授權進行。
