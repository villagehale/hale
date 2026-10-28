# VIL-423 / #875 — approved recording pass, 2026-10-28

**Recording pass complete; acceptance is not complete.** No claim of green CI or production readiness.

## Scope and accounting

- Frozen PR head: `5032b5dfeda72c6dbdfedc079264ebc11ce7ce77`; runtime/eval inputs: `6d13fe29ba4eb22f8fde5dc6ca5b0959dd5ed0a7`. All 24 frozen hashes still match. No prompt, schema, fixture, assertion or production behaviour was changed.
- Attempted all **78 #875 cases**: 45 Coach, 4 group privacy, 8 Finder, 8 deep, 9 selected journeys, 4 fresh conversations. **#877 was not run**; its remaining 75 proposed executions need its later freeze.
- New durable ledger: **$8.46231626, 310 generation calls, $0 reserved**, including the earlier $0.046747 first tool-call response, which was reused at $0. Hard run ceiling: $20. These are usage-based figures at the pinned repository rates, not an independently reconciled provider invoice.
- Missing historical ledger remains a separately labelled **$14.233469475 / 576-call checkpoint**, not reconstructed call records. Cumulative checkpoint plus this run: **$22.695785735**. No fresh allowance is implied by the unspent $11.53768374.
- SDK automatic retries were disabled. No failed paid leg was rerun. Eight Finder and four fresh startup attempts failed before any provider call; the local harness/import issues were repaired without changing requests, and those zero-cost startup logs are preserved separately.
- Temporary operational guard instrumentation was removed; the original eval harness and spend-cap source match their backups byte-for-byte. Private evidence/ledger: `/Users/yuhangsong/hale/.local/vil423-pre-post/approved-recording-20261027/`.

| Phase | Usage-based cost |
| --- | ---: |
| Group privacy, including earlier first leg | $0.12024266 |
| Coach | $1.89654530 |
| Finder | $3.44611110 |
| Deep | $0.45521890 |
| Selected journeys | $0.04083320 |
| Fresh conversations | $2.50336510 |
| **Total** | **$8.46231626** |

