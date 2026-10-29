# Intent-to-Candidate Grounding v1

日期：2026-10-19，Asia/Taipei。基準：dev `fedd41fc`。本輪沒有真實 AI／Places／Routes 呼叫，未 stage、commit、push 或 merge。

## 原流程與資訊缺口

1. User Input 的 `other/customCategory` 交給既有 `resolveCandidateRankingContext`。它接受明確的文化＋咖啡正向配對，以及受支援的正向參訪語句；否定、條件句、未知句法保持原有處理。本輪沒有擴充 parser。
2. Candidate Ranking 沿用該 context，當次需求調節既有用途加分，歷史偏好仍只套用原有有上限的 boost；沒有改 score、排序、搜尋或分類。
3. `getPromptCandidateSelection` 先完成去重、營業／slot eligibility 與既有 near/food/activity 配額。`formatNearbyRecommendations` 輸出 name、address、placeId、distance、rating、role、foodSubtype、mealSuitability、score、hours、bestSlots。一般初稿候選列不含完整 types。
4. 原 Prompt 已要求當次需求優先、實質風格差異、必要餐飲與安全規則，也已說明餐飲提示不是菜單驗證。欠缺的是「哪個已曝光 placeId 對應哪個當次主題」；不需再重寫一份風格或餐期規則。
5. `isIndoorCulturePromptCandidate` 的桶包含書店、社區中心、電影院等，不能直接視為確認文化主用途。可信文化判斷仍使用原 `hasConfirmedCulturalPrimaryPurpose`，不因室內桶或預設 main_activity 判定。

## 最小接線

新增純字串投影模組 `api/_lib/trip-intent-candidate-grounding.ts`。`generate-trip.ts` 在原候選文字後附加其輸出，仍將同一份 `nearbyPlaces` 交給既有初始、JSON recovery、失效 retry 與缺風格 refill 的 Prompt builder。沒有新 retry、公開參數、schema 欄位、endpoint 或後置驗收。

僅當原 parser 回傳 recognized、沒有 avoidCoffee，且正向 themes 恰為 culture＋coffee 才啟用；三主題、純文化、純咖啡、一般探索、否定／條件／未知需求皆不新增文字。沒有已曝光候選時回傳空字串，原安全拒絕路徑不變。

只讀取 `getPromptCandidateSelection(...).promptCandidates`，不讀全池補入隱藏候選，不重新選站、不更改既有候選列或順序：

| 對照鍵 | 證據與邊界 |
| --- | --- |
| culture_primary | 原可信文化主用途 helper 通過；不是已核實展覽／導覽／活動深度。 |
| coffee_venue | 已有 food/cafe 用途與 cafe/coffee_shop 類型，且沒有 museum/art_gallery 混合訊號；只作咖啡場館提示，不當可靠正餐。 |
| mixed_or_uncertain | 未通過文化主用途，但有 museum/art_gallery 類型，或只有較弱 cafe 用途提示；不宣稱符合或不符合文化需求。 |

有文化主用途、同時附 cafe metadata 的場館仍列文化；不因附屬餐飲資訊自動列獨立咖啡體驗。書店／商場等不因室內桶被升級為文化證據。未列與空列不等於沒有文化價值或整案不可行。

新增區塊的實際指示：

```text
CURRENT_INTENT_CANDIDATE_LINKS:
本次正向需求：文化景點＋咖啡廳。以下僅列上方已曝光候選的 ID 範例，沿用原排序與 score，不另加分；當次文化需求不因歷史咖啡偏好而降低優先。
culture_primary＝已有文化主用途證據；coffee_venue＝咖啡場館提示；mixed_or_uncertain＝文化／咖啡用途仍待確認。空列或未列不代表不符合；室內文化桶不等於文化證據，文化場館附咖啡類型也不證明獨立咖啡體驗。
在可行時兼顧兩主題，沿用各指定風格的節奏與組合；不強制每案類型或跨案換地點。營業、首站、餐期及交通規則優先；咖啡不等於可靠正餐。勿推測展覽、導覽、菜單或活動深度。
{"culture_primary":["已曝光文化ID"],"coffee_venue":["已曝光咖啡ID"],"mixed_or_uncertain":["已曝光待確認ID"]}
END_CURRENT_INTENT_CANDIDATE_LINKS
```

上方 ID 為格式示意；實際回歸的完整 ID、原 Prompt 及新 Prompt 保存於文末重播資料。每組最多三個完整 placeId 範例，保留原相對順序；整區塊最多 1,800 UTF-8 bytes，連同兩個分隔換行最多增加 1,802 bytes。超出長度的 ID 略過，不截斷 ID，也不裁切原候選清單。這是文案長度限制，不是主題硬性配額。

## 免費前後比較

15 組完整 handler 比對 `fedd41fc:api/generate-trip.ts` 與本輪程式，分獨立程序執行，Places／Routes／AI／Supabase 全部為固定回應；未知網路入口拒絕。初稿是固定資料，不是真實模型表現。

