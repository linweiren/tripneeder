# Final Plan Text Consistency v1

日期：2026-10-18（Asia/Taipei）；誤判修正：2026-10-19。獨立基準 HEAD：`19a538d`。

## Meal Selection 實驗保存

已先清查上一輪的 3 個 tracked 修改及 7 個新增檔案。已在專案外的本機路徑保存完整修改版本、原 HEAD bytes、必要 binary patch、SHA-256 manifest 與還原工具：

`C:/Users/wr124/.codex/visualizations/2026/10/18/01a14f39-7e6b-7bb3-81d9-a88b3de9fad5/meal-selection-v1-backup/`

備份共 14 檔：3 個 tracked 完整修改版本、5 個新增程式／測試、2 個上輪文件／回歸結果、4 個原研究參考檔。保存內容另獨立重建並逐一核對 SHA-256；`restore-experiment.mjs` 在撤回後的乾淨基準上已通過還原前置檢查，遇到本輪或後續修改會拒絕覆蓋。

僅將以下 tracked 檔案恢復為 HEAD：`api/generate-trip.ts`、`package.json`、`tests/unit/meal-reliability-diagnostics.test.mjs`。僅移除已備份的 5 個實驗新增檔案：`trip-meal-restoration.ts`、`meal-restoration-cases.mjs`、`meal-restoration-replay.mjs`、`meal-restoration-guards.test.mjs`、`meal-restoration.test.mjs`。撤回後確認 tracked diff 為空；原有 docs/investigations、scripts、其他指定資料共 70 檔的 hash 全部相同。上輪文件與結果留在原處，沒有改寫。

本輪另外新增 `npm run test` alias 指向原有 `test:unit`，是為執行本輪指定驗收；沒有保留 Meal Selection 的任何正式程式或測試。

## 文字來源與接點

title、subtitle、summary 來自 AI 骨架。Grounding、Places 驗證、Repair、安全／時序對齊、必要餐期修復、補站、容量／dawn-tail 刪站、Fallback 都可能改站點，原程式仍沿用骨架文案。詳情 parser 僅合併描述／交通標籤，保留主方案身分與骨架文案；之後雨備仍可能被驗證、替換、補足或因品質驗收移除。

新增 `api/_lib/trip-plan-text-consistency.ts`：私有 WeakMap 只記錄同一方案曾經選入的主站／雨備名稱與 placeId，不讀取候選池、不跨風格共用。既有 lineage copy、Grounding、Repair 各選定階段、同風格 upsert 會傳遞這份紀錄；只記錄選定的餐期修復結果，不把所有比較候選加入。Fallback 最終若恢復原名，該名稱仍在最終站點，原文不會被誤刪。

最終修復在三個輸出邊界執行：

1. `generate-trip` 的兩個 stream／stream-tail `plan` 輸出，僅修輸出的副本；內部骨架文字維持原樣，避免影響之後 fallback 或 retry prompt。
2. `generate-trip` 的 `done` 輸出前：所有 Repair、Fallback、Stop Duration Quality、重產／補案與最終風格整理已完成。合併該風格已有 validated predecessor 的名稱紀錄，逐欄修復。
3. `generate-trip-details` 的 JSON 輸出前：詳情合併、主站身分保護、雨備 Places 驗證／補足、路線修復及雨備品質檢查皆完成。

前端直接採用最終 response，沒有另一段覆寫這三個文字欄位的細節合併。`recompute-routes` 只回傳交通段與 totalTime，不改站點身分或三個文字欄位，因此不需新接點。前端手動調整與舊儲存資料遷移不在本輪範圍。

## 修復規則

提交審查曾重現兩個誤判：中文完整名稱用 substring 匹配，把「藝術館藏」當成「藝術館」；裁掉場所字尾產生的「新港」簡稱，把地區敘述當成舊店引用。這兩種推論已撤除，沒有補上中文分詞或 AI 判讀。

現在先使用已記錄的完整 name／placeId 確認消失的身分。同一 placeId 仍在最終主站或雨備中，即使正式名稱改變，也不當成已移除；最終有同名站點或包含舊完整名稱的地點，也保守保留。舊站沒有 placeId，或最終站點的 placeId 證據不齊時，不能確認舊身分已消失。

不再產生任何簡稱或別名，也不以任意 substring 命中作為改寫依據。完整名稱做 NFKC／大小寫／空白正規化後，仍須有可區分的場所名稱形式；藝術館、咖啡館等類型詞、新港等地區／短名稱，以及「地方藝術館」等通用描述不能提供足夠證據。

引用判斷只接受一小組整欄完全匹配的明示文案形式：完整名稱或完整名稱加「小旅行」，以及「先／再／接著／雨天」＋「到／前往／在／走訪／造訪」＋完整名稱＋休息／喝咖啡／用餐／參觀，可接「再沿途散步／走走」。名稱須以成對引號明示；未加引號只保留「咖啡商行」完整商號名稱在上述文案形式中的辨識，例如眷鳥咖啡商行。其他未加引號的咖啡館／場館文字即使恰好符合完整名稱，也可能是普通描述，保留原文。

