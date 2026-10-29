# 付費行程生成一致性 v1：本機實作交付

日期：2026-10-27（Asia/Taipei）。基準與目前 HEAD：`b92c3eccd57f7276df84de03a9a837dcc9df8626`。

已完成批准的最小方案。本機檢查達到可提交審核條件；尚未 Commit、Stage、Push、Merge 或 Deploy，沒有操作正式 Supabase／Migration History，也沒有呼叫真實付費 API。正式發布仍需另行批准與真實環境驗收。

**1. 本輪檔案範圍**

| 類別 | 新增／修改 |
| --- | --- |
| 新 Migration | `supabase/migrations/20261027220000_paid_generation_consistency_v1.sql`：新表、不可變保護、claim／complete／fail RPC、限定 service_role 的權限 |
| 生成 API | 修改 `api/generate-trip.ts`：驗證身分、claim、點數預檢、延後付費內容、原子提交、斷線與不確定提交處理 |
| 恢復 API | 新增 `api/trip-generations.ts`、`api/_lib/trip-generations.ts`：本人狀態、完成快照及每頁 20 筆的已付款清單 |
| 前端共用 | 新增 `src/services/ai/generationInput.ts`、`generationSessionStorage.ts`；修改 `proxyTripPlanner.ts`、`types.ts` |
| 前端狀態與畫面 | 修改 `AnalysisSessionContext.tsx`、`analysisSession.ts`、`HomePage.tsx`、`RecentPage.tsx`；新增 `PaidGenerationRecovery.tsx` |
| 本機入口 | 修改 `vite.config.ts`：恢復 API、伺服器專用 service role 設定、偵測回應連線關閉 |
| 新驗證 | `tests/unit/paid-generation-consistency.test.mjs`；`fixtures/paid-generation-regression-contract.mjs`、`paid-generation-restart.mjs`、`paid-generation-native-handler.mjs`；`scripts/security/test-paid-generation-consistency-v1.mjs` |
| 既有驗證適配 | `acceptance-evidence.test.mjs`、`final-plan-text-regression.test.mjs`、`trip-coverage-v2.test.mjs`、`trip-plan-identity.test.mjs`；fixtures 的 `acceptance-evidence-replay.mjs`、`coverage-experiment-loader.mjs`、`coverage-phase2c1-matrix.mjs`、`coverage-phase2c1-replay.mjs`、`plan-identity.mjs` |
| 證據 | 本文件、`paid-generation-consistency-v1-db-results.json`、`paid-generation-consistency-v1-verification.json`（均在 `docs/security/`） |

既有 Migration 沒有修改；新版本與本機已有版本不衝突，未加入組員 011–018。研究文檔、正式回復 SQL、舊研究結果與未追蹤的研究測試均保留。驗證會重新執行既有研究測試，但沒有把其功能或 Migration 整合進正式程式。

**2. 實際執行流程**

1. 前端取得登入身分，在任何生成 POST 前，以帳號範圍的 localStorage 保存 UUID、原始偏好及狀態。無法持久保存時停止啟動。成功後明確的新生成換新 UUID；未完成的相同輸入、重試與重新載入沿用原 UUID。
2. 後端使用既有 `requireAuthenticatedUser`／Supabase Auth `getUser` 驗證身分。輸入只保留有效偏好欄位，限制 16,000 字元，排除任意 body 欄位及憑證；位置解析不覆寫帳本中的原始輸入。
3. service role client 獨立使用伺服器憑證呼叫 claim。完成結果直接重播，當前餘額與 OpenAI 設定不影響重播。同 ID 不同輸入為 409；他人 ID 與不存在為 404；有效 running 回 202，讓前端查原 ID。
4. 新 attempt 才初始化／預檢點數；不足 20 回 402，沒有 OpenAI、Places 或 Routes 呼叫。租期 360 秒，對應現有函式 300 秒上限；接手換新 attempt token。
5. 生成、Coverage、Repair、Validation 及既有部分風格交付規則維持。提前串流僅傳 `progress { style, stage }`。三風格進度卡沒有標題、摘要、stops、placeId、座標或路線內容。
6. 完成最後 `finalizePlanText` 及 JSON 序列化後，檢查連線取消，再呼叫 complete。短交易鎖定帳本列、驗證租期／憑證、固定扣 20、寫 ledger、存最終完整 JSON 及成交資訊；任一失敗整筆回滾。
7. 從成功提交回傳的快照送出 `plan`，最後 `done`。付款未確認時不交付結果；如果提交成功但 RPC 回應遺失，先查相同 ID，確認 completed 才交付。提交是否成功不明時不盲目 fail，也不換新 ID。
8. EOF、網路中斷或 202 會查原 ID；running 最多約 375 秒輪詢，伺服器確認租期過期才以相同 ID 接手一次；狀態服務不可用則停在確認失敗，保留 ID 供人工重試。明確的 400／401／402／403／404／409 不會被恢復邏輯當作成功。恢復快照也會比對原始輸入。
9. 首頁重新載入會恢復該帳號尚在分析的 ID；10 分鐘 UI TTL 不會清掉帶 generation ID 的紀錄。「最近生成 → 查看已付款行程」可從分頁清單取回原始快照，重建本機結果畫面，不需要 recent 副本或再次付費。

