# VIL-423 — implementation and verification handoff

2026-10-12. Branch: `codex/vil-423-live-truth`.
Implementation and local regression gates are complete; fresh live validation below found an activity-recommendation blocker. Production cutover is not authorized or performed.

## Same-name city live checks — 2026-10-14–15 (local)

Real production Finder + real model/search + fresh HTTP, with English preschool library-storytime queries for October 2026. Queries retain city, province and Canada. No model/page replay supplied the Finder's answers, no remote DB was changed and no SMS was sent. Six distinct cities were attempted, plus a generic London query without a named operator.

| Intended city | Common collision | Observed result | Finder elapsed |
| --- | --- | --- | --- |
| Burlington, ON, Canada | Burlington, WA / VT, US | 2 picks from `www.bpl.on.ca/programs`; published address says Burlington, Ontario Canada, L7R 1J4. No confirmed schedule returned. | 131.1s |
| London, ON, Canada | London, UK / US | 3 picks from `www.lpl.ca`; published address: 251 Dundas St., London, ON N6A 6H9. Geography correct; detail failures below. | 71.7s |
| Cambridge, ON, Canada | Cambridge, UK / MA, US | No completed response after approximately four minutes for this case; the batch was manually stopped. This is incomplete, not a geography pass. | >240s, interrupted |
| Windsor, ON, Canada | Windsor, UK / US and Windsor Park, Austin | `found: false, reason: location_unverified`. Austin Public Library and Mercer County's West Windsor page entered the source reads, but neither was returned as a recommendation. The fetched Canadian municipal page's bounded text did not establish a usable library address. Safe hold, but retrieval failed. | 137.3s |
| Kingston, ON, Canada | Kingston, Jamaica / UK / US | 3 picks from `www.kfpl.ca` / `calendar.kfpl.ca`; source text establishes Kingston, Ontario. Example: Rhythm & Rhyme. | 64.8s |
| Victoria, BC, Canada | Victoria, Australia / US and other Canadian Victorias | 3 picks from `gvpl.libnet.info`; published address: 735 Broughton Street, Victoria, BC V8W 1E1. This delegated calendar is linked by the official GVPL event site. | 91.1s |
| London, ON — generic query | Same collisions, no operator name supplied | `Local library storytime for preschoolers` returned 3 picks from `www.lpl.ca`, with the same Ontario address. Price stayed null; the Oct 21 time mismatch remained. | 87.9s |

**Geography verdict:** four distinct cities returned correct-region sources; Windsor was held and Cambridge did not complete. Across the five completed responses containing picks, all 14 picks cite the intended Canadian library operator and fetched city/province evidence. No wrong-country pick was returned in this small sample. This does **not** mean search itself stopped finding foreign pages: Windsor demonstrates the opposite. These are Finder durations, not end-to-end SMS first-reply p50/p95; isolated later cases ran concurrently.

### Detail failures exposed, not fixed in this test-only follow-up

- Named London query returned `price: "Drop in - free"` / `"Register - free"`; neither fetched source text contained a free claim. `Drop in` is not evidence of a zero price.
- London Bostwick answer said `Fridays 10:30-11:30am, e.g. Oct 16 and Oct 21`. The filtered source lists Oct 21 at **09:30–10:30**, while Oct 16 is **10:30–11:30**; the named query also cited the unfiltered page where that Bostwick event was absent. The generic query corrected the source URL and price, but still merged those different times.
- Kingston's `calendar.kfpl.ca/event/14414972` is a **Jan 17, 2026 Family Storytime** page; returned October Rhythm, Rhyme & Play / PA Day picks were taken from its upcoming-events sidebar. Victoria's `gvpl.libnet.info/event/4418218` is an **Oct 7 Kids Drop-In, ages 6–9** page, while the returned preschool storytime picks came from its sidebar. Correct operator/region does not prove event-specific age/date/link grounding.
- Latency remains a blocker: completed requests took 64.8–137.3s, and Cambridge did not complete in approximately four minutes.

### Verification and reproducibility notes

