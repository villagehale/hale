# VIL-423 — Step 2-only extractor: live check

2026-10-16, America/Toronto. Branch `codex/vil-423-live-truth`; comparison checkpoint `03b5d1e53`.

## Result

**Three of four English questions returned source-supported activity facts; RBG still failed before extraction.** All six extraction requests, including retries, were asserted to contain only Step 2, not the Step 1/search or Step 3/follow-up sections. This is a small current-path check, not launch acceptance or a controlled before/after accuracy or speed benchmark.

Real public search, fresh pinned HTTP, production Finder/tools/Coach/SMS formatting and real model responses were used. Household/history writes were isolated in local PGlite. No remote business DB or carrier was used. All 23 completed model requests used the existing `claude-sonnet-5-5` routing; budgets were unchanged.

| English case | Source review | Whole runtime |
| --- | --- | --- |
| London Public Library, ordinary October storytime question | 3 Oct 16 sessions; matching branch, 10:30–11:30 and Ages 1+; no price invented | 41.380s |
| Burlington ON Public Library, October storytimes | Central Family Storytime Oct 17/23/24/30, 10:30–11:00, ages 5 and younger; Aldershot Music & Rhythm Oct 28, 10:30–11:00, ages 1–5 with caregiver; prices unknown | 71.148s |
| London, explicitly asking whether storytimes are free | Same 3 Oct 16 sessions; correctly declined to assume Free | 59.030s |
| RBG Oaks and Acorns, October dates/times/fees | **Retrieval failure:** both Finder tool calls returned `not_grounded`; no page body reached extract. Coach deferred without inventing facts | 110.486s |

Each of the eight returned pick records (including repeated London activities) was checked against its saved exact source URL and literal program/age/session evidence. Date/time/branch tuples and final replies were reviewed against those same pages. Source quote presence is not a universal semantic validator.

All three successful cases initially hit the unchanged 1,024-token extraction budget; the existing thinking-off retry recovered them. Removing Step 1 did **not** eliminate those truncations. These are whole-run durations, not first-reply p50/p95.

## Actual replies and source examples

### London ordinary question

Asked for London Public Library's October 2026 preschool storytimes, current official dates, times, prices and links. Actual reply:

> London Public Library's what's-on page lists three storytimes, all for ages 1+ and all on Fri, Oct 16, 2026 from 10:30 to 11:30 am: Storytime (Ages 1+), Masonville Library. It's a drop-in. Storytime (Ages 1+), Beacock Library. It's a drop-in. Storytime: Registered (Ages 1+), Bostwick Library. It needs registration. The page didn't publish prices for any of them, so I can't say what they cost. I only have today's dates from that page, not a full October calendar. Maya is 4, so she fits the 1+ age range. Official page: https://www.lpl.ca/whats-on

Example exact page passage: `October 16, 2026 10:30 am - 11:30 am Masonville Library Storytime (Ages 1+) Drop in`. [Official source](https://www.lpl.ca/whats-on).

### Burlington ON

Asked for Burlington Public Library storytimes in Burlington, Ontario, for a preschooler in October 2026, with official dates, times, prices and links. Actual reply:

> Burlington Public Library's pages list two storytimes for ages 5 and under in October. Maya is 4, so both fit. Family Storytime at Central (Children's Storytime Tree), 10:30-11:00am on Sat Oct 17, Fri Oct 23, Sat Oct 24 and Fri Oct 30. It's for children 5 and younger with their families. Music & Rhythm Storytime at the Aldershot Branch (Program Room), Wed Oct 28, 10:30-11:00am. It's for ages 1-5 with an adult caregiver. Neither page published a price, so I can't say what they cost. Want me to add one of these to your calendar? https://attend.bpl.on.ca/event/16966892 https://attend.bpl.on.ca/event/16973179