表內 C/K/U 為新區塊列出的文化／咖啡／待確認 ID 數，不是全池可行數。原、新 Prompt 的完整候選列與曝光 ID／順序逐筆相等。下列曝光數前後相同；所有新 ID 均存在於該次真正 AI 請求的候選列。

| 固定案例 | 曝光數 前→後 | C/K/U | 新增字元 / bytes | 粗估新增 tokens | AI 前＝後 |
| --- | --- | --- | --- | --- | --- |
| 文化＋咖啡充足 | 9→9 | 2/1/1 | 540 / 982 | 301–549 | 1 |
| 文化在池內但未入 Prompt | 33→33 | 0/1/1 | 439 / 881 | 276–515 | 1 |
| 文化證據不確定 | 9→9 | 0/1/3 | 541 / 983 | 301–549 | 2 |
| 文化全部不合法 | 6→6 | 0/1/0 | 425 / 867 | 272–510 | 1 |
| 當次混合需求＋歷史咖啡偏好 | 9→9 | 2/1/1 | 540 / 982 | 301–549 | 1 |
| 單純咖啡 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 單純文化 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 一般探索 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 否定咖啡 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 條件式 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 未知需求 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 三主題 | 9→9 | 不啟用 | 0 / 0 | 0 | 1 |
| 缺 Balanced／補案 | 9→9 | 2/1/1 | 每次 542 / 984 | 每次 302–549 | 2 |
| 失效初稿／既有 retry | 9→9 | 2/1/1 | 每次 542 / 984 | 每次 302–549 | 2 |
| stream-tail | 9→9 | 2/1/1 | 542 / 984 | 302–549 | 1 |

Token 區間是本地啟發式：非 ASCII 字元約 1–2 tokens、ASCII 約每 3–4 字元一 token；不是 tokenizer 結果、供應商 usage 或保證上下界。無新增套件或 tokenizer 網路請求。標準案例 Prompt 字元由 9,493→10,033（約 +5.7%）；未曝光文化案例 15,331→15,770（約 +2.9%）。沒有依新增文字重新裁切候選。

每一組均深度比對完整最終 response、全部串流事件、站點／順序／時長／交通，以及全部外部請求。只有 AI messages 的該區塊不同；剝除該區塊後整份 AI 請求亦相同，其他 endpoint、headers、body 與請求順序全部相等。AI 次數、Places 次數、Routes 次數與模擬扣點不變。

初始與各指定風格 retry 的舊 Prompt，均逐字等於剝除新區塊後的新 Prompt；既有 Safe／Balanced／Explore 指示、硬性規則與 validation summaries 不變。每次 Prompt 只有一份對照，沒有複製另一份三風格任務，也沒有要求 retry 補入未請求風格。

舊 Final Plan Text regression 原先逐筆要求歷史 AI request body 完全相等。本輪僅針對 AI content 剝除已知新增區塊後保留該比較；未忽略其他 request 欄位。新整合測試另以 fedd41fc 嚴格驗證完整允許差異，原行程／文字修復斷言不變。

## 驗收與限制

- 新增 17 個測試，含上述 15 組完整流程及各指定風格 Prompt 對照、極長 ID、空池、附 cafe 的文化場館、室內桶與不確定分類。
- `npm.cmd run test`：1,337／1,337 通過。
- `npm.cmd run build`：通過，既有超過 500 kB bundle 提示維持。
- `git diff --check` 與新檔 whitespace 檢查：通過。
- 不改 Search、Ranking、Personalization、分類、score、Repair、Fallback、Duration、Meal、Validation 或公開資料契約。

完整免費前後 Prompt、曝光 ID、估計值、最終行程與全部 mock 請求保存於專案外：

`C:/Users/wr124/.codex/visualizations/2026/10/18/01a14f39-7e6b-7bb3-81d9-a88b3de9fad5/intent-to-candidate-grounding-v1/regression-20261019.json`

測試不依賴此調查輸出、原 docs/investigations、scripts、compare-supplement-quality 或 Meal Selection 備份。歷史比較只需要已存在的 fedd41fc Git object，及已追蹤／本輪新增的 fixture。

固定 AI 回應只能證明 Prompt 資訊正確傳遞及系統未退化，不能證明真實 AI 更願意採用文化候選、活動深度提升或三風格差異改善。沒有新外部呼叫入口，但真實 AI 若改選地點，既有下游 Routes／Repair 成本仍可能隨結果不同；本輪不宣稱真實總成本固定。

值得在另行授權後安排一次白天市區、明確文化＋咖啡需求的真實生成篩查，保存版本、原輸入、真正曝光候選、初稿、後處理與最終三案及呼叫／usage。一次只能篩查明顯缺陷，不能作成效率或因果改善證據。本輪沒有執行。