- The paid automated runs are **not all green**: Kingston and generic London passed; Windsor correctly fails the positive-retrieval expectation. The original sequential batch was interrupted during the stalled Cambridge case.
- Two checker mistakes were corrected, without altering production logic: Burlington's full `Ontario Canada` address was initially rejected by an `ON`-only assertion; Victoria's legitimate delegated `gvpl.libnet.info` hostname was missing from the expected test hosts. Official `gvpl.ca/programs-events` links to `events.gvpl.ca`, which links to `gvpl.libnet.info` events. Corrected independent source assertions were rerun against the five captured real responses (**14/14 source checks**), with **no new model calls**. That is a source-check replay, not five new live passes.
- `location-live.test.ts` now contains seven opt-in cases. The expected library hosts are test ground truth, not a production allowlist. Location unit tests pass **10/10**, Web typecheck passes, and the changed test passes Biome. No production code was changed for this expanded test pass.
- Geography-only push checkpoint (Oct 15): the exact staged source tree was checked out into an isolated temporary directory, without the uncommitted prompt experiments. **76 files / 992 tests passed, 7 opt-in live cases skipped**; Web typecheck and all **56 skill hashes** passed. No fresh paid calls were made for this push gate.
- Raw captures: [initial Burlington/London/interrupted Cambridge batch](../.local/vil423-pre-post/location-collisions-2026-10-14.log), [Windsor](../.local/vil423-pre-post/location-windsor-2026-10-15.log), [Kingston](../.local/vil423-pre-post/location-kingston-2026-10-15.log), [Victoria](../.local/vil423-pre-post/location-victoria-2026-10-15.log), [generic London](../.local/vil423-pre-post/location-london-generic-2026-10-15.log). Captures are local/ignored, not pushed.

Run one case per process when investigating a stall (paid; substitute a city or `Local library`):

```sh
VIL423_LIVE_LOCATION_EVAL=true node --env-file=launch.env .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web exec vitest run lib/channel/activity/location-live.test.ts -t Victoria
```

## Burlington geography follow-up — 2026-10-14 (local)

- Known Ontario municipalities now search with `city, Ontario, Canada`. The family discovery fallback retains its stored province and country; anonymous previews keep the resolved municipality context. Coach, intake, weekday and follow-up callers share the qualified query without sending postal codes, addresses or household names.
- Country/province hints in source URLs and titles prioritize the existing three page reads. These hints never establish eligibility: fetched page text must contain matching geographic evidence before it reaches the composer, and rejected sources cannot be cited in returned picks. All readable sources failing this check return `location_unverified`, rather than a claim that nothing is running.
- The recorded Burlington WA address is rejected; correct Ontario sources pass. A matching province plus a complete Canadian postal address also admits nearby towns (including Georgetown within Halton Hills). This checks region/country, not driving distance or which event owns a shared page's footer. No Burlington-specific allowlist, new API, model change, database migration or search-budget change was added.
- Latest related regression: **76 files / 992 tests passed**, with the one paid live geography test skipped by default. That opt-in test separately passed using the actual production Finder, real model and fresh official HTTP. Web typecheck and changed-code checks pass; pre-existing formatting in `areas.ts` / `deidentify.test.ts` is preserved and their lint passes.

### Real-source attempts during this fix

| Attempt | Observed outcome |
| --- | --- |
| Qualified query, before source ordering | Correct Canadian source returned in 51.1s; the test failed because its address assertion did not accept the official `ON, L7R…` comma. The assertion now accepts that published format. |
| Same path before source ordering | Safe empty result (`no_picks`) in 64.9s. Two foreign sources occupied the three-read budget alongside one Canadian page. This prompted the source-ordering regression and fix. |
| Qualified query + regional source ordering | Geography test passed in **84.7s**. All three returned picks cited `attend.bpl.on.ca`, with fresh page addresses in Burlington, ON. This is one geography sample, not a p50/p95 or full recommendation-quality pass. |

Final fetched sources: `https://bpl.on.ca/`, `https://attend.bpl.on.ca/event/993654`, `https://attend.bpl.on.ca/event/15492269`.

Reproduce (paid; no remote DB write or SMS):

```sh
VIL423_LIVE_LOCATION_EVAL=true node --env-file=launch.env .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web exec vitest run lib/channel/activity/location-live.test.ts
```