Verbatim samples were posted **before committing**: [Coach/group](https://linear.app/villagehale/issue/VIL-423#comment-54f588e5-9ed7-4bc6-ba53-63546b684901), [remaining writers, fresh replies and final spend](https://linear.app/villagehale/issue/VIL-423#comment-dd86919f-7073-4cce-b7b2-2d89cac642ac). The temporary anti-bot URL query in the French sample is explicitly redacted in the public report; the exact output remains private. It is not a cleaned or fabricated cache entry.

## Results and free replay

| Coverage | Result | What remains |
| --- | --- | --- |
| Group privacy | 3/4 | Chinese busy-block wording received a 2; appointment identity was not disclosed. Human review is needed, not an automatic claim of a privacy breach. |
| Coach | 44-case aggregate cached replay passes | The remaining continuity case's first call hit `max_tokens` at 400 output tokens, including 280 thinking tokens. The approved-run guard stopped before a re-ask. Production recovery was **not** tested; the raw partial tool call was retained privately, not treated as a completed answer. |
| Finder | 2/8, also reproduced cached-only | Remaining failures include lost dated picks, reference-vs-pick scoring inconsistency and uncertain/session information. See below. |
| Deep | 7/8, also reproduced cached-only | `read-and-empty` hedges despite the page explicitly excluding under-8s. |
| Selected writer/send journeys | 8/9 | The silent-page draft reaches `left_open / no_registration_watch`, not `sent`. |
| Full two affected journey files | 14/15, `HALE_RECORD=0` | Same send-boundary failure; not nine missing writer recordings anymore. |
| Fresh real-web conversations | All 4 flows return; **not accepted as 4 factual passes** | Exact-link, retrieval and challenge-URL problems below. |

The two individual Coach invocations with voice=3 exited nonzero because a single-case mean was below the corpus mean target of 4. The 44-case aggregate replay passes with the original thresholds; these are not two additional per-case floor failures. The truncated case is excluded explicitly, never counted as passing.

All final cached replays made zero live model calls. Full-workspace CI status must be read from the pushed head; skipped stages are not passes.

## Actual examples

### Coach — successful tool use

`move-named-day` used `lookup_week` and `propose_calendar_move`, then replied:

> Move Thursday's swim at East pool to Friday at 5:15pm?

### Deep — registration facts survive the writer handoff

`registration-in-plain-sight` replied:

> Cartwheels Gym Centre runs Tiny Gym for walking to 3.5 years with a parent, Sundays 9:30-10:15 a.m., Sept 14 to Oct 26, $124 per child plus a $25 annual membership - their site says. Registration opened July 22 and runs until classes fill, online or by phone.

This is a controlled saved-source fixture, not proof of today's real Cartwheels availability.

### Finder — caveated references still fail the existing pick-based gate

Oakville returned `picks: []` and an `unconfirmed` Goldfish reference with quoted age/price evidence. The writer said:

> Goldfish Swim School - Oakville lists Mini (4-35 months) and Junior (3-4 years) swim lessons starting at $32.50 a lesson - their site says, but I couldn't confirm a day, time or this season's openings. I'll keep watching and text you when I have them.

The full draft and judge rationale are preserved in the Linear samples. The judge objects that these facts are not in `picks`, although they exist in the reference. Reconcile this with Sloane's accepted caveated-reference rule; do not label every such score an invented price. Halton Hills additionally mixed a winter registration date into a fall answer, which is a substantive wording problem.

### Send boundary — genuine failure, not a missing recording

The silent-page writer receives `watch: true` for a follow-up promise and a fixture-supplied registration date. It says:

> Gellert Community Centre has Parent and Tot 1, 2 and 3 for ages 4 months to 3 years - the Town of Halton Hills site says, though no day, time or price is posted yet. Registration opens Tuesday, September 1, and I'll keep watching and text you when they post them.

The send guard classifies the wording as requiring a registration watch, finds none, and returns `left_open / no_registration_watch`. The test transport sends nothing. The registration date was supplied by the fixture; it was not invented by this writer.

## Fresh official-page checks

These use synthetic local PGlite families, the actual frozen Finder/tools/Coach and live public HTTP. ZIP/country is seeded to test the family-to-Finder handoff; this is **not** an intake/geocoder test. No remote DB, carrier SMS, production watch, deployment or external family action is involved. The real conversation clock is Oct 28; the separate eval corpus clock remained Oct 15.

| Case | Actual outcome | Acceptance |
| --- | --- | --- |
| Burlington ON library storytime | Oct 30, 10:30–11:00, Central, age ≤5; unknown price is not called Free. | Partial: final URL is an Oct 23 event detail, with Oct 30 sourced from its Upcoming list. |
| RBG Oaks and Acorns | Explicitly declines unestablished dates/prices, retains source links. | No unsupported price, but no usable paid-program recommendation. |
| Burlington VT / ZIP 05401 | Finder receives `Burlington, VT, United States` and `America/New_York`, not Canada. | Geography handoff passes; no sourced recommendation returned. |
| Montréal / French | Final reply remains French and declines unknown facts. | No confirmed recommendation; outbound links include a Radware/PerfDrive anti-bot challenge URL. |

Burlington's exact reply:

> Burlington Public Library has Family Storytime at the Central branch (Children's Storytime Tree) on Fri, Oct 30, 10:30-11:00am, according to their site. It's for kids 5 and under, so Maya fits. The page I read didn't show a price, so that's unconfirmed. I only found that one October date. https://attend.bpl.on.ca/event/16944994

The linked [event 16944994](https://attend.bpl.on.ca/event/16944994) has Oct 23 in its main event block. The Oct 30 entry occurs in its Upcoming list. The earlier directly read [event 16944995](https://attend.bpl.on.ca/event/16944995) carries Oct 30 in the main block. Thus the final date has page evidence, but the final event-detail URL is not the matching occurrence. This is not counted as fully correct.

The French challenge URL and its opaque parameters are retained only in private fresh-run artifacts, not committed eval cache JSON. No new sanitizer, domain allowlist or prompt patch was added during this frozen pass.

## First-reply latency

Measured locally from `channelCoachRuntime.respond()` start to its returned reply, excluding DB setup; no carrier timing. Nearest-rank percentiles, **N=4**:

| Case | First reply |
| --- | ---: |
| Burlington ON | 131,855 ms |
| RBG | 46,724 ms |
| Burlington VT | 77,108 ms |
| Montréal FR | 64,773 ms |
| **p50 / p95** | **64,773 / 131,855 ms** |

This includes safe/unhelpful answers, not four successful recommendations. It is a small-sample observation, not an established SLO.

## Remaining decisions / work

1. Review the Chinese group score and the reference-vs-pick acceptance mismatch without silently lowering gates.
2. Decide the permitted follow-up for the truncated continuity case; no paid retry occurred in this pass.
3. Resolve the silent-page follow-up/registration-watch send-contract conflict.
4. Fix lost current picks, event-occurrence URL association and challenge URLs before claiming the Finder is ready. Non-GTA/US live recommendation acceptance is still unmet.
5. NY's `identity_leak:2026` is a deterministic fixture/check mismatch: the public requested year is in the window while the fixture forbids it as if it were PII. This was not changed during the freeze, and fixing it alone will not fix the missing picks.
6. Obtain green exact-head Actions and Barton's quality gate. **No merge or production changes are authorized.** #877 remains separate.
