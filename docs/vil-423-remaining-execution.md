# VIL-423 — implementation and verification handoff

2026-10-12. Branch: `codex/vil-423-live-truth`.
Implementation and local regression gates are complete; fresh live validation below found an activity-recommendation blocker. Production cutover is not authorized or performed.

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
- PDF extraction and credentialed/redirected sources remain held rather than guessed.
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
- Runtime/comment cleanup does not include the pending AI-written reminder work, price-regex removal, US ZIP/privacy integration, activity location/cycle/fact fixes, or #858's separate week-plan/Sunday cron retirement.
- The [failure report was sent to Barton](https://hale-p8d7001.slack.com/archives/D0C4JU6NZT5/p1791903795334769). No rebase, PR, model switch, external prompt write, production deployment or carrier send was performed in this cleanup.