**Still open:** extraction can mix an old event's main content with current sidebar events. The first real source still showed a June 2025 event while the answer used October 2026 sidebar schedules. Per-event date/branch attribution, age fit, unsupported-price checks and first-reply latency remain separate Finder gates. The legacy cached Finder quality corpus was not re-recorded in this geography fix. This geography follow-up is a separate checkpoint; prompt experiments are out of scope. No rebase, deployment or production cutover.

## Review checkpoint — 2026-10-14

- Latest minute-reminder closure: resident and non-resident Burlington watches both pass real HTTP/model → fresh send-time read → correct `go` reminder → SQL dedupe checks (**2/2**, fixture clock/carrier). The current page still publishes historical Fall 2026 dates; the test simulates those dates rather than moving them forward. Added opt-in tests to `live-flow.pglite.test.ts`; normal related regression **793 passed, 2 paid live cases skipped**, with those cases separately run green. The four registration deliverables are locally verified; production release/cutover and the wider Finder work remain separate. See [full reminder text and reproducible command](vil-423-registration-tool-validation.md). Older minute-test “pending” notes below describe prior checkpoints.
- Latest formatting follow-up: exact official URL and identical standalone caveat deduplication is implemented in code. Different wording is deliberately not merged. Related regression **793 passed**; **5/5** previously recorded real answers replayed through the formatter with source links and caveats intact, no new HTTP/model calls. No fixed-length clipping was restored. Positive minute-reminder verification remains pending; see [current report](vil-423-registration-tool-validation.md).
- Latest eligibility follow-up follows each date's explicit official-page label, without inferring a resident tier from a later non-resident opening. Corrected the unsupported Toronto fixture expectation; new extraction **12/12**, replay **12/12 with 0 API calls**, final real HTML/PDF conversations **5/5**, related regression **783 passed**. King exposes both its unlabelled Dec 7 date and explicitly non-resident aquatics Dec 11 date. The earlier **10/12** checkpoint below is historical, not the current result. Positive real-source minute-reminder delivery remains pending. See [latest replies and evidence](vil-423-registration-tool-validation.md).
- Includes the user-requested scope rollback, Coach's on-demand live-page tool, agent truncation handling, and separate verified-date / unknown-eligibility handling for answers and reminders. See [registration validation](vil-423-registration-tool-validation.md).
- Burlington ON geography has the local follow-up above; future-event filtering, unsupported-price fixes and first-reply p50/p95 remain pending. Rolling back the earlier additions did not fix those source failures.
- PDF text extraction is implemented locally using `unpdf`, with no new external API. Text-layer PDFs use the shared live reader and original date/evidence gates; scanned/unreadable/over-budget PDFs stay held with a source link. King non-resident cross-year answers now pass **3 fresh repetitions** after evidence-prompt and narrow eligibility/DTO fixes; Markham/Uxbridge controls pass. Expanded extraction evaluation is **10/12**, with Toronto ARC and King's other default date still differing on resident/unclassified classification. The original King date/year corroboration failure is no longer the outstanding item. See [full replies and remaining classification cases](vil-423-pdf-extra-questions.md).
- PDF eligibility follow-up: unlabelled openings now remain `unclassified_open` for every AI source, rather than defaulting to public/family applicability. The same eight English questions plus four source controls and two cron scenarios pass after the fix; Uxbridge gets a date + caveat + link, not an opening-time reminder until eligibility is verified. The later registration-only strict Schema fix resolves the nested-output failure: independent extraction **11/11** fresh and replayed, production P02/R09/no-year probes **3/3**, related Web **1,909 passed, 1 skipped**. Other tools keep their existing mode. See [before/after replies](vil-423-pdf-extra-questions.md).
- Coach SMS no longer has a fixed character, segment or sentence limit. The formatter preserves the full answer plus eligibility caveats/source URLs; the truncation-triggered compact registration fallback is removed. The skill and Coach eval use the same policy. Other independent message composers retain their existing rules.
- No rebase onto #861 (still a draft), production migration, deployment or real carrier send. Raw validation logs referenced by the reports remain local under `.local/`, not in Git.
- Push gate: related Web suites **2,353 passed, 1 opt-in live test skipped**; Agent **125 passed**; Web typecheck, **56** skill hashes, eval-script syntax and staged diff checks pass. A travel-brief test still expected the deferred `as_of`/age guard; its assertions were restored to the rolled-back interface and recorded renderer output before rerunning green.

