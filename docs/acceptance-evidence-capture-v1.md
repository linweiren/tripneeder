# Acceptance Evidence Capture v1

本輪基準為 dev `b7498cf5602b52702f819b7b9f710d703ca273fa`。只增加明確開啟的非 production 觀測；沒有修改 Prompt、搜尋、排序、選站、Retry、Grounding、Repair、Fallback、驗證、點數規則或公開回應。所有預演均使用固定模型、Google 服務與點數 mock，沒有付費生成。

## 原有紀錄與缺口

`TRIP_CANDIDATE_DEBUG` 已保存候選池、曝光候選、分類／排名證據及 qualityDiagnostics 的階段快照。原有 AI output 是 parser 後的方案摘要，無法當作原始模型骨架；局部路線比較計數也不是整次生成的外部請求總帳。這次重用既有報告，不另建 Grounding／Repair／Fallback 快照系統。

## 接入位置與檔案

| 檔案 | 僅觀測的接點 |
| --- | --- |
| `api/_lib/trip-acceptance-evidence.ts`（新增） | 單次請求 AsyncLocalStorage、投影、總帳、六檔保存、失敗與大小限制 |
| `api/generate-trip.ts` | handler 生命週期；實際 AI initial／initial_json_repair／retry／refill fetch；模型解析前；既有驗證結果；扣點 RPC 前後；實際 done 寫出後 |
| `api/_lib/google-places.ts` | 共用 HTTPS 邊界區分 Search／Details／Geocoding；既有 Details cache hit |
| `api/_lib/google-routes.ts` | Routes HTTPS 邊界 |
| `api/_lib/trip-supplement-quality.ts` | 既有路線 memo 命中分支，沒有新增快取或比較 |
| `api/_lib/trip-plan-text-consistency.ts` | 既有物件轉換附帶傳遞私有版本 WeakMap，沒有改文字判斷 |
| `api/_lib/trip-quality-diagnostics.ts` | 私有快照附帶 `aiVersion`，沿用 repair attempt 關聯 |
| `api/_lib/trip-candidate-debug.ts` | 在啟用的生成請求中重用同一份報告，排除查詢自由文字，不再另存／列印整份舊候選報告 |
| `.gitignore` | 排除預設本機證據資料夾 |
| `tests/unit/acceptance-evidence.test.mjs`（新增） | 真正 handler、三方比對、失敗／隱私／隔離／容量測試 |
| `tests/unit/fixtures/acceptance-evidence-replay.mjs`（新增） | 封鎖未 mock 網路；真正 mkdir／write／read／SHA-256 驗證 |
| `tests/unit/fixtures/quality-diagnostics-replay.mjs`、`meal-reliability-replay.mjs` | 舊診斷預演改為也讀取新保存封套；維持 mock 寫檔以免污染本機資料 |

沒有改動公開型別、API 欄位或 route。沒有重新執行分類器來推測 Prompt 對照。

## 六份證據

每次生成使用私有 UUID；資料檔都有相同 `requestId`，manifest 的 `files` 保存其他五檔的 SHA-256。UUID 只進入本機紀錄／安全的完成標記，不加入串流或公開回應。

| 檔案 | 內容 |
| --- | --- |
| `manifest.json` | 時間、checkout revision、四個關鍵來源檔雜湊、允許保存的輸入、有效體力、歷史偏好樣本數／咖啡訊號、完整性狀態／原因及檔案雜湊 |
| `prompt-evidence.json` | 每次實際 fetch body 的候選 ID、三組用途 ID 對照、區塊數／是否存在／ID 是否已曝光、字元與 UTF-8 長度、Prompt SHA-256；不保存完整 Prompt |
| `ai-attempts.json` | 每次請求階段／目標方案、解析狀態、原始方案 id/type/index 與站點順序/id/placeId/duration、已知結構問題、可取得的數值 usage、階段決策及正式採用來源 |
| `diagnostics.json` | 既有候選與 qualityDiagnostics 證據，包括 Grounding／Repair／Fallback 站點和時間變化、排名與用途證據；排除原始查詢文字及任意根欄位 |
| `final-response.json` | 實際 done.response 的雜湊與公開方案白名單投影：名稱、文案、時間、站點、交通段及雨備；不是完整回應或完整 AI 原文副本 |
| `calls-and-points.json` | 本次 handler 各服務實際送出／HTTP 成功失敗／拋錯、實際應用程式 cache hit、扣點 RPC 確認結果；沒有網址、headers 或請求 body |

初始 SSE extractor 的輸出在 identity normalizer 前投影。完整模型內容同樣在既有 parser 前作投影，且不保留原文。整體 JSON 失敗時，保留已抽出的串流骨架；JSON recovery 另記為 `initial_json_repair`。重複風格／非目標風格保留原始索引，不能因曾被嘗試而變成 `final_selected`。

驗證通過僅記為 provisional。以真正 done 中的物件來源決定 `finalVersions` 及 `final_selected`；本地補案來源為 attempt 0，不冒充 AI。非 AI 外部呼叫不猜測歸屬最近一次 AI attempt，只有 request 關聯。數值 usage 僅取 provider 實際回傳欄位；不新增 stream usage 選項。

