# Stop Duration Quality v1

Implemented against `9840b315`, 2026-10-17. No live generation or paid API calls were used for verification.

## Integration and scope

`repairAndValidatePlanForDelivery` first runs the unchanged repair, validation,
optional diversity comparison and fallback pipeline. After its final schedule
start has been selected, it may construct exactly one duration comparison.
There is no repair or fallback after this comparison. Failed comparisons return
the original result object; successful comparisons change stop durations only.

The four direct capacity-shrink passes in `repairPlanForDelivery` record actual
reductions in a private WeakMap, keyed by stop ID, place ID and activity type.
Existing original-activity preservation and diversity comparisons are unchanged.
Nested helpers without this provenance cannot authorize restoration. Provenance
is carried across existing plan copies and includes the existing per-plan route
context; it is never serialized into responses or new public fields.

The v1 trigger is deliberately narrow:

- The request explicitly includes culture, without an explicit outdoor theme.
- A selected, confirmed cultural venue lost time in a recorded capacity shrink,
  and still has the same cultural activity purpose.
- A selected non-food natural feature has an existing `open_space` role and
  purpose, and exceeds its existing soft duration reference.
- Candidate IDs and names match the selected stops. All qualified cultural
  deficits can be restored using only the natural-feature excess. Partial
  prioritization of otherwise equivalent cultural deficits is not attempted.

Restore at most the recorded loss, the pre-shrink duration and the existing
receiver reference. Transfer only donor minutes above its soft reference, in
existing stop order. The reference is not a universal hard cap: the example bay
remains at 93 minutes against its 90-minute reference.

Existing candidate data has no verified activity program or program-duration
evidence. Its support for a long stay is therefore **unknown**, not false. V1
does not use AI descriptions as evidence or claim that natural venues have no
value. Parks, ambiguous venues such as 城市光廊, food stops, uncompressed slow
itineraries and explicit outdoor requests are left unchanged. This favors a
known compressed requested activity in a constrained comparison; it does not
measure experiential quality or infer that every long stay is unreasonable.

## Legality and route evidence

The comparison preserves identity, order, purpose, schedule start, all food
durations and the exact transport-segment array. A local verifier recomputes
each arrival and departure at that fixed start and checks:

- Original requested time window, existing minimum coverage and total capacity;
  actual total duration and declared total remain identical.
- Existing minimum stay durations, and known first-stop distance at most 2 km.
- Known cached Places Details hours for every stop, using the existing visit
  check including the 30-minute closing buffer/leave-by constraint.
- Existing required meal coverage, plus retention of each original food stop's
  previously satisfied meal windows. A cafe cannot silently take over another
  stop's meal purpose. No meal classification or requirement was changed.

Opening evidence is read only from the cache filled by the original pipeline.
Missing evidence rejects the comparison without fetching. Final hard validation
rules are unchanged; this additional check only accepts or rejects the optional
comparison.

Route reuse requires successful Routes responses from the existing context for
every adjacent edge, matching coordinates, mode, stop IDs and exact minutes.
A private WeakSet distinguishes real resolver responses from seeded hints.
The check never fills a missing memo entry or changes request strategy.

The current car/scooter requests omit `departureTime` and `routingPreference`.
The Routes default is `TRAFFIC_UNAWARE`, based on time-independent averages:
[official RoutingPreference reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/RoutingPreference).
Changed departures can therefore be checked within that existing static routing
model. This does not establish live traffic conditions or time-dependent road
restrictions. Transit is time-dependent and always rejects redistribution.
Missing, failed, estimated or mismatching route evidence also rejects it.
Regression tests lock the request assumptions; a future traffic-aware strategy
must revisit this eligibility check.

## Free replay results

These are controlled copies of the investigation scenarios, reusing the tracked
`supplement-quality.mjs` clock/Places/Routes mock. They are not reconstructed raw
AI output. The baseline JSON contains results from mocked execution of
`9840b315:api/generate-trip.ts`; permanent tests use its compact hashes rather
than requiring Git history or local investigation files.

Primary example: 地方文物館 / 咖啡廳 / 愛河灣 / 地方藝術館. Each leg is 4 minutes.

| Stop | Before capacity repair | Existing final | New final | Existing soft maximum |
| --- | ---: | ---: | ---: | ---: |
| 地方文物館 | 90 | 75 | 90 | 90 |
| 咖啡廳 | 45 | 45 | 45 | 90 |
| 愛河灣 | 150 | 123 | 93 | 90 |
| 地方藝術館 | 60 | 45 | 60 | 150 |