`trip_generations` 開啟 RLS，撤銷 PUBLIC／anon／authenticated 的表存取及三個 RPC 的預設 EXECUTE；service role 只取得表 SELECT 及 RPC EXECUTE，寫入經 SECURITY DEFINER 函式。RPC 固定安全 search_path、完整限定表名。完成列的 UPDATE 由 Trigger 拒絕，只有刪除帳號的 cascade 會刪除其生成資料。恢復每筆查詢與清單都限制已驗證的 owner，所有回應 no-store，沒有對外回傳執行憑證或內部錯誤。

成交 UUID 不對 30 筆 ledger 建 FK，也不以 ledger 是否還存在判斷付款。依批准提案，完成快照不設短 TTL，保留到刪除帳號；v1 沒有容量或長期保留排程的正式環境量測。前端只存該帳號偏好與生成 ID，不保存 token／key。

running／failed 紀錄目前同樣沒有自動清理，現有清理方式為刪除帳號時的 cascade。未來新增清理機制時，必須保留已付款快照及去重依據，不能因清除 ledger、recent 或未完成嘗試而使同一筆已付款生成再次扣款。

已檢查前端其他入口：實際及 legacy 首頁送出皆共用 AnalysisSession；只有 ProxyTripPlanner 讀生成串流；首頁不再讀 partial plan 內容。細節補充、候選替換、recent／收藏仍操作既有已取得方案或可修改副本，不會取得正在付款前的完整生成結果。

**3. 免費驗證結果**

| 驗證 | 結果與邊界 |
| --- | --- |
| TypeScript | `npx tsc -b` 通過；最後 `npm run build` 再次包含兩個 TS project 的檢查 |
| Build | 通過；有既有的 bundle 大於 500 kB 提示。生成 bundle 沒有新後端 service-role 設定名稱或付款 RPC 程式 |
| 完整單元 | `npm test`：1,859 passed／0 failed／0 skipped；含原有研究測試 |
| 最後相關回歸 | 前端帳號切換可見性與取消提示收尾後，付款一致性、既有登入、三風格與主要串流：88 passed／0 failed |
| 原生 PostgreSQL | PostgreSQL 17.11、15 組全部通過；使用 loopback、獨立連線與一次性測試 DB，完成後清除 DB 並停止本機服務 |
| 靜態檢查 | 新增／修改的前端、恢復 API、共用 store 與 Vite 檢查通過。另檢查大型生成 API 時發現原 HEAD 已有 `_rotationOffset` 未使用的 ESLint 錯誤，保留原演算法；TS／Build 不受影響 |
| 研究與備份 | 使用既有 383 檔案 SHA-256 基準核對；只出現本輪預期修改，沒有缺檔，舊研究／回復備份與所有舊 Migration 未變 |