## Pre / post

| Area | Before | After |
| --- | --- | --- |
| Registration Q&A | Global catalog dates and seeded city facts | Fresh reads of the family's known watch sources on registration-date turns; other chat does not scrape |
| Registration reminders | Catalog-backed associations and legacy no-live send paths | Watch-owned URL/state, scheduled source checks and fresh send-time validation; no verified date means a hold with the source link |
| First reply / rec-morning | Hardcoded GTA/provider facts and stored civic candidates | Existing live Finder and shared registration reader; unknown location asks for a city or URL |
| Activity recommendations | Weekly populated candidate pool and stored rank | Per-operation live web research plus fresh bounded page fetches; no history fallback or background catalog fill |
| Saves / shares / reviews | Foreign keys and provenance pointing at the candidate pool | Family-owned offer/history receipts; existing saved/shared/acted-on IDs and review relationships preserved; historic details are explicitly historic |

## Database changes

- `0162_drop_registration_catalog.sql`: copy only watch-owned source metadata into `registration_sequences.source_context`, retain historical window IDs for send dedupe, remove the catalog FK, and drop `registration_windows`.
- `0163_activity_history_only.sql`: preserve referenced/shared/endorsed/saved/reviewed receipts in `family_activity_history`, switch engagement FKs, then drop `village_candidates` and `village_feed_rank`.
- `0164_retire_civic_catalog.sql`: detach obsolete FKs and drop civic sessions/venues without deleting introduction proposals, watched sources, review IDs or activity receipts.
- Retirement migrations pass local preservation and reapplication checks. Historical migration files/hashes were not rewritten.
- The reapplication test checks earlier additive migrations before retirement, then verifies the retirement migrations twice. Replaying obsolete catalog ALTERs after the tables are gone is not a supported rollout order.

## Verification

- Full Web suite: **10,810 passed, 1 opt-in live-intake test skipped**.
- Worker suite: **310 passed, 1 remote-DB integration test skipped**.
- DB migration/schema suite: **103 passed, 2 DB-dependent tests skipped**.
- Web/worker typechecks, Web production build, Biome (warnings only), and `git diff --check` passed.
- Subsequent focused chat tests cover no page reads for an unrelated swim cancellation, source-link preservation, and registration-date follow-ups.
- Reminder E2E: a stored 20th date and a fresh 18th source are exercised **before the old reminder is due**; change notice, heads-up and evening reminder use the 18th and source URL, never the 20th.
- Uncorroborated, eligibility-unverified and unpublished/unreadable reads retain the source link without claiming the cached date. Date-only sources do not invent midnight/noon or send a minute-level go reminder.
- Migration tests preserve approval/action records, parent-reported waitlist clocks, old send dedupe, saves, shares, endorsements and review provenance.
- Live recommendation tests prove each operation uses new findings, failed reads do not fall back to saved receipts, and unreadable pages / uncited URLs cannot supply current facts.
- Fixtures and recorded public facts are used for reminder/activity delivery paths. No real carrier sends were made.

## Release gate — do not deploy as an ordinary additive migration

These migrations are destructive. The previous app still uses the retired tables while a new build is being prepared. Applying the DROP migrations before switching away from that app can break production.

`apply-migrations.mjs` therefore refuses pending catalog retirement against an existing legacy database unless an operator explicitly supplies `HALE_CATALOG_RETIREMENT_MODE=maintenance`. The variable was **not set** here. Preview builds still skip migrations.

A production owner must review a database backup/restore plan, stop or drain old readers/writers and cron invocations, arrange a coordinated maintenance cutover (or redesign the rollout into expand/contract releases), run the migrations and activate the compatible code before reopening service. Do not replay old catalog migrations after retirement. An ordinary old-code rollback is not safe after DROP; it needs compatible code or database restoration.

## Fresh validation — 2026-10-13