Known cultural loss changes from 30 to 0 minutes. Bay excess changes from 33 to
3 minutes. Total retained-stay loss from the supplied skeleton remains 57
minutes: the change reallocates this loss rather than pretending to eliminate
it. Total duration stays 300 minutes (100% of the 10:00–15:00 window; minimum
225), with 12 minutes of unchanged traffic. Activity-program support remains
unknown. Restoration of the explicit cultural activities is the benefit being
tested, not closeness to a reference alone.

| Stop | Existing arrival–departure | New arrival–departure |
| --- | --- | --- |
| 地方文物館 | 10:00–11:15 | 10:00–11:30 |
| 咖啡廳 | 11:19–12:04 | 11:34–12:19 |
| 愛河灣 | 12:08–14:11 | 12:23–13:56 |
| 地方藝術館 | 14:15–15:00 | 14:00–15:00 |

| Scenario | Existing final → delivered minutes | Decision | Places / Routes / AI before = after |
| --- | --- | --- | --- |
| Pressure, scooter; all three styles | 75/45/123/45 → 90/45/93/60 | Accept; restore culture 30 | 4 / 3 / 0 |
| Pressure, car | 75/45/123/45 → 90/45/93/60 | Accept | 4 / 3 / 0 |
| Museum closes 11:50 | 75/45/123/45 → unchanged | Reject: 11:30 exceeds leave-by 11:20 | 4 / 3 / 0 |
| Existing diversity fallback selected | 75/45/123/45 → 90/45/93/60 | Accept after fallback | 4 / 5 / 0 |
| Fallback, museum closes 11:50 | 75/45/123/45 → unchanged | Reject after fallback | 4 / 5 / 0 |
| Legal optional river alternative | 90/45/90/60 → unchanged | No recorded deficit; retain alternative | 4 / 3 / 0 |
| Coffee coverage +21; two stops, 11:00 start | 66/150 → unchanged | No eligible restoration; preserve 225 vs illegal 204 | 2 / 1 / 0 |
| Dome +5 to align lunch at 11:00 | 55/60/70/45 → unchanged | Preserve required meal alignment | 4 / 7 / 0 |
| Original slow arrangement | 75/45/123/45 → unchanged | No capacity-loss provenance | 4 / 3 / 0 |
| Ambiguous receivers / ambiguous donor | 75/45/123/45 → unchanged | Positive eligibility evidence absent | 4 / 3 / 0 |
| Explicit outdoor request | 75/45/123/45 → unchanged | Preserve requested outdoor pacing | 4 / 3 / 0 |
| Late lunch; comparison moves cafe past 13:00 | 75/45/123/45 → unchanged | Reject meal conflict | 4 / 3 / 0 |
| Transit | 75/45/123/45 → unchanged | Reject insufficient timing evidence | 4 / 3 / 0 |

All 14 before/after replay rows have identical complete Routes request bodies,
external call counts and full non-duration result hashes. Original and delivered
plans pass the existing full delivery checks under the mocks. Other regressions
cover insufficient donor excess, conflicting cultural donor evidence, failed
routes, missing cached hours, seeded route hints and a second delivery pass (no
repeated redistribution). No scenario
adds a stop or lowers coverage. All three styles retain identity and the existing
safety gates; this is not proof of real-world experiential equivalence.

## Validation and remaining limits

- `npm.cmd run test`: unavailable; this repository has no `test` script.
- `npm.cmd run test:unit`: 1252/1252 passed, including 21 new tests.
- `npm.cmd run build`: passed; existing bundle-size advisory remains.
- `git diff --check`: passed.

The additional work is bounded local bookkeeping and one comparison, with no
new remote calls. Loss recording scans only selected stops; route evidence and
cached-hours checks run only for an eligible comparison. No unconditional new
log sink was added. Accepted/rejected snapshots use the existing optional
diagnostic session and contain reason labels, not prompts or history.

The narrow positive venue taxonomy intentionally misses some worthwhile
restorations. We cannot verify activity programs, full meal menus, real traffic,
or every user's preference for a long natural stop. Original AI-generated long
durations without capacity-compressed cultural activities remain unchanged.
These are explicit v1 limits, not reasons to relax safety checks or add paid
calls.
