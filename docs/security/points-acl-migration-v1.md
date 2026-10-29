# 點數權限正式 Migration v1

日期：2026-10-27（Asia/Taipei）。本輪只有本機檔案及免費本機資料庫測試；沒有連正式 Supabase、改正式歷史、呼叫付費 API、Commit、Push、Merge 或 Deploy。

## 版本與分支檢查

本機 dev HEAD 為使用者指定的 `4f684831f5ee2fa45ef11837e3b1878549541879`。本機 origin/dev 是較舊的 `a3db0a8`，因此另用 GitHub 唯讀工具檢查遠端分支及目錄，沒有切換分支或合併。遠端目前只有 dev、main、weather，沒有開啟的 PR；這不代表沒有組員尚未推送的工作。

本機 dev、遠端 dev 與 main 的 migration 檔名皆為以下十份：

| 版本 | 檔名 |
| --- | --- |
| 001 | `001_points_schema.sql` |
| 002 | `002_points_consumption.sql` |
| 003 | `003_trip_records.sql` |
| 004 | `004_point_transactions_retention.sql` |
| 005 | `005_user_persona.sql` |
| 006 | `006_persona_transport_mode.sql` |
| 007 | `007_persona_people.sql` |
| 008 | `008_fix_initial_points_logic.sql` |
| 009 | `009_persona_people_nullable.sql` |
| 010 | `010_personalization_events.sql` |

本機 integration/weather-traffic 額外含 011；本機 origin/weather 含 011–017。遠端 weather 已前進到 `a8ce99cf277c34601a340cd7356e3e38df61eb51`，除了組員 011–017，還有 **018**：

| 已使用版本 | 檔名 |
| --- | --- |
| 011 | `011_community_trip_sharing.sql` |
| 012 | `012_community_discussions_and_filters.sql` |
| 013 | `013_community_privacy_controls.sql` |
| 014 | `014_shared_trip_access_and_privacy.sql` |
| 015 | `015_api_rate_limits.sql` |
| 016 | `016_community_hardening_and_pagination.sql` |
| 017 | `017_shared_trip_validation_and_completion.sql` |
| 018 | `018_preserve_shared_interactions_and_transport.sql` |