| 必驗情境 | 實際證據 |
| --- | --- |
| 正常生成／付款／快照 | 真正 handler 跑 Mock 供應商及原生 PostgreSQL RPC，三風格最終交付 JSON 等於 DB JSON，扣 20 且一筆 receipt |
| 初始不足／最終競爭不足 | 初始 19 點時供應商 0 次；原生 DB 不同 ID 競爭最後 20，只能一筆成交，另筆沒有快照／負餘額 |
| 原子回滾 | 在扣款與寫 ledger 後注入 snapshot 更新失敗；balance、ledger、30 筆清理與快照全部回滾 |
| 扣款前保密 | handler 每個事件核對：所有 plan／done 當下都已 completed；progress 無可用方案欄位 |
| 扣款前斷線 | 觀察 abort 後沒有 complete、沒有付費內容；同 token 安全轉 failed |
| 扣款後斷線／回應遺失 | Mock RPC 成功但回應丟失可查回；實際 handler＋原生 DB 在完成 RPC 後立即 abort，沒有 plan／done，獨立新程序可讀相同快照 |
| 同 UUID 並行 | API 並行只啟動一輪供應商；原生 8 獨立連線只有一個 claim，8 次 complete 仍只扣一次 |
| 租期／舊 worker | 過期未接手已不可提交；接手換 token 後舊 complete 拒絕、舊 fail 無效，新 token 可成功 |
| 同 ID 不同輸入 | API 409、DB claim input_mismatch；前端不把 409 或不同輸入的恢復結果當成功 |
| 重啟恢復／清理 | 新 Node 程序只用原生 DB 取回；刪 recent、prune ledger 後仍 completed，不重扣 |
| 帳號隔離／偽造入口 | 新程序以他人身分查同 ID 回 404；每筆與列表的 owner filter 有測；anon／authenticated 表 SELECT／寫入及三 RPC 都拒絕；未驗證登入不能到供應商 |
| 重試成本 | 同 ID 完成重播時 OpenAI／Places／Routes 新增 0，扣款新增 0，即使目前餘額為 0 且缺 OpenAI key 仍可重播 |
| 既有能力 | 登入、原有 2 點扣款 RPC、初始贈點一次性、管理員原 ACL／修改及三風格／Coverage／Repair／SSE 回歸通過 |

Coverage 的原有凍結 JSON 完全保留。測試讀取本輪基準 HEAD 的 handler 驗證舊凍結 hash，再比較新版所有品質／供應商欄位，只允許「舊 plan → progress，成功 done 前插入已付款最終 plan」的事件變更。其他歷史回歸只排除新增付款持久化往返及取消 signal，仍逐項比對供應商內容與次數。

重現：先以已備妥的本機 PostgreSQL runtime 啟動 `127.0.0.1:55439`，執行 `node scripts/security/test-paid-generation-consistency-v1.mjs`。腳本固定 loopback、不讀 .env，會建立／清除 `paid_generation_<timestamp>` 測試 DB；不是 Supabase migration/deploy 指令。完整單元不需要本機 DB，執行 `npm test`。詳細 log 位於 `.tmp/paid-generation-consistency-v1/` 的 `unit-final.log`、`targeted-final.log`、`build.log`、`db.log`、`lint-final.log`。

**4. 延遲、成本及交付率**

- 正常生成沒有新增 OpenAI、Places、Routes 呼叫；歷史固定案例的所有原有供應商次數與 payload 回歸維持。Safe／Balanced／Explore 仍為一次共 20 點，部分方案合法交付規則維持。
- 相對原路徑，增加一次免費 Auth 身分驗證、一次 claim；原扣款 RPC 被原子扣款＋快照 RPC 取代，正常流程總共淨增 2 次免費服務往返。
- 本機 SQL 一次樣本：claim 約 9.91 ms、atomic complete 約 8.74 ms。這是 loopback 小型 SQL 快照，沒有真實雲端網路／Auth／完整快照延遲，不能當正常雲端生成延遲承諾。
- 完整方案首次可見時間延後到 Validation／Repair／文字整理及付款保存結束；進度仍持續顯示。付款失敗的表面「成功」會消失，已付款但連線中斷的結果可恢復。真實交付率與 p50／p95 尚未量測。
- 未付款前程序崩潰、租期接手可能重做供應商工作；不同 ID 同時花掉餘額也可能在末端付款失敗。這是批准最小方案的邊界，沒有引入預留款或退款系統。

**5. 尚未執行的真實端到端驗證**

尚未在真實 Supabase Auth／PostgREST、部署後 HTTP 路由與 SSE 代理、Vercel timeout／程序強制終止、真實瀏覽器跨裝置及實際付費供應商環境執行端到端驗收；也沒有套用正式 Migration、測量正式資料量／容量、正式 latency／交付率。所有遠端供應商/Auth 回應均為 Mock，PostgreSQL 交易、權限及多程序持久恢復則是真正本機執行。正式發布前需另行批准這些驗收與環境變更。

**6. Commit 條件與停止點**

本輪要求的本機 TS、Build、完整單元、相關回歸及免費資料庫安全驗證已完成，可以進入人工 diff／Migration 審核並選取本輪檔案提交。尚未 Stage／Commit，工作區中的原有未追蹤研究檔案不應一併提交；本文件及機器可讀 verification 檔提供明確的本輪檔案清單。既有未使用變數 lint 問題及真實環境端到端驗收邊界如上。

依指示完成後停止，等待審核。
