# Coverage v2 Phase 2C-1：內部留白資格與交付決策

基準：本機 `dev / 82470a9c733fbc61a4119cc1a7b50c0b6f08b578`。本輪實作影子決策，沒有讓資格改變正式交付、Coverage 門檻、Repair／Refill、Optional Activity Protection、API Schema、UI、Auth 或資料庫。

## 決策與未確認狀態

新增 `coverageV2.*.shadow.deliveryDecision`，沿用 Phase 1 的需求、必要條件、時間帳及補救紀錄。Phase 1 原有 `classification` A/B/C/D 保留原義；新交付資格以 `deliveryDecision` 為準，不能把舊 B 直接當作本輪拒絕結論。沒有在 TripPlan 或正式 response 加入欄位。

| status | 所需證據 |
| --- | --- |
| complete | 核心已確認、必要條件通過、原正常 Coverage 門檻達標；不要求再做無必要補救 |
| conditional_partial | 核心已確認、必要條件通過、Coverage 不足、連續時間軸僅有尾端留白，而且目前方案／既定候選池的有限補救已完成 |
| alternative | 已知原需求未滿或有 related alternative，但目前替代行程的必要條件通過；不宣稱原需求完成 |
| unavailable | 目前受評方案的必要條件失敗或未能驗證；不表示現實中不存在任何其他可行行程 |

**證據不足保留 `status:null / resolved:false`**，不是第五種交付結果。核心 unknown、補救未完成、來源失敗、預算耗盡等，不能硬塞為 complete／C／alternative，也不能因此聲稱「沒有可執行行程」。`executable`、`originalDemand`、`reasons` 與補救旗標分別記錄；實際交付仍完全由舊流程決定。

`unknown` 不會被視為原需求符合，也不會自行升格成已知替代。`alternative` 需求狀態亦不會變成 satisfied。補充測試覆蓋四種確定結果及上述待確認情況；原 48 組沒有已確認 alternative 的樣本，所以該欄數量為 0。

## 合理補救的可追溯邊界

在既有 `chooseSupplementalInsertion()` 的觀測紀錄中增加：

- `poolSignature`：與目前完整合併候選池比對的 SHA-256，包含會影響判斷的身分、類型、排名、座標、營業等 metadata；不新增搜尋。
- `unprocessedPoolCandidates`：完整池內尚未使用、但未納入本輪比較範圍的候選數。不能用短名單完成掩蓋完整池中的重要未評估候選。後續完整池 pass 可消除該項不確定。

只有最後 pass 對應目前時間軸及候選池、範圍為既有完整補站機制、沒有 pending／範圍外未處理候選，且停止原因是以下其一，才有補救完成依據：

1. `bounded_scope_evaluated`：有候選、有實際路線比較，而且既定比較位置已完成。
2. `bounded_pool_insufficient`：既定池沒有可比較的合格候選、沒有未處理候選。這不是「本輪沒找到」就直接放行；仍須有成功搜尋來源、相符的池與時間軸，以及其餘所有 C 條件。

來源 failed／unavailable、Routes 或 trial 技術失敗、比較預算耗盡、未評估候選、舊時間軸或舊候選池，均不得取得 C。沒有證明附近所有景點已搜尋，也沒有新增 Places／OpenAI／Routes 請求。

歷史 pending／技術失敗／預算耗盡仍採保守阻擋；本輪不建立跨 Retry／Refill 的「新證據已消除舊失敗」協調策略，也不重設原有 budget。

## 時間與 B2

時間仍由既有停留與真實 Mock 路段相加，沒有虛構自由活動。五小時 190 分鐘的補充案例及昂貴補站案例均得到：正常門檻 225、Coverage 缺口 **35**、實際未安排 **110** 分鐘。兩者不混用。

未處理的站間空檔、缺段、錯誤端點、估算路段及延後開始不能取得 C。時間模型沿用目前連續停留＋交通的表示法，尚無一般站間等待結構；沒有加入等待／延後開始授權機制。23:00–01:00 與既有 06:00 黎明活動窗例外分開測試。

B2 仍只存在於原隔離 loader；本輪沒有將它接到正式預設。重新執行證明原愛河灣 150 分鐘保留，三風格原活動額外縮時均為 0。負向控制仍保留容量要求的 150→126；營業控制仍拒交。必要修復、正常補站成功後的 complete 優先順序及 Optional Activity Protection 都不變。

