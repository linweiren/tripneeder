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

## Meal Reliability v1 extension (2026-10-17)

This extends the same opt-in `qualityDiagnostics` snapshots and transitions. Only
the diagnostic module, regression fixtures/tests and this document change. Search,
ranking, prompts, grounding/repair/fallback decisions, meal requirements, final
validation, public responses and streaming events are unchanged. Production still
cannot enable the session, even with `TRIP_CANDIDATE_DEBUG=true`.

Previously, snapshots already contained per-stop meal hints, meal timing, requested
and effective windows, plus `formalMealServiceVerified: unknown`. The new data
connects those facts to each individual required meal occurrence and records hint
loss through the existing stage hooks. No new observer, route resolver or log sink
is introduced.

### Added internal fields

| Path | Meaning |
| --- | --- |
| `stops[].meal.foodPurposeHint` | Existing local food-purpose helper applied to venue evidence with generated descriptions excluded. This is still a hint. |
| `meals.requirement` | Existing rule's requirement status/reason: explicit `no_full_meals`, a feasible effective meal window, no required window, or invalid/unknown time. Free-text formal-meal intent remains unknown and is not newly parsed. |
| `meals.windows[]` | One row per effective required occurrence, with `windowKey` (`lunch:660`, next-day `lunch:2100`), start/end, 45-minute minimum, counted stops and evidence category. |
| `windows[].numericalLegality` | Whether existing food/start-time/minimum-stay rules satisfy this meal window. It is **not** a full opening/route/coverage validation result. |
| `windows[].countedStops[]` | IDs, name, arrival/duration, role, subtype, suitability and food-purpose hints for every stop counted by the existing meal rule. |
| `windows[].evidenceCategory` | `higher_meal_hint_unverified`, `refreshment_hint_only`, or `insufficient_evidence`. Mixed uncertain/refreshment evidence stays insufficient; a higher meal hint does not verify a menu. |
| `windows[].candidateComparison` | Observed pool scope, unused higher-hint candidates, same-slot opening checks and explicit unknown full replacement feasibility. |
| `transitions[].changes[]` | Adds before/after food purpose and `higherMealHintLost`; same-identity hint updates can produce `meal_evidence_changed`. |
| `transitions[].mealWindows[]` | Before/after counted identities, numerical status and evidence category, tied to existing phase, attempt and disposition. A discarded trial is not a final downgrade. |

Example: a 60-minute cafe starting at 12:04 can have
`numericalLegality: satisfied` and `evidenceCategory: refreshment_hint_only`
simultaneously. This diagnoses the current behavior without rejecting or replacing
the cafe. A restaurant-type stop can instead have
`higher_meal_hint_unverified`; its `menuServiceEvidence` is still `unknown`.
No new `verified` level is created.

`user_no_full_meals` is distinct from `no_required_window`. The former is an
explicit opt-out tag; the latter can simply mean that the trip has no feasible
45-minute meal window. `food_first` and custom text do not redefine the existing
requirement. Requested and effective windows remain separate, including delayed
starts, midnight crossings and repeated meal IDs on different days.

### Candidate evidence is not a safe replacement proposal

The comparison lists **unused, already-classified food candidates with
`meal_likely` evidence**, only when the counted meal does not already have that
hint. It neither ranks them nor changes selection. Scores and type evidence are
copied from the existing pool, without extra bonuses. Confirmed cultural venues
are not repurposed as meal candidates just because they have dining metadata.

For each counted meal slot, `sameSlotOpeningChecks` tests the candidate at that
slot's actual arrival and duration using the existing opening-hours check, including
its closing buffer. Results are `fits`, `does_not_fit`, or `unknown`. No minute-by-
minute availability search is performed. A candidate that fails that slot might
still fit another schedule; absence of a matching row is not proof that no better
meal can exist. An unobserved pool has a null count, not zero.

Even a `fits` result leaves `fullReplacementFeasibility: unknown`: these diagnostic
hooks do not receive a complete trusted replacement-route comparison or revalidate
the revised schedule, other meals, activity/coffee preservation and all safety
conditions. The code makes **no** speculative repair or API call to obtain that
proof. Candidate presence, types and hours cannot justify automatic replacement.

`higherMealHintLost` means a relative meal hint was lost, not that the final venue
cannot serve meals. Window-level loss is reported only if the window remains
required; a window removed by a changed effective start is marked `not_required`
instead. Existing stage indices and provisional/selected/rejected dispositions
must be read together with `final`. Raw AI JSON that was not observed remains
unavailable; grouped repair hooks still show net changes rather than every internal
speculative step.

When no food stop currently satisfies the window, there is no replacement slot to
check; `sameSlotOpeningCompatibleCount` is null rather than an assertion that no
candidate can open at a useful time.

### Free regression and cost evidence

The new fixture reuses tracked supplement, meal-suitability and food-purpose
factories. It reads no local investigation files. Cafe/ThisBALL timings and types
are controlled representations of observed scenarios, not real menus or recovered
model output. Network boundaries are mocked and unexpected URLs are rejected.

Direct replays cover cafe lunch, uncertain ThisBALL, Explore coffee lunch, an unused
higher-hint restaurant, closed/unknown candidate hours, safety meal-to-cafe,
optional meal-to-uncertain, preserved optional meal purpose, actual diversity
fallback, uncertain-only food, no_full_meals, and independent cultural/coffee/meal
activities. Additional tests cover lunch/dinner, cross-day occurrences, timing
boundaries, same-identity evidence changes, provisional attempts, unknown input,
detached snapshots and sensitive-data exclusions.

Four complete handler fixtures compare diagnostics off/on and production with the
flag forced on. Final responses, every streamed event, and all mock call counts
are deeply equal, including HTTPS endpoint counts for Supabase, Places and Routes
and fetch-based AI requests. Disabled and production modes produce zero snapshots/reports.

| Fixed complete generation | AI | Places | Routes | Debug report bytes (one run) |
| --- | ---: | ---: | ---: | ---: |
| Cafe lunch | 1 | 12 | 6 | 380,361 |
| Uncertain lunch | 1 | 10 | 9 | 444,101 |
| Independent cultural/meal/coffee activities | 2 | 10 | 9 | 547,338 |
| No full meals | 1 | 10 | 3 | 229,770 |

These are mock calls, including the unchanged fixed-response retry path, not paid
requests. Each case has one simulated points consumption and zero real cost.
There are 75–90 snapshot invocations per case. Observed report-build times were
about 1.5–3.8ms in one local run; generation overhead included test interception
and serialization and is not a production benchmark.

Additional work is confined to the debug-owned class: one existing-pool scan and
bounded local per-window/stop/candidate checks at the already-existing snapshots.
Lists are bounded by the existing candidate pool; records follow the existing
snapshot lifecycle. Off/production create no session or new snapshots and perform
none of the added candidate/hours analysis. The small module-import/optional-check
cost and the existing development log retention behavior remain.

The extension adds 23 regression tests. The full suite passes 1,275/1,275;
`npm.cmd run build`, targeted lint and whitespace checks pass. `npm.cmd run test`
still reports the missing `test` script; the suite runs with the existing
`npm.cmd run test:unit`. No package-script change was made.

Menus, service-specific hours, kitchen availability and full replacement
feasibility remain unknown. Next-stage selection protection should only use
existing trusted route comparisons and complete legality/purpose checks; it must
preserve the original when proof is missing. This extension provides evidence for
that work and does not implement it.
