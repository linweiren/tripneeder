# Weather integration repair and upgrade plan

Date: 2026-11-02 (Asia/Taipei). Base: `origin/weather` at `a8ce99cf277c34601a340cd7356e3e38df61eb51`.
The owner explicitly confirmed that **011–018 have never been deployed**. That confirmation is the reason those files may be corrected in this branch. No production database was inspected or changed.

## Data policy

Upgrades do not delete or merge shares, likes, comments, views or reports. They do not rewrite legacy `plan` or `input` JSON, including malformed values and original transport segments. The old unique content index is replaced with a nonunique lookup index before hardening. Existing duplicate IDs remain independent.

Raw rows are inaccessible to `anon` and `authenticated` table queries. The security-definer feed exposes an explicit public allowlist and `input = null`; incomplete or invalid legacy plans are hidden, with their stored data and interactions retained. Future shares are validated and stored in public form. Any cleanup, historical reconstruction, retention or manual correction of malformed rows requires a separate decision. No recovery of already-deleted data is attempted.

Sharing the same canonical plan uses a per-owner transaction advisory lock and returns the earliest existing share ID, including when the stored legacy plan still contains private fields. It changes that share's tags only. Two real concurrent connections are tested.

The existing owner-requested unshare and comment deletion RPCs retain their intended behavior. This is different from an upgrade deleting rows automatically.

## Upgrade routes

| Confirmed state | Route |
| --- | --- |
| This project: none of 011–018 deployed | Apply corrected 011–019 in order, after existing 001–010. 011 and 015 are unchanged but included in complete execution tests. |
| Historical `de069c6`, through 011–015 | Do not replay applied files. After verifying the exact history and reviewing a backup clone, apply only the remaining corrected files in order through 019. All seven historical prefixes through 017 are simulated in tests. |
| Historical 016–018 schema already installed | Review and apply append-only 019, transactionally. It recreates validators, sanitizers, sharing/feed/like RPCs and their ACLs without modifying application rows. The reports table is required as a schema guard. |
| Unknown history, manual SQL edits, partial failed upgrades, unexpected dependencies | Stop. Obtain schema/history evidence and review a clone. Do not guess the version, skip files, edit history or use `CASCADE`. |

For an already deployed environment, editing an old file does not upgrade that database. Keep its deployment records and use the appropriate forward route. 019 is included for this distinction, not as permission to change an external database. Tests simulate historical versions using immutable SQL fixtures; they are not evidence of actual deployment.

All steps must run in a transaction. Return-type transitions explicitly drop and recreate the exact RPC signatures, restoring execute grants in the same transaction. No `DROP ... CASCADE` is used. An unexpected dependent view aborts the migration; a regression verifies that DDL, ACLs and application rows roll back. On failure stop, retain the error and investigate. After a successful upgrade, use an approved backup recovery plan if recovery is necessary; do not replay old destructive migrations as a rollback.

019 cannot recover transport, shares or interactions deleted by previously executed versions. Backups and an explicit restoration decision would be necessary. It also leaves historical reward flags and ledger entries intact. New likes never issue rewards. Existing initial points, normal debit, atomic initial grants and dev's points ACL migrations retain their behavior in local tests.

## Public contract

`scheduleStartTime` accepts a valid `HH:mm` string, omission or null. Other JSON types are rejected before detail rendering; absent/null times normalize to omission in the frontend. Missing `googleTypes` normalizes to an empty array. Optional enum nulls normalize consistently. Main and rain transport endpoints are remapped to sanitized stop IDs while preserving validated durations and mode. Duplicate stop IDs are rejected to avoid ambiguous remapping. Frontend signatures are tested against actual SQL output, including omitted fields, time, transit and padded names.

Shared detail cache entries must pass the same validator; malformed entries produce no selected plan. Comment response fields are also validated before React receives them. Historical `share_reward` transactions have a read-only display label; this does not re-enable rewards or change balances.

## Reproducing verification

`npm ci`, then `npm run test:unit`, `npm run lint`, and `npm run build` (includes TypeScript). Unit tests load an offline network guard that removes credential environment variables and rejects nonmocked network traffic. They execute full migration files on PGlite, rather than extracting individual functions.

For native PostgreSQL, start a **dedicated disposable local cluster** with a superuser named `weather_test_admin`. Set `WEATHER_TEST_PG_PORT` if the port is not 56589, and `WEATHER_TEST_PG_PASSWORD` if required, then run `npm run test:sql:native`. The runner fixes host to `127.0.0.1`, disables SSL, ignores `.env`, `DATABASE_URL` and Supabase settings, and creates/drops only its own `weather_integration_test_<pid>_<counter>` databases. It creates test roles inside that cluster. Never point it at an existing application database or a tunnel to a remote cluster. CI provides a disposable PostgreSQL 17 service.

The native matrix covers clean 001–019; corrected prefixes 011–018; historical `de069c6` prefixes 011–017; direct historical 016/017 → 019; historical `a8ce99c` through 018; malformed JSON and cross-language contract equality; dev points migrations before/after weather; transactional rollback with unexpected dependencies; and two-connection concurrency. Each prefix test seeds 16 valid/malformed legacy plans with interactions and compares all pre-existing application rows after every remaining migration. Historical reward ledger entries are also preserved. The contract matrix has 89 JSON variants.

## Dev integration and remaining release gates

The subsequent `codex/integrate-weather-community` branch merges the repaired weather branch on top of committed dev `6a4798f`. Its conflict resolutions retain dev's generationId, recovery and atomic paid delivery; authenticated geocoding now accepts coordinates and addresses. Complete local SQL ordering, API compatibility and browser stories are documented in [the integration report](weather-dev-integration-report.zh-TW.md). The original worktree's uncommitted display changes are protected and are not included in this integration.

The historical CWA credential revocation status remains unverified. No key was displayed, tested or changed. Live OAuth, CWA and Supabase integration were not tested. No paid API, production database, push or deployment was used.