## 新執行的 48 組 A／B2 與影子資格

[逐案 JSON](./coverage-v2-phase2c1-results.json) 包含原 16 情境 × Safe／Balanced／Explore 的 **48 個逐案紀錄**，每案重新跑 A 和 B2 的 Repair／Validation；沒有直接對舊報告貼標籤。整理依賴後，專項測試每次亦執行完整矩陣，而非讀取這份報告。A/B2 的正式結果、issues、分鐘、停留、交通、補時、原活動影響、Routes／Repair 次數及完整停留事件，均納入固定回歸契約的 canonical SHA-256 等值檢查；決策物件另做 deepEqual，維持原比較欄位與強度。

| 指標 | A | 隔離 B2 |
| --- | ---: | ---: |
| 舊流程實際回傳方案 | 48 | 24 |
| 影子 complete | 39 | 21 |
| 影子 conditional_partial | 0 | 18 |
| 影子 alternative | 0 | 0 |
| 影子 unavailable | 6 | 6 |
| 證據待確認（非交付狀態） | 3 | 3 |
| 原活動停留損失，分鐘 | 0 | 0 |
| Routes Mock 次數 | 105 | 138 |
| Repair 次數 | 90 | 90 |

下表三個風格欄各自來自獨立執行與判斷。補充測試亦以同時存在 C、budget pending、alternative 的三風格證明沒有共用資格旗標。

| 情境 | A 影子（各風格） | B2 Safe | B2 Balanced | B2 Explore | B2 已安排／正常缺口／未安排，分鐘 |
| --- | --- | --- | --- | --- | --- |
| 文化＋咖啡兩站 | unavailable | unavailable | unavailable | unavailable | 204／21／96 |
| 博物館＋咖啡 | complete | conditional_partial | conditional_partial | conditional_partial | 139／86／161 |
| 五小時少量缺口 | complete | conditional_partial | conditional_partial | conditional_partial | 215／10／85 |
| 五小時大量缺口 | complete | conditional_partial | conditional_partial | conditional_partial | 95／130／205 |
| 有價值補站 | complete | complete | complete | complete | 280／0／20 |
| 昂貴補站 | complete | conditional_partial | conditional_partial | conditional_partial | 190／35／110 |
| 十小時雙餐 | complete | complete | complete | complete | 480／0／120 |
| 夜間兩站 | complete | complete | complete | complete | 104／0／16 |
| 夜間單站 | complete | conditional_partial | conditional_partial | conditional_partial | 60／24／60 |
| 預訂長停留 | complete | complete | complete | complete | 235／0／65 |
| 依據支持延長 | complete | complete | complete | complete | 225／0／75 |
| Grounding 最低修正 | complete | conditional_partial | conditional_partial | conditional_partial | 140／85／160 |
| Optional 回退 | complete | complete | complete | complete | 263／0／37 |
| Optional 後補站 | complete | complete | complete | complete | 252／0／48 |
| Routes 失敗控制 | unavailable | unavailable | unavailable | unavailable | 193／32／107，路段未驗證，不可視為合法尾端 |
| 餐期對齊控制 | 待確認 | 待確認 | 待確認 | 待確認 | 247／0／53 |

18 組 C 是六種情境各三風格。它們可在未來資格規則下承接 B2 原失去的 **18／24** 組；不是本輪正式交付成功。剩餘失去的 6 組分別是文化＋咖啡兩站（需求 unknown 且有 60 分鐘延後開始）及 Routes 失敗。

餐期對齊控制原本已被正式回傳，但文化需求仍為 unknown；本輪不把它當 complete 或已知 alternative。這也說明為什麼「正式回傳 48」不等於「48 組均有資格」。

**大留白是本次規格的直接結果**：95／300 分鐘、未安排 205 分鐘的案例，已確認核心、必要條件及既定範圍補救通過，因此也符合 C。沒有擅加另一條低 Coverage 門檻或品質分數阻擋它。這不證明固定草稿具有足夠的真實推薦價值；正式啟用前應明確接受或修訂這個產品邊界，不能把影子資格包裝成品質驗證。

