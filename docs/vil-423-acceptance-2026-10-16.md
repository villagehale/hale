# VIL-423 — acceptance checkpoint, October 16

**Not merge-ready.** Barton [approved regeneration at 21:53](https://linear.app/villagehale/issue/VIL-423#comment-3ecfb375)
within the SAME $15 ledger, after source push and spend disclosure. It has now
produced **10 usable messages / 1 held French failure**. #872 goes first, #871 stays paused. No rebase, deployment,
remote migration, real watch edit, carrier SMS, registration or payment.

## Actual examples and changes

| Observed example | Change / current status |
| --- | --- |
| French/Arabic registration replies contained `2026-08-12 at 06:30 America/Toronto` | Writer now receives structured date/time/zone/precision. Actual French link: `12 août 2026 à 6 h 30, heure de Toronto (heure de l'Est)`; parser returns Aug 12 / 06:30 / America/Toronto. Actual Arabic link also uses natural date/zone words. No fixed English fact string. |
| Full Chess course | Existing parser reads the same official HTML bytes: full, zero seats, waitlist available. Actual English output says `the class as full (0 spots left), though a waitlist appears to be available`. It does not promise a seat. |
| Unreadable course | Actual output: `we couldn't read the official course page this time, so we can't verify the registration date ... date reminders are paused`, with official link; no old DB date fallback. |
| US Burlington / French Montreal unverified results | Tool payload retained source URLs, but final Coach reply omitted them. A structured `sourceReference` flag now makes the send formatter retain those safe links even with no recommended title, and deduplicate them. No city/language word list or AI reroll. |
| Legacy Finder returned no picks in five of eight cases | Eval sent the extractor research notes without actual page bodies. Eval now uses the existing pinned official-page reader, distinct authentic page cache, no prose fallback. Two mechanics tests pass; **new real page/model recording is held**, so no green claim. |
| Finder JSON truncated at 1,024 tokens | Production and eval extraction allowance is now 2,000. This is not a message-length limit; lane's 43 tests pass. |

Registration outcomes use AI wording in the parent's language, with no fixed
English fallback. The old output `STOP` phrase regex is removed; the existing skill
and judge own that instruction. Approval, opt-out, URL safety, lease/idempotency and
live-read gates remain. No fixed SMS character/segment cap is reintroduced.

## Real four-conversation Finder → Coach check

Synthetic local households, actual search/pinned HTTP/extraction/Coach, no carrier
send or remote family DB. Explicit request month: October 2026.

| Case | Actual observation | First substantive reply |
| --- | --- | ---: |
| Burlington ON, library storytime | Current upcoming-events widget supplied Oct 16/17/22/23, 10:30–11; price unknown, not Free. **Age/source ownership not accepted:** main detail URL is Jan 4, 2020, while current dates came from its widget. Current-session eligibility must be unconfirmed unless tied to a current page. | 68.746 s |
| RBG Oaks and Acorns | Location unverified; no invented date/price, source links supplied. This is a safe hold, not successful discovery. | 43.668 s |
| US ZIP 05401 / Burlington VT | Qualified query uses coarse place, not ZIP. Source found, but location verification held; missing final source links exposed the formatter bug above. | 76.385 s |
| Montreal, French | French unconfirmed reply; same location hold and final-link bug. | 64.982 s |

N=4 nearest-rank **p50 64.982 s / p95 76.385 s**. These are full substantive reply
times, not cached/model-only timings. No speed target or zero-inaccuracy claim.
The Burlington result is retained as a failure/ownership gap, not relabeled green.
No new Burlington AI sample was generated during the hold.

## Verification

- Before recording: isolated Web 10,497 pass / 14 skip / nine missing-recording failures.
- Those missing authentic journey recordings were filled; affected two files: 15/15 pass.
- Recorded Web before the latest natural-date change: **10,516 pass / 14 skip**.
- Recorded-test-inclusive full Web: **10,545 pass / 14 skip**, 180.10s. The subsequent additional wrong-weekday case passes in the 13-case recorded replay.
- Coach **47/47 pass**, mean voice 4.47; cached replay uses zero API calls.
- Deep **8/8 pass**, including existing repair path; cached replay uses zero API calls.
- Broader registration/spend/Finder/formatter/local-DB regression: **761 pass / 2 opt-in skip** before the final recorded tests. Genuine localized writer/parser replay **13 pass**: ten send-shaped cases, held corrupted French, injected wrong date and wrong weekday. These are delivery/guard outcomes, NOT thirteen language-quality passes. Spend-cap tests **16 pass**, including logged budget projection and next-call stop.
- Worker mechanics after page-reader alignment: **441 pass / 1 skip**.
- Typecheck, isolated production build, isolated lint and 76 skill hashes pass; lint retains existing warnings. Root lint also sees three errors in the ignored local `.corepack` tool launcher, which is not release source.
- Actual captured US/Montreal AI bodies replay unchanged through the final send formatter: all checked links survive and are deduplicated, zero API calls. This is formatter replay, not a new full AI conversation.
- Legacy Finder remains **3/8 pass**, pending approved real page-input recording.

Eval corrections preserve production inputs and checks: real registration tool
instead of injected authoritative dates; actual calendar weekdays supplied to the
grader; exact existing spot policy supplied only on spot turns; generic quote-aware
sentence boundary fixes `Then` misread as a name; ISO/English dates compared as the
same valid day. No assertion, voice floor or factual standard was lowered. Original
recording keys/values are unchanged; no fabricated or re-keyed model answers.

## Review, spend and remaining gates

[Eight verbatim reminder outputs](https://linear.app/villagehale/issue/VIL-423#comment-00afb2d2)
and [EN/FR/Arabic link replies](https://linear.app/villagehale/issue/VIL-423#comment-49731771)
were posted before recording commits. They use saved official Markham HTML and a
simulated August 12 clock, not future dates as of today. Closing-soon is the existing
**parent-reported waitlist-offer deadline**, not a scraped registration-closing date.
Their automated grades 4–5 do not override Sloane's later natural-language blocker.

The same ledger stands at **$10.584828315 / $15 (456 calls, no reservations)**.
The hold was read late; post-hold batches and the ONE revised $4.10 remaining-work
estimate are disclosed in [the estimate](vil-423-acceptance-estimate-2026-10-16.md).
The latest [verbatim regenerated samples](https://linear.app/villagehale/issue/VIL-423#comment-74a22840)
were posted before recording commits. Ten usable messages scored 4–5; one French
waitlist message contains mojibake and remains safely held because the parser's
corrected-accent quote is absent from the actual text. No encoding repair or reroll.
The original writer/parser answers replay unchanged after ignoring an unstated,
unquoted derived weekday; quoted wrong weekdays still fail. Deliberately changing
the captured English Aug 12 opening to Aug 13 produces a real parsed Aug 13 and a
hold against the official Aug 12 fact. A French negative control `jeudi 12 août`
produces quoted weekday 4 and is held against Wednesday (3); this is injected
test text, not a writer hallucination. Recorded delivery/guard replay now has
**13 passing tests**: ten positive, corrupted French, wrong date, wrong weekday.
Original failures remain in the audit.

Still required: confirmation for the one held French sample's recovery, legacy
Finder recording, missing US source-zone registration-verify recording and CI,
current-instance eligibility evidence for Burlington, and final
Sloane review. Location false negatives and measured slow replies remain visible.
Older live-reader English/time regex → extractor is a separate non-blocking follow-up.
Remote destructive catalog cutover needs its own backup/maintenance approval.

The release source excludes separate uncommitted VIL-337 controls and local
Next/landing edits; no migration renumbering or unrelated work is included.