這是一組有界、明示的文案形式，不是中文字邊界或全面語意解析。函式回傳 confirmed／retained／unresolved；只有 confirmed 才改該欄。回憶、否定、條件句、附近描述、較複雜句子，以及單獨寫「眷鳥」等無法判定情況都保留。這些內部狀態不加入公開資料。其他欄位與全部行程資料保持不變；仍以中性整欄退路取代，不直接換成新店名。

修復產生的文案只說明查看現有行程，不宣稱咖啡、文化、展覽、供餐等活動能力：

| 欄位 | 安全文案 |
| --- | --- |
| title | 保守方案／平衡方案／探索方案（既有風格標籤） |
| subtitle | 依行程地點安排的出遊路線 |
| summary | 依下方地點與順序展開行程，各站安排可查看詳細資訊。 |

實際免費重播：眷鳥咖啡商行被 Grounding 或 Repair 換成草圖咖啡。

| 欄位 | 修正前 | 修正後 |
| --- | --- | --- |
| title（Safe） | 眷鳥咖啡商行小旅行 | 保守方案 |
| subtitle | 按照自己的步調走走 | 完整保留 |
| summary | 在眷鳥咖啡商行喝咖啡，再沿途散步。 | 依下方地點與順序展開行程，各站安排可查看詳細資訊。 |

誤判回歸與縮限：

| 舊站／語境 | 修正後 |
| --- | --- |
| 藝術館被替換成地方文物館；「欣賞藝術館藏。」 | 原文保留；unresolved |
| 新港咖啡館被替換成新港地區的另一家咖啡館；「在新港喝咖啡，再沿途散步。」 | 原文保留；unresolved |
| 眷鳥咖啡商行移除，但只寫「在眷鳥喝咖啡」 | 不再推導簡稱；原文保留 |
| 「在明亮咖啡館休息。」只是可能的普通描述，即使舊站全名叫明亮咖啡館 | 原文保留；unresolved |
| 「以前在眷鳥咖啡商行喝咖啡。」或「在眷鳥咖啡商行喝咖啡，是原本的安排。」 | 原文保留；unresolved |
| 地點仍在、同名分店、Fallback 恢復原站，或同一 placeId 更換正式名稱 | 原文保留；retained |

Fallback 恢復原正餐餐廳時，`到原正餐餐廳用餐。` 完整保留。沒有引用舊地點的 `沿途看看街景。` 完整保留。完整生成中，Safe 的舊標題／摘要被修復；Balanced 已引用草圖咖啡的正確文案完全保留；Explore 僅修復引用舊站的 subtitle。

## 免費回歸與限制

對照真正 HEAD 程式與本輪程式：27 組 Grounding／Repair／Fallback／duration-only／未引用舊名／兩個誤刪反例／簡稱保留案例（各三風格），加上完整生成 handler 與 2 組詳情 handler。Fallback 同時測試「恢復原站的正確文字保留」及「文字仍明示已被 fallback 移除的暫選站，必須修復」。比對所有 title／subtitle／summary 以外的完整資料，包括站點、id、placeId、順序、時長、描述、總時長、開始時間、主站及雨備路線等；全部相同。全部外部請求的 URL、選項與 body 逐筆相同，不只是次數相同。未知網路入口直接失敗，沒有真實外部請求、付費生成或實際扣點。

Grounding 正例現在明確使用舊、新不同 placeId，證明真的移除了舊身分；同 placeId 只改正式名稱另以反例保留，不再把這種情況包裝成身分移除。

另外驗證欄位獨立、重複修復不再變更、Fallback 恢復、只改時長、跨風格隔離、同名站點、多次換站、名稱部分重疊、引號完整名稱、正則特殊字、缺少歷史 placeId、短名／地區名／類型詞／回憶／否定／條件句／普通描述均 unresolved、已移除中間站的 lineage、雨備移除與主／雨備仍保留的名稱。

2026-10-18 的 1296 項測試未涵蓋後來發現的誤判，不能作為本次修正的驗收依據。2026-10-19 最終結果：`npm.cmd run test` **1320／1320 通過**、`npm.cmd run build` **通過**（既有大於 500 kB bundle 提示維持）、`git diff --check` **通過**；新增檔案亦另做 whitespace 檢查。27 組流程案例中，9 案修復明示舊站的文字、18 案整份 plan 完整保留，不會把正常摘要一律換成中性文案。備份 14 檔、獨立重建 14 檔與 70 個受保護原有檔案的 hash 均未改變；5 個 Meal Selection 程式／測試仍不在工作樹。

原先受控前後回應及請求保存於專案外同層的 `final-plan-text-consistency-v1/regression.json`；本次結果另存 `final-plan-text-consistency-v1/regression-reference-fix-20261019.json`，未覆寫舊結果。本輪完成後未 stage、commit、push 或 merge。

這是已知身分引用的局部修正，不是通用語意驗證。未記錄的別名、所有簡稱、沒有已支援場所字尾的名稱（如 ThisBALL、光之穹頂）、未加引號的普通場館名稱、超出已支援文案形式的複雜句子或改寫、未具名的既有活動敘述都無法安全判定，保持原樣。沒有原始 lineage 的舊儲存方案也不憑空推測歷史地點。對品牌／分店等有歧義情況採保守保留。本次只修既有引用判斷及其測試／文件，正式交付接點未再變動；沒有改寫 Prompt、Search、Ranking、Personalization、選站／時間、Repair／Fallback／Validation 決策，亦未變更 API/schema/auth/route 契約。