`conditional_partial` 目前只是影子資格，不代表已滿足正式產品交付標準。正式啟用前，必須另外建立行程充實度與大幅留白的處理政策；本輪沒有實作該規則。18 個影子 conditional_partial 不是 18 個已恢復正式交付的方案。

## 正式行為、成本及持久化回歸

6 組完整 handler 情境各跑 A/B2，共 **12 組**。正式 response、串流 events、AI 階段、Retry、Refill、Routes、Places、Repair、Validation 與原 Phase 2A-1 完全一致。A/B2 的 105/138 Routes 差異屬於原隔離 B2 效果，新增資格判斷本身沒有增加任何請求。

完整 Unit Tests 也包含 Phase 1 原三組 `positioning`／`missing-balanced`／`tail` 相對 `12d11cd` 的 response、事件及外部次數對照，全部通過。未全面停用或改變 Refill。

`captureAcceptanceDiagnostics()` 原安全投影已加入新決策的固定欄位／列舉白名單，維持原 row／array／256 KiB 總量限制。候選池僅持久化摘要，沒有新增私人座標、搜尋字串、完整候選池、Prompt、憑證或未清理外部回應。實際寫入並讀回 `diagnostics.json` 測試確認三風格的 complete／C／alternative、時間帳及資格資訊完整；未知額外欄位被捨棄、過長陣列標記 incomplete。缺少新決策欄位的舊診斷仍可投影讀取。

診斷投影不是決策輸入；任何截斷後的紀錄都不能拿來宣稱補救已完成。

## 修改範圍

- 新增 `api/_lib/trip-coverage-delivery.ts`：純內部四種結果與未確認證據的分類。
- 修改 `api/_lib/trip-coverage-v2.ts`：沿用評估資料組裝新決策、池摘要；舊 A/B/C/D 不變。
- 修改 `api/_lib/trip-supplement-quality.ts`：僅增加既有 pass 的觀測欄位，不改候選選擇、比較、請求或停止分支。
- 修改 `api/_lib/trip-coverage-diagnostics-projection.ts`：有界安全持久化。
- 新增 `tests/unit/trip-coverage-delivery.test.mjs`、`tests/unit/fixtures/coverage-phase2c1-replay.mjs`、`tests/unit/fixtures/coverage-phase2c1-matrix.mjs` 及本報告／結果 JSON。

舊 Phase 2A／2A-1 實驗檔與報告均未改，沒有第二套 Repair。

## 測試依賴整理與獨立重現

提交前曾發現三條隱藏依賴：replay 靜態 import 未追蹤的 Phase 2A loader／cases；loader 在執行期以 `readFileSync` 載入 Phase 2A-1 support／wrappers，再注入 API source；matrix 讀取舊 Phase 2A-1 JSON，原專項則讀取已生成的 Phase 2C-1 報告並依其中路徑讀取舊 loader／support。只檢查靜態 import 不足以發現後兩者。

本次只整理必要支援，原研究檔不移動、不修改、不刪除：

| 納入的共用支援 | 必要用途與來源 |
| --- | --- |
| `coverage-experiment-cases.mjs` | 原 16 情境及 6 組 handler 的固定合成資料；原樣抽取原 cases，繼續組合 HEAD 已追蹤 Fixture，不載入真實生成或私人研究資料 |
| `coverage-experiment-loader.mjs` | 隔離載入既有 Repair source、精確匹配測試 hook；支援 A/B/B2，不改正式 module |
| `coverage-experiment-support.mjs` | B2 軟上限保護、必要條件稽核及池摘要；是動態讀取依賴，不能只收 loader |
| `coverage-experiment-observers.mjs` | 觀察實際 Validation／Repair／Refill 結果，不替代或選擇行程；由 loader 動態讀取 |
| `coverage-delivery-contract.json` | 約 85 KiB 的固定回歸契約，保留 96 個 A/B2 正式結果摘要、48 組影子決策及 12 組 handler 完整比較欄位摘要；來源為已驗收 Phase 2A-1／2C-1 固定 Mock 結果，附原結果 SHA-256 |