- Barton received the [implementation/validation-start update](https://hale-p8d7001.slack.com/archives/D0C4JU6NZT5/p1791863978143509). This is not deployment approval.
- Focused migration/reminder/save/share regression: **56 passed**. Additional combined old-data → both DROP migrations → new watch/saved/shared readers and new offer writer: **1 passed**. Cutover-guard tests: **6 passed**. The isolated database is in-process PGlite/Postgres, not a production clone or the networked migration runner.
- Five real URLs selected from the configured remote DB were re-read under an asserted read-only transaction, with the connection closed before five actual model extractions: **5 fetched, 2 verified, 3 held**. Burlington and Richmond Hill verified; King remains uncorroborated, Markham eligibility-unverified, Uxbridge PDF unsupported. Richmond Hill remains date-only (Nov 24 / Dec 1), not midnight. [Raw source-reader log](../.local/vil423-pre-post/validation-2026-10-13-registration-live.log).
- Actual `createActivityFinder` + current `activityClient` were exercised without model/page mocks or cache replay. Two correctly typed public queries used `preschool` and `child`; the initial exploratory pair used invalid stage labels and is excluded from the final verdict. All four attempts performed real search/extraction calls (eight calls); the five registration calls bring this pass to thirteen model calls. No model routing was changed.
- **UK Greenwich sample passed the bounded source review**: three Charlton Lido lesson picks cite the freshly fetched Better page; the age bands, weekly times and £31/£49 monthly prices appear on that page. No dated registration opening was established. Correctly typed run: **39.1 seconds**.
- **Canadian Burlington sample failed**: the current query supplies only `town: Burlington`, matching the runtime's town label. Its result cites a Washington, US library page whose address explicitly says `Burlington, WA ... United States`; it offers a 2024 event whose page explicitly says it has already happened for an October 2026 request; and emits `price: Free` without supporting text on the cited page. Correctly typed run: **60.1 seconds**. Fresh HTTP bytes and an observed source URL alone do not establish correct geography, current applicability or each claimed fact.
- [Actual Finder output and source text](../.local/vil423-pre-post/validation-2026-10-13-live-finder-corrected.log), [independent failure evidence](../.local/vil423-pre-post/validation-2026-10-13-live-finder-grade.log), [combined cutover integration](../.local/vil423-pre-post/validation-2026-10-13-cutover.log). The diagnostic shape checks passed; the independent source review deliberately fails the Canadian sample. Do not report the pair as an all-green live eval.
- **Pending before release:** resolve the activity geography/current-cycle/unsupported-fact failures and re-evaluate that production path, then review the coordinated DB/code cutover. Validation identified these failures; product fixes, production migrations/deployments and real carrier delivery were not performed in this pass. Two samples are not a reliability benchmark, and these results do not establish when the recommendation defects were introduced.

## Remaining limits

- No remote database migration, merge, deployment, production SMS, model switch or new dependency was performed.
- Fresh paid source/Finder checks are recorded above, including an activity blocker. Prior Coach quality evals were not re-run in this validation pass; no complete production webhook → carrier delivery was tested.
- Scanned/unreadable/over-budget PDFs and credentialed/redirected sources remain held rather than guessed; text-layer PDF support was added on 2026-10-14.
- Live recommendations add network/model latency. Reads are bounded to three source pages per Finder attempt; the existing retry/turn caps and proactive consent/time/frequency gates remain.
- Venue review ranking uses trusted identities only (including an unambiguous exact public venue URL); unknown identities do not inherit another venue's review.
- User's local `next.config.ts` / dev-command changes and landing-design documents are not part of this commit.

## Step 1 follow-up — 2026-10-13

- Removed civic-sweep route/schedule, civic ingestion/projection modules, retired civic-hours eval/skill and its CI entry. The city resolver and public stated-age parser were moved intact to their surviving intake/social consumers, with their original tests.
- Added migration 0164 and extended the existing fail-closed maintenance guard to civic catalogs. No migration was executed remotely; numbering must be reconciled when rebasing after #861.
- Preserved introduction proposals, source watches, reviews and historical opaque venue/session IDs. **Behavior boundary:** default introductions still pair consented families, but no longer attach an optional cached civic activity; there is no new live-search anchor in this cleanup. Existing proposals do not repeat a retired session's title/date.
- Fresh recommendations can reuse only an unambiguous historical venue identity from that family's receipts, selecting IDs/URLs only, not saved schedule facts. Repeated receipts for the same ID are deduplicated; conflicting identities and other-family receipts cannot supply identity.
- Deleted unused rank/curate skills; updated Coach instructions, tool description mirror, registration fixture notes and judge rubric to describe fresh source readings, not a verified stored catalog. The live `registrationWindows` DTO key is retained for compatibility with #861, not as a database table. Historical audit/provenance keys and migration preservation tests intentionally retain retired table names.
- Skill lock/JS syntax and Agent tests pass. Coach prompt/rubric changes invalidate old eval caches; cached-only stops on a cache miss, with no paid calls or fabricated cache writes. Fresh language quality remains pending the agreed cost approval/re-record, not claimed verified by regression tests.
- Final step-1 gates: Web **10,705 passed, 1 opt-in live test skipped**; Worker **310 passed, 1 remote integration skipped**; DB **103 passed, 2 DB-dependent tests skipped**; Agent **121 passed**; **56** skill locks match. Web/worker typechecks, Web build, Biome (warnings only), and diff checks pass. The new preservation test was red before migration 0164 existed and green after implementation; journey/identity regressions were repaired and the full Web suite re-run green. No new dependency was added.
- At that checkpoint, AI-written reminder work, price-regex removal, US ZIP/privacy integration and activity quality changes were not implemented. The later requirements are now excluded as recorded below; #858's week-plan/Sunday retirement remains separate.
- The [failure report was sent to Barton](https://hale-p8d7001.slack.com/archives/D0C4JU6NZT5/p1791903795334769). No rebase, PR, model switch, external prompt write, production deployment or carrier send was performed in this cleanup.

## Scope rollback — 2026-10-13, requested by the user

The user excluded the later fast-first/AI-copy/US-ZIP-privacy/fresh-evaluation requirements. They are no longer the active execution plan.

- Reverted the uncommitted fast-first changes and the related portions of `e22c805f`: one-search/two-page limits, pre-compose date/location filtering, added source-field guards, exact/coarse age eligibility gates, shortened recommendation windows, deep-on-intent behavior changes, travel overrides, added geographic qualification and their extra fixtures/prompt requirements.
- AI reminder/trail copy replacement, US ZIP/#861 privacy integration and a new search API had not been implemented; there was nothing to undo for those. No paid evaluations or model-recording rewrites were performed for the addendum.
- Retained original VIL-423 behavior: live registration answers and reminder verification; scheduled source checks and change notices; watch/history preservation; registration/rec-morning/village/civic catalog retirement; per-operation live recommendation reads; family-owned offer deduplication and successful-send receipts. Existing source-quote/URL safety, household-name redaction, consent and teen protections remain.
- Historical source-test failures above remain evidence, not a claim that rollback fixes them. Removing the extra recommendation guards restores the earlier behavior; it does not prove recommendation quality or authorize deployment.
- Uncommitted changes are recoverable from `.local/vil423-pre-post/addendum-revert-2026-10-13.patch`; the two new fast-source files were archived under `addendum-revert-files-2026-10-13/`. Committed changes remain recoverable in Git at `e22c805f`; Git history was not rewritten. User-owned Next config/package edits and landing documents are unchanged.
- Rollback verification: focused local regression **1,030 passed / 43 files**; full Web **10,713 passed, 1 opt-in live test skipped, no failures**; Agent **121 passed**; Web/worker typechecks, **56** skill locks and diff checks pass. The nine content-addressed recording failures disappear after restoring the earlier request/prompt shapes; no recordings were fabricated or paid calls made. Logs: `.local/vil423-pre-post/addendum-revert-web-2026-10-13.log` and `addendum-revert-focused-2026-10-13.log`.
- At the time of this rollback validation it was local/uncommitted. The 2026-10-14 review checkpoint now includes that rollback; no remote migration, carrier send, model change or deployment occurred. Historical live-source quality concerns above remain unresolved.