扣點保留 `requestedCost` 與 `rpc_confirmed`／`rpc_failed`／未取得結果等狀態。RPC 無錯誤代表服務確認，不能當成另行查核過的餘額差額；`balanceDelta` 與未觀測到的供應商費用均為 `unknown`。沒有為了診斷再查餘額。

## 啟用與保存

必須同時符合 `NODE_ENV !== production` 及 `TRIP_CANDIDATE_DEBUG=true`。production 即使開啟旗標仍強制停用。啟動本機 dev server 前，在該 PowerShell process 設定環境變數，避免誤以為 Vite 會自動轉送任意 `.env` 欄位：

```powershell
$env:TRIP_CANDIDATE_DEBUG = 'true'
$env:TRIP_ACCEPTANCE_EVIDENCE_DIR = 'C:/path/to/private-local-acceptance'
```

未指定資料夾時使用 `.tripneeder-acceptance-evidence/<requestId>/`（已 ignore）。下一次驗收須由目前 dev 工作樹啟動本機 API；`npm run preview` 及舊線上部署不能證明使用此版本。不要為了取得紀錄而解除正式環境的 production 隔離。本輪沒有啟動付費測試。

manifest 的 checkout revision 不宣稱工作樹乾淨；另保存 generate handler、observer、intent grounding、Prompt builder 的來源雜湊，並檢查請求前後有無改變。其他來源的完整版本仍須搭配當次 Git 狀態；缺少可讀來源或 revision 時標記 incomplete。

下一次人工操作仍沿用：高雄中央公園、10:00–15:00、2 人、機車、弱體力、文化景點＋咖啡廳，以及真實歷史咖啡偏好。檢查 manifest 的有效體力／偏好訊號、Prompt 對照及三方案原始選站，再比較正式採用與最終活動。固定 fixture 的一般體力／人工歷史訊號不代表這組真實條件已完成驗收。

這份驗收以生成後的三方案結果頁／done 為終點。`ResultsPage` 點選方案會經 `AnalysisSessionContext.requestPlanDetails` 另呼叫 `/api/generate-trip-details`，其中還有獨立 Responses AI 請求及可能的 Google 請求；本輪沒有把該獨立請求關聯進生成 UUID。若要驗收點開詳情後的完整體驗與帳單，現有這份證據仍不足，不能宣稱已涵蓋；本次 20 點初始生成取證應先在結果頁封存。

收到 done 後，還要確認伺服器出現 `[acceptance-evidence-saved]`、manifest 為 complete、五檔雜湊及 requestId 全部一致，再封存整個 UUID 資料夾。可用 done.response SHA-256 關聯本機實際交付資料，不必加入公開 API 欄位。

## 失敗、隱私與界限

- 寫檔為 append-free 的 `wx` 新檔，不覆蓋既有證據。部分檔案寫入失敗時，manifest 標 incomplete 並列缺檔；整個資料夾／manifest 無法寫入時，只有安全的 `[acceptance-evidence-incomplete]` console 標記可用，不能宣稱已保存。
- 觀測初始化、分類、序列化或寫入錯誤均 fail-open，不新增 retry，不更動原始例外、生成結果、串流事件或扣點。
- 不保存 token 字串、API key、Authorization、完整 URL、完整模型原文、完整 Prompt、原始歷史事件、任意自訂需求／查詢自由文字。只保存用途分析必要的公開地點與當次起點；歷史資料只保存樣本數與咖啡訊號，不保存帳號身分。
- 每次最多 12 AI attempts、每 attempt 12 原始方案、每方案 40 站、512 呼叫明細、256 決策；模型投影上限 256 KiB，每資料檔 2 MiB。超限會標記 incomplete，資料檔超限只存 omitted 訊息；外部呼叫總次數仍繼續累計。
- 身分投影只接受最多 200 字的英數／底線／連字號 ID；無法保存的身分標為 omitted＋incomplete，不把保存限制當成正式驗證拒絕。最終文字欄位投影最多 512 字；不保留描述等無關欄位，完整交付資料只保留雜湊。
- 總帳範圍是 **這次 generate-trip handler**，不是整個瀏覽器 session、帳戶或雲端帳單。其他獨立 `/api/geocode`、詳情生成、使用者改路線等後續請求不在此 UUID 範圍；不可把這份總帳冒充整次使用者旅程總計。
- HTTP succeeded 只代表傳輸／HTTP 狀態，不保證 provider JSON 的業務語意成功；既有驗證與 diagnostics 另行描述方案問題。應用程式快取命中與發出請求分開計算；provider 端快取、隱藏費用／內部重試不可觀測。
- 原有 qualityDiagnostics 仍是群組階段快照，沒有記錄每個內部 speculative repair 子步驟；新 raw attempts 補上 normalization 前骨架，不能用快照補造模型全文或不存在的活動內容。歷史 profile 為空也不能單憑樣本數區分沒有歷史與讀取後為空。

## 免費驗證與真正寫檔預演