固定契約不可由「本次待測實作的輸出」自行生成作為 expected，否則新錯誤會同步更新 expected 而失去回歸能力。契約只保留原比較所需的 canonical digest／決策與總數，不保留舊候選池、Prompt、完整事件輸出或大型研究報告。實際結果、時間帳與報告一律由 Fixture 重算；執行時不讀舊研究 JSON。缺少契約會明確拋出 `Required Coverage regression fixture unavailable: ENOENT`，有自動負向測試，沒有 skip／空結果回退。

靜態遞迴依賴還包括 HEAD 已追蹤的 `supplement-quality`、`stop-duration-quality`、`optional-activity-quality`、`meal-reliability`、`supplement-final-quality`、`plan-identity`，以及間接的 `meal-suitability`、`meal-consistency`、`food-purpose-protection`。其餘 API／型別、TS loader 與 package-lock 都由 HEAD 提供。套件依賴在專案外的本機 HEAD clone 依 lockfile 獨立執行 `npm ci --offline --no-audit --no-fund`，沒有複製原工作區 node_modules、`.env`、私人設定或被 ignore 的 tests/data。

快照僅覆蓋明列的 14 個預計提交檔案，其餘檔案來自 `82470a9`；使用 clone 自有的 Git 歷史供既有基準重播讀取。專項測試另以快照外的只記路徑稽核工具觀察 `fs.readFileSync`、`fs.readFile`、`fs.promises.readFile`，包含子程序的動態讀檔，未發現原工作區檔案讀取；稽核工具不是應用程式依賴，也不加入 Commit。完整套件曾因額外稽核寫入碰到既有 write-failure Mock，移除稽核鉤子後以專案原生完整命令重驗通過，沒有修改或跳過失敗注入測試。成功驗收不以原工作區通過取代。

## 驗證與 Commit 判斷

- 上輪工作區新專項 **79／79**、完整 Unit Tests **1707／1707** 通過；下列乾淨快照驗收取代其作為本次提交依據。
- 乾淨快照：本期必要專項 **80／80** 通過，0 失敗／跳過；每次實跑 48 組 A/B2、12 組 handler 對照及必要縮時／營業負向控制。
- 乾淨快照完整 `npm run test:unit`：共 **1567**，**1564 通過、0 失敗、3 個 HEAD 原有可選研究快照測試明確略過**。這三個測試位於 candidate-classification／candidate-availability-slots／candidate-quota-consistency，原本即由 `snapshotAvailable()` 控制，依賴不屬於本期的 `scripts/investigations/google-places-fine-data-20261004/observations.json`；本次沒有新增 skip、沒有刪除 HEAD 測試，也沒有偷帶舊研究資料。上輪 1707 還包含未追蹤的 Phase 2A／2A-1 研究測試及可選真實快照的巢狀案例，因此不以較高工作區總數冒稱乾淨快照結果。
- TypeScript、Build、diff check 通過。Build 僅有既有大於 500 kB 的 bundle 提示。
- 開始整理前共有 70 個未追蹤檔案；僅本期 6 個檔案允許更新，其餘 **64 個**（包含原 51 個研究／備份及先前實驗）逐檔 SHA-256 保留。
- 提交前基準仍為 `dev / 82470a9`；沒有 Push、Merge、Deploy，付費呼叫 0。

舊 Phase 2A／2A-1 的兩個研究測試檔、七個 Fixture／runner 支援原檔及四份報告／JSON 不納入本次 Commit。所需四個支援模組只抽取為上述共用版本；沒有把整套研究環境包入。

正式 API／前端接入還需要：確定大留白與 unknown 的產品呈現及可接受邊界；批准 B2 正式啟用方案；讓 selector／handler 保留合格 partial 與 alternative 並定義全案成功、點數／失敗語義；增加對外 schema 與使用者知情呈現；將 Retry／Refill 的證據更新與未處理候選歸戶後做真實案例驗證。不能只把本輪 status 接到成功旗標。

重現：

```powershell
node --import ./tests/unit/register-ts-js-extension-loader.mjs tests/unit/fixtures/coverage-phase2c1-matrix.mjs
node --import ./tests/unit/register-ts-js-extension-loader.mjs --test tests/unit/trip-coverage-delivery.test.mjs
npm run test:unit
npx tsc -b --pretty false
npm run build
git diff --check
```

本輪完成後停止，等待決策；沒有接入下一階段。
