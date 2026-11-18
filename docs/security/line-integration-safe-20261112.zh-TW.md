# LINE 安全修復與整合交付

日期：2026-11-12（Asia/Taipei）。修復分支 `codex/integrate-line-safe`，工作區 `C:\Users\wr124\Projects\tripneeder\.tmp\line-safe-integration`。

**程式整合 GO；正式發布／無人陪同的完整展示驗收尚未放行。** 已實作修復與整合，不是再次純審查。沒有 push、修改本機 dev、合併 main、部署或操作正式 Supabase。真實 LINE 與 OAuth 平台往返仍需人工確認。

## 基準與整合方式

- 重新 fetch 全部 origin heads 後，以最新 `origin/dev`：`fbddf5dc719af2820e6624393ac5d54bbacefc48` 建立獨立 worktree／分支。
- 功能來源：Charles 的 `origin/Line`：`5ef1d92d386363238a47560de11f0a0b8a053545`。保留原分支；移植 Bot 與 Flex 功能並在 dev 架構內修復，沒有用組員整棵目錄覆蓋 dev，也沒有套入過時的生成 API。
- 保留 dev 的登入驗證、限流、原子生成快照與付款、收藏、生成修復、真實天氣、社群、RLS 與 migration。原 `LoginPage`、`App`、`DetailPage`、共用 Supabase client 與 SQL migrations 未改動；不加入硬編碼專案／網址 fallback 或 URL plan 匯入。
- 原始工作區 `codex/wip-before-weather-merge` 與既有五個追蹤檔案的未提交修改保留；其他 worktree 與分支不變。

## 五項修復

1. **移除固定 token 入口。** 公開 `/api/generate-trip` 仍必須經 Supabase Auth 實際驗證；`line-internal-bot` 與任意 LINE_DEV_BYPASS_TOKEN 都不能取得權限。LINE 從驗證後 webhook 呼叫 server module 的 `generateTripForLine`，由既有 service-only RPC 解析 LINE 對應的原網站使用者，使用同一限流與付款流程。HTTP body／header 不會選入此內部路徑。
2. **原始 request body 先驗簽。** 讀 Node request stream，保留原始位元組，限 1 MiB；不先讀解析後 body getter。缺少／錯誤簽章回 401，原始內容不可用回 400，全部在資料庫、LINE 回覆與生成之前停止。已解析 object 不會被 stringify 後勉強驗簽。簽章正確後才解析 JSON 與 events。依據：[LINE 簽章文件](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)。
3. **必要設定缺漏即拒絕。** LINE secret、access token、HTTPS app origin、server Supabase URL 與 service role key 任一缺漏，LINE 路徑不提供服務。沒有公開預設 secret、anon 降級、猜測 RPC overload 或硬編碼專案。
4. **付款與帳本一致。** 移除 Bot 自行 update profiles／insert point_transactions 及第二次扣點。使用 dev 的 `claim_trip_generation` → `complete_paid_trip_generation`：同一交易扣 20 點、寫帳本、保存不可修改的完成快照。失敗不交付 plan／done；提交回應遺失先讀快照確認，無法確認時不宣稱成功或未扣點。確認卡使用位置事件產生的穩定 generation ID，同卡重按、webhook 重送與並行請求不重複收費。開始時間也固定在同一個確認流程，不隨重送改變。付款成功後 LINE 發送失敗，可用網站最近行程恢復。
5. **沿用確切資料庫契約。** 找到私人備份內既有四個 LINE RPC 定義及升級後驗證紀錄，確認與正式 23 筆 migration 的敘述相符。沒有建立／覆寫正式函式。前次報告中「尚未取得 LINE 契約」已由本次找到的證據補足；這不是聲稱本次重新連線查詢了正式庫。

## 綁定、解除與身分保護

