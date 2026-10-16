# VIL-423 — Barton follow-up, October 16

Draft PR: [#872](https://github.com/villagehale/hale/pull/872). Not merge-ready.

## Changes and concrete examples

| Item | Before | This checkpoint |
| --- | --- | --- |
| RBG source retrieval | The discovered `early-years-play/` URL returns 301; the pinned reader refuses it before extraction. | A bounded redirect reader reaches the current official child/family page (HTTP 200, 13,078 characters of stripped text). Every hop still uses URL validation and public-DNS-pinned HTTPS; the final URL becomes the citation. |
| RBG geography | The earlier `not_grounded` hid the retrieval failure. | The newly readable page still lacks the address evidence required by the location gate. It remains **location unverified**, not a confirmed Burlington recommendation. Checked links and an explicit caveat survive to Coach; no dates are invented and the same deterministic location failure is not retried inside Finder. |
| US ZIP | A family with country `US`, ZIP `05401`, and no city could not supply a Finder location. | Existing checked-in postal geography resolves `Burlington, Vermont, United States`. Both `search_village`'s shared search and `find_activities` receive that location, never `05401` or `054`. Active US saved areas retain the country too. No new geography API or table. |
| Extraction overhead | All three successful fresh cases first exhausted their 1,024-token adaptive-thinking budget, then used the existing thinking-off retry. | The extraction call starts with that existing successful `between_tools` configuration. Model, extraction token ceiling and research configuration are unchanged. Fixture request tests prove the shape, **not a measured latency/quality improvement**. |
| Scheduled reminder wording | Cron assembled a fixed reminder/change-notice body. | Cron calls a structured AI writer with this send's live date, source, course verdict, consent and parent-reported setup/waitlist facts. Exact published precision is required; missing sources are appended. Invalid output/provider failure produces a visible failed leg and no send, not a template fallback. |
| Price classification | A regex classified two fee labels as resident/non-resident, dropping other price layouts. | Published label/amount pairs remain paired and in page order. Example: `Resident: $10.00; Non-Resident: $20.00; Senior: $5.00`; no selection of the household's rate. |

RBG's current source: [Child & Family Programs](https://www.rbg.ca/learning/individuals-and-families/child-and-family-programs/).
The program is present, but current October dates/prices and geographical acceptance have **not** been established by a new model run.

## Reminder example — fixture, not a real model quality result

The mechanics test supplies this fake model output through the **actual structured composer → cron → fake transport**:

> Freshly checked: 2026-09-15 at 06:30 America/Toronto. I'll send your evening-before plan.

Code retains that wording and appends the live-read source URL. It does not substitute the old `The registration page says …` template.

Additional checks cover missing/altered live dates, invented links, STOP teaching, long uncut messages, date-only precision, writer failure with no ledger send/promise, and consent withdrawn during writing. No fixed character or segment limit is added.

Consent/opt-out processing, quiet-hour rules, family fan-out, dedupe, source re-read, final state reload and send-boundary reconciliation remain in place. The shared `withOptOut` already leaves bodies unchanged on current main; this checkpoint did not disable opt-out processing.

The old `copy.ts` renderer remains a baseline for cron-mechanics fixtures and still supplies solicited acknowledgements. It is no longer the scheduled reminder writer or a production fallback. These fixture assertions do not establish the new writer's factual quality.

## Verification

- Frozen-source full Web suite: **10,462 passed, 14 skipped, 0 failed** (753 passing files). Focused registration/Finder: 980 passed, 9 live skips; additional final composer/cron/ZIP/Finder: 130 passed; legacy-area affected paths: 33 passed.
- Agent: 157 passed. Worker: 437 passed, 1 real-DB integration skipped.
- Web typecheck, production build from the final staged-source snapshot, 73 skill hashes, eval syntax and diff checks pass. Local logs: `.local/vil423-pre-post/barton-followup-{web-frozen,build-frozen,typecheck-frozen,agent,worker}-20261016.log`.
- Direct public HTTPS diagnosis used the production pinned reader; no model API was called.
- Full regression exposed a compatibility bug in the first ZIP change: existing city/region rows with no country were incorrectly blocked. Fixed without changing the existing fixtures; the 33 affected-path tests pass. A new reader regression explicitly retains `New York, NY` without inventing a country. Final acceptance uses the frozen-source full rerun, not the earlier failed runs.

## Remaining gates

1. **Paid acceptance approval:** estimate posted for Sloane review: US$15–25 expected, proposed US$30 harness ceiling for 20 fresh English Finder→Coach cases plus up to 24 reminder/judge fixtures. No approval received and no new paid calls made at this checkpoint.
2. **Actual first substantive reply p50/p95**, with acknowledgements separate. Proposed targets in PR: p50 ≤30s / p95 ≤60s. These are proposals, not measured achievements or a new hard product gate.
3. **RBG location/source acceptance**, broader US/non-GTA/date/age accuracy, AI reminder judge grades and the legacy Finder quality recording refresh. Unknown/failure cases count in the report; keyless fixtures do not substitute for this.
4. **Main integration / CI:** GitHub reports the draft `CONFLICTING` against current main `d342f85ce` (#864, public activity-share retirement and related changes). Only Vercel preview checks exist so far; GitHub Actions has no run for this branch. Read-only three-way inspection finds overlaps in Finder follow-up/delivery, recordings, discovery, the eval and share-revocation paths. This checkpoint does not resolve those by overwriting main or change the user's local files. Synchronize/reconcile main before calling CI accepted.
5. Sloane review. No merge/deployment, remote migration/table drop, production watch edits, real carrier SMS or automatic booking/payment.

Risk: an unavailable/invalid AI writer defers a reminder; an urgent leg may miss its send interval if it cannot recover. This is explicit failure, not a silent template substitution. Live-copy acceptance is required before merge.