測試包含 16 個真正 handler 固定情境：normal、history-coffee、raw-identity、retry、retry-envelope、refill、reject-refill、parse-failure、stream-fallback、fallback、geocoding-details、usage、points-failure、route-failure、ai-http-failure、ai-network-failure。逐案比較基準 b7498cf handler、診斷關閉及開啟的完整串流／回應，以及實際 mock HTTP/fetch 的網址、選項與 body，均須相同。另驗證 production、檔案／目錄失敗、並行隔離、大小限制、真實路線 memo 命中、自由文字／起點任意欄位排除與無法投影身分。缺少模型 message 的 envelope 格式錯誤不會遮蔽已回傳的數值 usage，原本拒絕決策保持不變。

基準 handler 從 Git 物件讀取，其他依賴使用本次工作樹；相關共用模組只有觀測掛點。39 個相依模組已檢查，沒有依賴無關未追蹤資料。原有兩個診斷 fixture 的 fs mock 只是避免舊測試寫入使用者資料；本輪新增的磁碟預演未 mock mkdir／write／read。

本機實際產物根目錄（在 repository 外）：

`C:/Users/wr124/.codex/visualizations/2026/10/18/01a14f39-7e6b-7bb3-81d9-a88b3de9fad5/acceptance-evidence-v1-verified-e2e-20261022/`

| 情境 | UUID（各資料夾內確有六份 JSON） | 合計 bytes |
| --- | --- | ---: |
| geocoding-details | `462e8910-83ec-42ae-9b8f-205b170bb7bf` | 515875 |
| retry | `ab2ba620-e369-48e2-a152-18e35a99d0ba` | 544634 |
| refill | `7f95edd9-4706-470b-9569-1b5c634515cb` | 467125 |
| fallback | `b3214bf2-f410-44f9-af95-fbbbc9a95b27` | 547000 |

`dry-run-summary.json` 是額外的本機預演索引。四次 manifest 均 complete；由 fixture 及獨立父程序實際讀檔核對五檔 SHA-256、共同 requestId 與目前四個來源雜湊，沒有僅靠 mock 寫檔成功回傳。前期預演目錄也予以保留，這個 verified-e2e 目錄對應最後的來源版本。

geocoding-details 預演：AI 1、Places Search 10、Details 1、Geocoding 1、Routes 7、Supabase 5，全部模擬成功；Details cache hits 89，不算成 HTTP。Prompt 14994 UTF-8 bytes，文化 ID 2、咖啡 ID 1、不確定 ID 1，均在該次實際 Prompt 曝光。RPC 模擬確認 20 點，餘額差額 unknown，實際付費與實際扣點皆為零。retry 最終 safe 來自 attempt 2；refill 最終 balanced 來自 attempt 2；fallback 的第二次 AI 嘗試未被誤標為最後採用。

固定回應只能證明證據傳遞、保存與正式流程未退化，不能證明真實 AI 更願意選文化候選。provider 不回傳 usage 時仍為 unknown；本輪不補呼叫以取得費用資訊。

最後驗證：`npm.cmd run test` **1359/1359 通過**（含本輪 22 項），`npm.cmd run build` 通過，`git diff --check` 通過。build 仍有原本大於 500 kB 的 bundle 提示，沒有為此改動前端。已具備下一次本機非 production 的 20 點驗收觀測條件；真實模型採用率、provider 未回傳的 usage／帳單，以及獨立餘額差額仍不能由本輪免費測試確認。

## 保護既有資料

開始時工作樹已存在這份觀測草稿，先以 SHA-256 保存 13 個檔案至 repository 外 `acceptance-evidence-v1-start-20261021/`，後續保留該起始副本。Meal Selection snapshot 的 experiment／restore-verification 共 28 份副本驗證通過，70 份原有保護資料未變，5 個暫緩實驗程式／測試仍未恢復到工作樹。免費實作階段沒有 stage、commit、push 或 merge；後續獨立提交另依使用者授權執行。

## 提交前審查（2026-10-22）

`package.json` 的 `test: npm run test:unit` 是先前 `fedd41fc` 提交加入，基準 `b7498cf` 已包含；本輪沒有新增或修改任何 npm script，也不提交 package 設定變動。本次實際執行紀錄顯示 `npm.cmd run test` 依序進入 test、test:unit 及 Node test runner。

本次另外重跑四組實際寫檔預演，產物在同一個 repository 外的 `acceptance-evidence-v1-commit-review-20261022/`，索引為 `dry-run-summary.json`。24 份資料檔與前次產物分開保存；除了共同 UUID、五檔雜湊及來源雜湊，另逐方案核對 done.response 雜湊、站點身分／停留時間及 diagnostics.final 的 AI 來源版本，全部一致。產物沒有納入提交。

預設保存位置固定為已 ignore 的本機 `.tripneeder-acceptance-evidence/`；本次所有預演明確指定 repository 外本機目錄。獨立詳情頁請求沒有建立本次生成的 context，不會誤計入初始總帳。此次只提交前述觀測程式、接線、必要測試與本文件，不提交既有調查資料、scripts、無關 fixture 或任何診斷 JSON／日誌。