Age passages: `Perfect for families with children ages 5 and younger.` and `Ages 1 to 5 with adult caregiver participation.` The primary event text also carries `2026-10-17 10:30:00` and `2026-10-28 10:30:00`; related Family Storytime occurrences identify the same Central venue and their separate October dates/times. [Family source](https://attend.bpl.on.ca/event/16966892), [Music & Rhythm source](https://attend.bpl.on.ca/event/16973179).

### London price question

The question explicitly asked whether these storytimes were free and told the model not to assume Free when unpublished. Actual reply:

> London Public Library's What's On page (https://www.lpl.ca/whats-on) doesn't publish a price for Storytime, so I can't say whether it's free. I'm not assuming it is. The page lists three sessions for Fri, Oct 16, 2026, all 10:30-11:30 am and all ages 1+, so Maya at 4 would fit: Storytime (Ages 1+), Masonville Library, drop in. Storytime (Ages 1+), Beacock Library, drop in. Storytime: Registered (Ages 1+), Bostwick Library. The page shows a Register button for this one, so you'd need to sign up first. I only found those three, all for Oct 16. I didn't find a schedule for the rest of October. I also checked the library's Eventbrite page (https://www.eventbrite.ca/o/london-public-library-67405991003), which had nothing I could use.

The ordinary-wording London and Burlington cases also retained unknown prices without that explicit reminder. None of these cases establishes the correctness of a known paid price.

### RBG failure, not a pass

Asked for Oaks and Acorns Nature Play at Royal Botanical Gardens, October 2026 dates, times, fees and the official link. Actual reply:

> I couldn't read a current official page for Oaks and Acorns Nature Play at Royal Botanical Gardens, so I don't have October 2026 dates, times or prices for Maya. I won't guess at them or give you a link I can't vouch for. I'll try again and text you what the page says within the day.

Both `search_village` and `find_activities` retained the named program/operator, `October 2026` and `Burlington, Ontario, Canada`, but returned `not_grounded`. No fresh page reached extraction, so this case cannot evaluate Step 2-only extraction or paid-price handling. No specific HTTP/root cause was established in this run. The generated follow-up intent was local; its later delivery was not tested here.

## Changes since the last push

- Bind program, age, price and independent sessions to source passages; code checks exact source/quote presence and valid current/in-window dates before recommendations.
- Preserve historical/unconfirmed references and checked links through both Coach tools and shallow follow-up. Unknown does not mean no activities; unsafe/duplicate source links are filtered by code at follow-up send time.
- Retain regular hours and existing metadata; use saved family timezone and stored trip date bounds without changing search privacy fields.
- Give extraction only Step 2; align the worker eval schema/binding/prompt with production. No model, token-budget, dependency, API or DB-schema change.
- Add boundary/caller tests, update fixtures without weakening assertions, append 26 real content-addressed journey recordings without replacing existing entries, and include diagnostic/A/B/business reports with explicit sample limits.

## Verification and remaining work

Current keyless Web: **10,443 passed / 14 skipped / 0 failed**. Agent **157 passed**; Worker **437 passed / 1 skipped**; Web typecheck, 72 skill hashes and eval syntax passed. A production build of the exact staged source, excluding user-owned Next/dev configuration, passed. The three-file report-example check was 78/78; the Step 2-only focused gate was 183/183.

Still open: RBG retrieval, broader current/source-backed fixture acceptance (including US), first-reply p50/p95, the legacy eight-case Finder quality corpus re-recording, and the separately authorized production cutover. Exact quotes can conservatively reject paraphrased evidence and do not prove semantic attribution. No claim of zero hallucinations or complete VIL-423 acceptance.

Raw local evidence: `.local/vil423-pre-post/extract-step2-only-live-20261016.log`; `fresh-finder-coach-2026-10-15.mjs` is the observer harness. Both remain local/untracked; actual replies and supporting passages are included above so reviewers do not need those files. This run did not merge, deploy, migrate/drop remote tables or send carrier SMS. User-owned Next/dev edits and landing documents are excluded from the checkpoint.
