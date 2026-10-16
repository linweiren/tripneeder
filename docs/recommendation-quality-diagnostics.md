# Recommendation Quality Diagnostics v1

This extends the existing candidate debug report. It does not change recommendation
decisions, prompts, meal rules, durations, validation, or public response fields.

## Activation and output

Use the existing `TRIP_CANDIDATE_DEBUG=true` in a non-production process. Production
always disables the session. Reports remain in `.tripneeder-candidate-debug.log`,
under `report.qualityDiagnostics`. No new endpoint, database, API call, or flag is added.

When disabled, no quality session, snapshots, theme scans, duration analysis, report
construction, or additional log writes occur. The existing null-session optional
calls guard the new work. Module loading and optional checks still have a small cost.

## Data structure

| Field | Meaning |
| --- | --- |
| `intent` | Positive culture/coffee/outdoor themes recognized by the existing ranking context; unknown grammar stays unknown. No history events or full custom text are copied. |
| `candidateThemes` | Counts and per-place evidence, score, pool order, opening-hours knowledge, available slots, and Prompt inclusion. |
| `eligiblePoolConfirmedCount` | Confirmed venue matches in the existing filtered pool. This is not proof that a complete legal itinerary can include them. |
| `promptConfirmedCount` / `promptConfirmedEntryCount` | Unique matching places / matching entries, including repeated Prompt groups. Missing observation is null, not zero. |
| `stages` | Ordered, detached plan snapshots: parsed skeleton, Grounding, validation, repair attempts, fallback, and their durations, estimated arrivals, meal evidence, and theme coverage. |
| `transitions` | Indices `beforeStage` / `afterStage` into `stages`, stop additions/removals/replacements, duration deltas, food classification changes, coverage minutes and reason. |
| `earliestVisible` | Earliest observed duration per plan/stop/place identity; does not reconstruct unsaved AI JSON. |
| `final` | Authoritative delivered Safe/Balanced/Explore snapshots. Attempts and locally selected alternatives can still be rejected later. |

Theme evidence has four states: `confirmed`, `not_matched`,
`insufficient_evidence`, `unknown`. Cultural confirmation reuses the existing
conservative cultural-purpose helper. Its failure alone never disproves culture:
城市光廊 and other ambiguous outdoor art venues remain insufficient evidence.
Confirmed venue coverage does not prove meaningful activity depth.

Duration references reuse the existing minimum/default/maximum helpers and are
explicitly soft, not new hard limits. Verified activity programs and duration
evidence are unavailable, so activity support is `unknown`; AI descriptions do
not count as supporting evidence. Coverage transitions distinguish minimum coverage,
target coverage, and provisional coverage recovery during capacity trimming.

Meal diagnostics reuse required meal windows, arrivals and the existing meal rule.
They retain Google types/subtype and the existing relative suitability hint
(`meal_likely`, `refreshment_likely`, `uncertain`). Restaurant types are not verified
menus: service suitability stays `uncertain`, or `unknown` without classification
evidence. No existing source supports `verified` full-meal service.

## Free replay evidence

The tracked tests use existing fixture factories and fixed AI responses. Every
external boundary is mocked; unexpected URLs fail rather than reaching a service.
Separate processes avoid cross-run Places/Routes caches. Logs are intercepted.

Three full-generation cases (normal stream, missing Balanced/refill, trailing stream
buffer) were compared with read-only `825d0825` source and diagnostics off/on.
Responses, every streamed event, and external call counts were deeply equal.

| Fixed case | Mock AI | Mock Places | Mock Routes |
| --- | ---: | ---: | ---: |
| Normal stream | 1 | 10 | 9 |
| Missing Balanced / refill | 2 | 10 | 8 |
| Trailing stream buffer | 1 | 10 | 9 |

The mock points ledger received one simulated consumption per case; real points
consumed were zero. The baseline helper mode reads Git history only when explicitly
run; regular regression tests compare off/on without requiring historical commits.

`npm.cmd run test` cannot run because this checkout has no `test` script. The existing
`npm.cmd run test:unit` passes all 1,231 tests, including 11 new diagnostics cases.
`npm.cmd run build` and `git diff --check` pass. New files also pass whitespace
checks. An additional targeted lint run reports only the pre-existing unused
`_rotationOffset` in `api/generate-trip.ts`; that unrelated code is unchanged.

The actual repair replay preserves 愛河灣150, reports the existing reference maximum
90, and extends coffee45 to66 by21 for minimum coverage. Other fixed observations
cover 中央公園120, request10:00/effective11:00, theme loss at different stages, only
Safe having confirmed cultural coverage, insufficient/closed candidates, food
purpose replacement, and formal-meal uncertainty.

For the observed coffee lunches (66 minutes at11:00, 60 minutes at12:04), the
current food/timing/duration rule passes. Lack of a verified formal lunch alone is
not a violation of that existing rule; whether the venue serves a useful lunch
remains unverified. These are constructed replays of visible observations, not
recovered original AI JSON or a replay of all 76 original candidates.

## Cost and remaining blind spots

The three fixed cases produced 81–85 snapshots, about335–376KB per complete debug
report, and about2.8–2.9ms to build the report in one local measurement. Total mocked
generation was about20–31ms slower with diagnostics; this includes test capture and
serialization and is not a production latency benchmark. Real disk-write latency
and long-term log retention are not measured. Production disables diagnostics.

Activity programs, cultural experience depth, verified menus, exact full-plan
candidate feasibility, and unsaved raw model JSON remain unknown. Grouped
meal/capacity/availability repair snapshots show net changes, not every speculative
internal meal-alignment substep. Provisional alternatives must be compared with
`final`, not assumed delivered. The existing log retention policy is unchanged.

No tokens, full prompts, complete history events, or generated activity descriptions
are added to the quality diagnostics.
