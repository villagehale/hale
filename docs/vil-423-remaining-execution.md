# VIL-423 — implementation and verification handoff

2026-10-12. Branch: `codex/vil-423-live-truth`.
Code and local verification are complete; production cutover is not authorized or performed.

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
- Both migrations pass local preservation and reapplication checks. Historical migration files/hashes were not rewritten.
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

## Remaining limits

- No remote database migration, merge, deployment, production SMS, model switch or new dependency was performed.
- New live activity extraction was not re-evaluated against paid live model calls in this retirement pass; prior five-source/Coach results are documented separately and are not claimed as a new run.
- PDF extraction and credentialed/redirected sources remain held rather than guessed.
- Live recommendations add network/model latency. Reads are bounded to three source pages per Finder attempt; the existing retry/turn caps and proactive consent/time/frequency gates remain.
- Venue review ranking uses trusted identities only (including an unambiguous exact public venue URL); unknown identities do not inherit another venue's review.
- User's local `next.config.ts` / dev-command changes and landing-design documents are not part of this commit.