- Bot 提供短效 HMAC 連結至 `/line-connect`；登入後顯示目前帳號與連接用途，使用者明確按確認，才開始連接。
- API 驗證原網站 session，從 getUser 取得 user ID，不能由請求指定其他會員。使用 LINE 官方一次性 link token 與 accountLink 流程確認實際 LINE 帳號，防止單靠被轉傳的連結自動誤綁。參考：[LINE 官方帳號連接流程](https://developers.line.biz/en/docs/messaging-api/linking-accounts/)。
- 隨機 IV 的 AES-GCM nonce 保存加密的網站 user ID、LINE ID 及 10 分鐘期限；與 webhook source LINE ID 比對。nonce 不含可讀的會員 ID。
- 用現有 service-only `consume_api_rate_limit` 存放 nonce 的 SHA-256 一次性消耗記錄（1 次／3600 秒；nonce 600 秒就失效），不使用記憶體去重作為安全邊界。此處 RPC 錯誤即拒絕，沒有本機 fallback。若消耗後 RPC 出錯，需取得新連結，不自動重綁。
- LINE `accountLink` 簽章、result、nonce、LINE ID 與時效均通過後才呼叫 `bind_line_user(uuid,text)`。重送 nonce 不再呼叫 bind。其他帳號已綁定的 LINE ID 由既有 UNIQUE／RPC 拒絕；不建立／合併 Auth 使用者。
- `GET /api/bind-line` 只讀驗證使用者自己的布林連接狀態；POST unbind 只呼叫 `unbind_line_user(p_user_id=驗證身分)`，資料庫失敗不回成功。
- 確認卡另有 owner HMAC，解除／重新連接後，前一個帳號的卡片不能向新帳號發起扣點。生成入口重查 owner；LINE 交付前也再次確認對應未改變。
- LINE 卡片連至 `/line-trip/:generationId`，透過既有登入與 owner 篩選恢復已付款快照。雨備也從同一 owner 的快照讀取，不使用先前 LINE 使用者快取或信任 postback 傳入的行程內容。
- 原本選擇時長／交通的聊天提示保留；最後確認卡也提供帶完整位置與參數的選擇按鈕，冷啟動後可直接調整並確認，不依賴某個 instance 的對話記憶。記憶體中的早期選擇僅作提示預設值，確認卡顯示的條件才是生成輸入。
- 不再偽造固定溫度或降雨機率；卡片引導網站即時天氣，既有天氣 API／UI 保留。

## 資料庫契約核對

來源（唯讀本機檔案）：

- `C:\Users\wr124\TripNeeder-Backups\supabase-production-preupgrade-20261104-1943\line-contract.json` 與 `schema.sql`。
- `C:\Users\wr124\TripNeeder-Backups\supabase-production-upgrade-20261104-2247\result.json`：記錄升級提交並驗證，finalVersions 為 23 筆、LINE 結構與函式保留、RPC effective privileges 通過。這是 2026-11-04 的歷史證據，不代表 11-12 重新驗證線上狀態。

| 契約 | 核對結果 |
| --- | --- |
| `profiles.line_user_id` | 可空 text；`profiles_line_user_id_key` UNIQUE |
| `bind_line_user(p_user_id uuid,p_line_user_id text)` | 鎖定會員、要求會員存在、拒絕其他會員已持有 LINE ID；同一帳號同一 LINE 重綁可冪等 |
| `unbind_line_user(p_user_id uuid)` | 僅更新指定會員 LINE 欄位 |
| `get_line_user_profile(p_line_user_id text)` | 回傳 id／email／display_name／points_balance，無對應回 NULL |
| `consume_points_for_line_user(p_line_user_id text,p_reason text)` | 固定 20 點、鎖定餘額、同一交易更新餘額及帳本；無 p_cost overload |
| 四個 LINE RPC 權限 | SECURITY DEFINER，空 search_path，postgres owner；anon／authenticated 不可 EXECUTE，service_role 可以 |
| 新 Bot 的扣點 | 沿用 dev 已有 complete_paid_trip_generation，不呼叫 legacy consume，避免雙扣與缺乏 generation 冪等 |

可分享的結構與函式雜湊摘錄：`docs/security/line-rpc-contract-20261104.json`。測試 fixture `tests/fixtures/line-rpc-contract.sql` 只包含四個既有函式定義與其 ACL，不含正式資料，**不是 migration，不應在正式 SQL Editor 執行**。SQL migrations 沒有變更，亦無新增正式 SQL 需求。

## 測試結果

最終修復版本在獨立工作區執行：

| 驗證 | 結果 |
| --- | --- |
| Build／TypeScript | `npm run build` 通過，含 api TypeScript 與 Vite production build |
| Lint | `npm run lint` 通過 |
| 完整單元／回歸 | 1823 項，1820 通過、0 失敗、3 既有略過 |
| 新增 LINE 測試 | 39 項，包含在完整回歸數量內，無重複計數 |
| diff whitespace | `git diff --check` 通過 |

新增測試涵蓋原始串流與空白簽章差異、解析後 body 拒絕、大小限制、未設定金鑰、未登入／固定 token、指定他人 ID 不生效、正式 link token 流程、過期與錯誤 nonce、持久化重播拒絕、RPC 錯誤、重複綁定、解除保留原 Auth／點數、餘額不足、付款失敗、提交回應遺失、並行生成、同確認卡重按、換綁後舊卡拒絕及雨備 owner 隔離。

PGlite 使用真實 PostgreSQL 引擎執行既有函式與 dev 付款 migration：人工加入失敗的帳本 trigger，驗證例外會回滾餘額及生成快照；成功與重送只有一筆付款帳本。API／生成測試執行實際 handlers，但 Auth、LINE、AI、Google HTTP 均為 stub。完整測試沿用 dev 的外部網路阻擋器，沒有呼叫正式或付費供應商。PGlite 測試不冒充原生多連線 PostgreSQL 的併發驗證；API 並行有測試，資料庫列鎖實作沿用已驗證 dev SQL。

3 個原有略過項目因缺少選用 Central Park 調查快照，不列為通過。全部原有點數、登入拒絕、收藏、生成、社群、天氣及 migration 回歸均無失敗。

本機完整輸出在工作區 `.tmp/line-full-tests.log`、`.tmp/line-build.log`、`.tmp/line-lint.log`；不提交大量測試日誌。

## 展示環境需要的設定與人工驗收

新增 server-only 環境變數（已列入 `.env.example`）：

- `LINE_CHANNEL_SECRET`：同一個 Messaging API Channel 的真實 secret。
- `LINE_CHANNEL_ACCESS_TOKEN`：該 Channel 的 access token。
- `LINE_APP_URL`：展示網站的實際 HTTPS origin，例如 `https://實際網域`，不含 path／query；不猜測使用先前組員測試站。

沿用既有 server-side `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` 及生成服務 key。前端仍只使用 VITE_SUPABASE_URL／VITE_SUPABASE_ANON_KEY。不得為任何私鑰加 VITE_，亦不設定 LINE_DEV_BYPASS_TOKEN。

需由維護者確認（本次未變更）：

1. LINE Developers 的實際 Channel、access token／secret 是否同源、Webhook URL 是否指向該展示環境 `/api/line-webhook`、Use webhook 是否開啟。
2. Supabase 原有 Google Provider 與 OAuth 設定保留；Redirect URLs 須允許展示 origin 的 `/line-connect`（含查詢）及 `/line-trip/*`。實際網址與允許清單未提供，本次不自行更改。
3. 展示平台須將原始 bytes 交給 webhook；實際 Vercel runtime／LINE Verify 操作尚未執行。已測 Node raw stream，平台若只提供解析 object 則安全拒絕，應修正平台串流設定，不能降級驗簽。參考：[Vercel raw body 文件](https://vercel.com/kb/guide/how-do-i-get-the-raw-body-of-a-serverless-function)。
4. 人工以既有帳號完成登入／登出、LINE 官方確認、狀態顯示、解除、跨帳號重綁拒絕；完成一次 20 點生成，重按確認不再扣點，LINE 卡片能在同一帳號免費恢復，別人無法讀取。
5. 在真正部署平台確認 LINE 同步 webhook 生成所需時間及重送行為。這次保留組員同步生成方式與 300 秒函式設定，沒有引入佇列或新基礎設施；未冒稱長耗時平台驗收完成。即使 LINE 交付失敗，已付款快照仍可由原帳號恢復。

上述外部金鑰與平台資訊應由環境設定提供，不需在聊天或版本庫貼入秘密。正式發布在這些人工門檻完成前為 **NO-GO**；本次交付的修復分支已具備 **可整合、可進行展示環境驗收** 的程式條件。