來源：[weather migration 目錄](https://github.com/linweiren/tripneeder/tree/a8ce99cf277c34601a340cd7356e3e38df61eb51/supabase/migrations)。測試結果 JSON 保存每份遠端檔案的 Git blob SHA，避免把本機較舊的同名檔案誤當成最新內容。沒有修改或複製這些檔案進 dev 的 migrations。

新檔為 **`supabase/migrations/20261027103330_points_column_write_acl.sql`**。`20261027103330` 是建立時取得的 UTC 時間戳，符合 Supabase 建議的 `<timestamp>_<name>.sql`，排序在現有 001–018 之後，避開組員的 011–018。可見分支及本機參照未發現相同版本或其他預留；不能保證不可見的私人分支。既有三位數版本不改名。參考：[Supabase migration 命名](https://supabase.com/docs/reference/cli/supabase-migration-new)。

這是檔案版本盤點，**不是 dev 或正式資料庫的已執行版本清單**；本輪沒有資料庫 Migration History 的存取或查詢。既有研究文件中建議使用 011 的文字已過時，本輪保留研究原檔，實際以此時間戳版本為準。

## 與正式修補 SQL 的差異

依據為使用者確認已在正式成功執行的 `docs/security/points-column-grants-proposal.sql`。移除該檔開頭三行「REVIEW ONLY」說明，換成五行版本、前置條件與部署說明；從 `BEGIN;` 到 `COMMIT;` 的內容經 CRLF→LF 正規化後完全相同，測試已逐字確認。正式執行及七項 PASS 是使用者提供的結果，本輪沒有再次連線驗證。

保留所有表級／欄位級 REVOKE、八個人設欄位的 authenticated UPDATE、service_role 的 profiles UPDATE，以及繼承角色、NOINHERIT 成員關係、RLS 狀態、管理員 ACL、SECURITY DEFINER RPC owner／EXECUTE、清理 Trigger owner／DELETE／啟用狀態的檢查。`BEGIN`、`SET LOCAL lock_timeout = '5s'`、檢查失敗拋錯與 `COMMIT` 均保留。

Migration 不修改 RLS policy、Schema、函式本文、角色成員關係、點數算法或資料。只變更 profiles／point_transactions 的 ACL；沒有建立「如果已修補就略過全部驗證」的捷徑。重複套用仍逐項驗證，漂移時完整失敗，避免把缺失環境假裝成成功。

## 本機驗證

使用既有免費 PGlite **0.3.14／PostgreSQL 17.5**，在四個各自獨立的記憶體資料庫實際執行 SQL。沒有修改 package.json／lockfile，沒有安裝新套件。一般角色操作使用 `SET ROLE authenticated/anon/service_role`；所有帳號及資料都是測試假資料。

| 情境 | 結果 |
| --- | --- |
| dev 原始 001–010 → 新 Migration，含十種故障注入 | 25/25 PASS |
| dev 原始 001–010 → 已在正式使用的 proposal → 新 Migration | 16/16 PASS |
| dev 001–010 ＋遠端最新 weather 011–018 → 新 Migration | 15/15 PASS |
| 同上 001–018 → proposal → 新 Migration | 16/16 PASS |
| 合計 | **72/72 PASS** |

覆蓋內容：

- 從空白應用程式資料庫依序執行所有原 migration，沒有跳過或改寫。
- 首次套用、已修補再套用、再次重跑的表級／欄位級 ACL 一致性。
- 一般使用者無法直接修改點數、初始領點旗標，不能透過混合 payload、INSERT／UPSERT、DELETE／TRUNCATE 繞過；不能偽造或更動 ledger。
- 八個允許欄位仍可儲存、重設、RETURNING；其他使用者的 Profile 維持 RLS 隔離。
- 20 點／2 點 RPC、餘額查詢、初始 100 點與序列重複初始化；不足／零／負／NULL cost 不改餘額及 ledger。
- service_role 修改其他帳號並寫入 ledger；42 筆新增後保留最新 30 筆，跨門檻後 20／2 點 RPC 仍寫入交易，初始紀錄被清掉後不再次贈點。
- Migration 前後的欄位、預設值、constraints、RLS、policies、函式定義／owner／ACL、triggers、角色成員關係、default ACL 及既有資料均不變。
- 十種故障包含繼承表級 UPDATE、繼承欄位 INSERT、NOINHERIT 可達父角色、管理員缺 INSERT、RLS 停用、RPC INVOKER、RPC owner 權限不足、Trigger 停用、清理函式 INVOKER、清理 owner 缺 DELETE。每案刻意先加入寬鬆 ACL 並撤銷 service_role UPDATE，確保 Migration 真的有變更可回滾；確認交易進入 `25P02` 中止狀態，ROLLBACK 後逐一比對全部 ACL、結構及資料。

重跑 dev 測試（不依賴未追蹤研究文件）：

```powershell
node scripts/security/test-points-acl-migration-v1.mjs
```

本次完整重跑命令：

```powershell
node scripts/security/test-points-acl-migration-v1.mjs --proposal docs/security/points-column-grants-proposal.sql --weather-fixtures .tmp/points-migration-v1/weather-current-fixtures.json
```

`--proposal` 額外核對實際提案 SQL 並用其建立已修補情境；未提供時以新 Migration 本身建立相同 ACL。`--weather-fixtures` 為本輪透過 GitHub 唯讀取得上述固定 commit 的 011–018 `{name,blob,sql}` 暫存陣列，載入前驗證 Git blob SHA；不提交組員 SQL 的副本。未提供則只跑 dev 情境，結果項數會不同。可用 `--report` 指定另一份結果路徑。現有結果為 `points-acl-migration-v1-results.json`。

若另一本機沒有 runtime，可在專用暫存目錄安裝免費的固定版本，再用 `--runtime` 指向其 `dist/index.js`，不要變更應用程式的 dependencies：

```powershell
npm install --prefix .tmp/points-acl-test-runtime --no-audit --no-fund @electric-sql/pglite@0.3.14
```

**驗證界線：** 原始 001–010 以及組合後 001–018 均在上述本機 PostgreSQL 引擎完整重建成功，沒有遇到 migration 序列阻斷。但它們依賴 Supabase 管理的 auth.users／auth.uid()／auth.jwt()、API roles 與預設 table grants；測試明確建立這些替代環境，並未將任何補丁塞進原 migration。本機缺少 native PostgreSQL、Docker、Supabase CLI，repository 也尚無 `supabase/config.toml`，所以**沒有執行完整 Supabase CLI `db reset`、真正的 Migration History 寫入、PostgREST／JWT 驗章或管理器 HTTP 整合測試**。單連線測試不涵蓋初始化函式的既有並行競態；本輪不改該邏輯。

## 未來正式部署與 Migration History

正式發布前必查（本次 Commit 不處理歷史差異，也不執行下列指令）：

- 使用 `supabase migration list` 比對本機與遠端 Migration History。
- 使用 `supabase db push --dry-run` 確認完整預計套用清單。
- 特別核對遠端分支的 018、尚未整合的 011–017 與本次 `20261027103330` 的順序；遠端分支有檔案不代表正式資料庫已套用。
- 不得因順序問題自行套用組員未完成或未核准的功能 Migration。
- 不得直接修改正式 Migration History 或盲目使用 `--include-all`；差異留待後續發布工作另行核對與批准。

**目前狀態：SQL Editor ACL 修補已完成（使用者回報）；版本 `20261027103330` 是否存在於正式 Migration History 未查證，不能當作已記錄。** 本輪沒有連正式，也沒有執行以下指令。

未來取得部署授權後，建議流程：

1. 先確認連線目標及部署分支，唯讀執行 `supabase migration list --linked`，核對正式歷史、實際資料庫前置條件及本地版本。不要把檔案存在、七項 PASS 或 SQL Editor 執行成功等同於 history 已有紀錄。
2. 在可拋棄的本機 Supabase 環境以實際選定版本的 CLI 跑完整重建與此 Migration；核對角色預設權限。建議先整合本次已知的 011–018 再正式部署時間戳版本，讓待執行順序與測過的序列一致。這不代表授權執行組員 migration，仍須各自完成審核。
3. 用 `supabase db push --dry-run` 檢查完整待執行清單。若舊 001–010 也缺 history、遠端有本地不存在的版本，或清單有未審核的 migration，先停止並核對每一版是否已實際套用。不得為了推進此 ACL 修補而盲目重跑、改舊檔或批次標記歷史。
4. 若前置歷史已一致，且本版本尚未記錄，優先讓正常 `supabase db push` 流程**實際再套用一次新 Migration**。重套 ACL 已經本機驗證，不會重複扣點／贈點，也不會重新開放敏感權限；成功後 CLI 才建立本版本的 history 紀錄。再執行七項驗證及核對 history。若檢查失敗，交易回滾，修正環境後重試，不能標記為成功。
5. 成功記錄後，後續正常 push 依版本跳過；如果 SQL 已提交但部署中斷、history 沒留下紀錄，再次套用仍可收斂。這不等於本輪已測過 CLI 的 history 故障情境。

Supabase 的 `db push` 依 history 判斷已套用版本，成功後才新增紀錄；`--dry-run` 只列出待執行項目。參考：[官方 db push 說明](https://supabase.com/docs/reference/cli/supabase-db-push)。

另一種方式是，先對正式目錄及**本檔所有檢查**取得等價證據、確認歷史差異原因、並另經人員批准後，才以 `supabase migration repair 20261027103330 --status applied` 對齊既有手動修補紀錄。**這個指令只改 history，不執行 Migration，也不會補驗本檔檢查；不是本次建議的預設方案，本輪未執行。** 不得只憑七項 PASS 就批次 repair 所有舊版本。參考：[官方 migration repair 說明](https://supabase.com/docs/reference/cli/supabase-migration-repair)。

如果時間戳版本先部署、011–018 之後才合併，這些版本會排序在已部署版本之前；CLI 可能要求額外處理缺失的較早 migration。不得直接用 `--include-all` 繞過審核。團隊之後新增 migration 應協調使用較新的唯一時間戳，保留已部署版本不改名。任何未來重新授予廣泛 UPDATE 的 migration 都需再次驗證有效 ACL；本 Migration 不能禁止後續管理員另行授權。

## 備份與提交範圍

`.gitignore` 僅新增 `/docs/security/backups/` 規則及說明註解；已確認會排除巢狀備份，且該目錄沒有已追蹤檔案。沒有修改或納入該目錄任何內容，沒有變更既有未追蹤研究文件、舊測試或組員 migration。原檔以 SHA-256 比對確認未改動。

建議審閱後只提交以下五個檔案，不要使用 `git add .`：

- `.gitignore`
- `supabase/migrations/20261027103330_points_column_write_acl.sql`
- `scripts/security/test-points-acl-migration-v1.mjs`
- `docs/security/points-acl-migration-v1.md`
- `docs/security/points-acl-migration-v1-results.json`

**建議 Commit 此有限範圍；部署前仍須完成上述實際 history 與 native Supabase 驗證。本輪未暫存或提交，完成後等待批准。**
