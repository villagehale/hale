# VIL-423 — implementation and verification handoff

2026-10-12. Branch: `codex/vil-423-live-truth`.
Historical implementation and live-validation checkpoints follow; the latest main-integration status is below. Production cutover is not authorized or performed.

## Step 1: integrate current main — 2026-10-15

Replayed all eight VIL-423 commits onto `origin/main` at `e782558e8`, which includes merged #861 and its migration hotfix. The pre-rebase state remains on `backup/vil-423-pre-rebase-20261015-a18f568f`. User-owned Next/dev edits were stashed separately for restoration; landing documents are excluded.

Integration keeps main's shared structured-output implementation and activity-link handoff, together with VIL-423 live watch reads, PDF extraction, source/eligibility caveats and no fixed SMS clipping. Main's new reporting readers now use watch observations rather than the retired registration sweep. Removed catalog paths stay removed; no disputed addenda are restored.

The four unshipped migrations are now `0172_registration_live_watch_storage`, `0173_drop_registration_catalog`, `0174_activity_history_only` and `0175_retire_civic_catalog`. SQL bytes are unchanged. A red/green regression verifies that all four remain pending after main's migration watermark; the main journal prefix is unchanged and ids/tags are unique. Maintenance guards remain enforced. No remote migration has run.

Verified: Web and Worker typechecks, production Web build, Agent tests (157), Worker tests (437; 1 skipped), DB tests (104; 2 skipped), focused Web regression (1,571; 9 skipped), 72 skill hashes and eval-script syntax. Focused/full Web test results are recorded in `.local/vil423-pre-post/rebase-*.log`. Recorded-model cache misses are not waived or rewritten: changed prompt/projection requests need fresh real recordings, which this integration-only step has not purchased. This is not a new live-Finder quality claim or production approval.

**Initial blockers, resolved by the follow-up below.** Targeted reruns isolated nine replay failures in `deep-answer-at-question-time.test.ts` and `activity-answered.test.ts` to changed activity-follow-up requests missing recordings. One `travel-brief.test.ts` send assertion was also red: its existing destination was `New York, NY` without country, which the strict geographic admission rejects, and its extraction stand-in still used the old forced-tool request shape. Geographic checks and content-addressed recording keys were not loosened.

Initial complete Web suite: **10,388 passed, 14 skipped, 10 failed** across 753 files (746 passed, 4 skipped, 3 failed), in 176.27 seconds. All ten failures were the nine replay misses and one travel case above. Worker build and Agent typecheck also passed. Evidence: `.local/vil423-pre-post/rebase-web-final.log`, `rebase-focused-final.log`, `rebase-agent-tests-final.log`, `rebase-worker-tests.log`, `rebase-db-tests-final.log` and `rebase-web-build.log`. That checkpoint made no paid model calls, carrier sends, remote migrations, deployment or force-push.

### Step 1 completion follow-up — 2026-10-15

User requested finishing the remaining integration gates. Travel queries now reuse the checked-in US postal geography to qualify a matching city/state pair with its country, and the existing Canadian qualifier for provinces. A state abbreviation alone does not prove a US destination; `Toronto, NY` remains unqualified. No new API, dependency, database column or migration. The travel fixture now speaks #861's JSON-schema response shape and publishes country in its page evidence; its actual production sweep/Finder/send path passes again over PGlite/fake transport. Red/green coverage includes New York, San Francisco, Burlington VT/ON, an inconsistent city/state and a country-qualified Paris.

Real model calls added 15 content-addressed follow-up/judge recordings, including four truncated responses and their normal thinking-off recoveries. All existing recording entries are unchanged; no keys or responses were fabricated, assertions weakened or production prompts changed to force a pass. Fifteen live-recording journey tests pass, followed by **18 keyless replay journey tests** and **119 travel/location tests**. Sources in these journeys are fixture pages, not newly scraped live websites. Explicit fixture Finders keep the unrelated Village search from making an accidental live call when a recording key is present. User-owned Next/dev configuration and landing documents are excluded from the change.

**Step 1 accepted:** complete keyless Web regression is **10,399 passed, 14 skipped, 0 failed** across 753 files (749 passed, 4 skipped), in 186.85 seconds. Web typecheck, production build, 72 prompt hashes, changed-file Biome (warnings only) and whitespace checks pass. Evidence: `.local/vil423-pre-post/finish-web-full.log`, `finish-replay.log`, `finish-live-recordings.log`, `finish-travel-final.log`, `finish-typecheck-final.log` and `finish-build.log`. This finishes integration only, not the separate live-Finder factual/latency acceptance or production cutover. No carrier message, remote database migration, deployment or force-push.

## Prompt/price push checkpoint — 2026-10-15

User requested pushing the current completed changes: extraction-only prompt separation, explicit session/date instructions, internal quote-first price evidence, final Coach source-only pricing, tests and the findings below. The public price type remains unchanged. Push checks: **475 Web tests passed, 7 opt-in live tests skipped**, **12 agent skill-loader tests passed**, Web typecheck, 56 skill hashes, eval syntax and diff checks passed; focused Biome has pre-existing warnings only. No new paid calls were made for this push gate. User-owned Next/dev configuration and landing documents are excluded. This checkpoint does not rebase, restore disputed scope additions, create a PR, migrate a remote DB or authorize production deployment.

## Final Coach source-only price rule — 2026-10-15 (local)

User approved strengthening the final Coach, not changing the price representation. Following the minimal-change approach, this adds one paragraph to `coach-channel-sms.md`, its lock hash and a prompt-contract regression test. Costs, including Free, must come from this turn's program-specific tool facts. Missing/null/unknown stays unknown; neither library/drop-in assumptions nor “likely/usually/typically free” are allowed. Published units, conditions and mandatory fees must survive. Internal `price: null`, tool behavior, models and token budgets are unchanged.

### Controlled real Coach comparison

Ten before/after pairs use the same recorded Burlington Finder result and actual Coach runtime/model/SMS processing. **Only the new system paragraph differs**; removing it makes all twenty initial requests byte-identical (asserted). This is not a fresh Finder/search test. Every run actually received the three null-price picks, retained null internally and returned the ordinary follow-up intent; no run errored. All twenty final replies were manually reviewed, not judged merely by occurrence of the word Free.

| Final price behavior | Before (10) | After (10) |
| --- | --- | --- |
| Unqualified unsupported Free | 5 | 0 |
| Unsupported likely/usually/typically Free | 2 | 0 |
| Any unsupported Free claim | **7/10** | **0/10** |
| Correctly keeps cost unpublished/unknown | 3 | 10 |

Before pair 4 (incorrect despite its caveat):

```text
no price is published for any of these (library drop-ins are typically free, but their page doesn't state that)
```

After pair 6:

```text
it doesn't publish a price for any of them (so I'd treat that as unpublished, not free)
```

Four additional real Coach calls use **manually projected tool fixtures backed by earlier official-page captures**, not fresh extraction. Both paid cases use `find_activities`; both explicit-Free cases use `search_village`, whose actual result includes `summary: "All ages — Free"`. All four preserve the supplied pricing correctly.

Paid example (one of two successful runs):

```text
Royal Botanical Gardens' own page for Oaks and Acorns Nature Play (fall 2026, ages 2-5 with caregiver, 9:30-11:30am) lists a 6-week pass at $120/child plus HST and a $2 service fee, single sessions at $20/child only if the full session hasn't sold out, and 10% off for members.
```

Explicit-Free example (one of two successful runs):

```text
Burlington Public Library's program page lists Diwali Storytime as free, open to all ages.
```

### Fresh official-page → Finder → Coach check

One additional Burlington run redoes real search, pinned HTTP, extraction and final Coach generation with the new rule. Both fresh page texts contain no Free statement; all three extracted/public prices remain null. Final Coach does not infer Free. Runtime took **69.7s**, not a carrier first-reply metric. Actual final reply:

```text
Burlington Public Library's own listings (their site, not something I've independently verified) show three preschool storytimes, all drop-in with no price published: Tales for Toddlers at Central, Wed Oct 21, 10:30-11:00am, recurring Wed/Fri through late October; Family Storytime at Alton, Wed Oct 21, 10:30-11:00am, also offered other days in October; and My First Library Card Storytime at Brant Hills, Wed Oct 21, 10:30-11:30am. All three link to the same event page: https://attend.bpl.on.ca/event/993654 - worth checking that page for the full October calendar across branches. Want me to add one of these to Maya's week?
```

**Verdict: the price-specific regression passes this sample, not a guarantee of zero hallucinations or full Finder acceptance.** Recorded A/B fixtures deliberately retain their pre-existing date/source issues; the new rule does not fix those. The fresh research step still hits its existing `max_tokens` limit; extraction proceeds from freshly fetched page text. A final Coach step also hits its existing budget, then its normal thinking-off retry completes. No budget/loop change was made. Broader retrieval, source-link and schedule acceptance remains open.

Artifacts: [paired diagnostic and positive assertions](../.local/vil423-pre-post/coach-price-rule-ab-2026-10-15.mjs), [all 24 actual replies, model usage and tool facts](../.local/vil423-pre-post/coach-price-rule-ab-2026-10-15.log), [fresh-run harness](../.local/vil423-pre-post/fresh-finder-coach-2026-10-15.mjs), [fresh pages, extraction and final SMS](../.local/vil423-pre-post/fresh-coach-price-rule-2026-10-15.log).

Checks: new prompt-contract test failed before the edit and passes after it; 111 related web tests + 12 agent skill-loader tests pass, web typecheck passes, all 56 skill hashes match, focused Biome and diff whitespace checks pass. No carrier send, remote DB write, push or deployment.

## Coach price `null` versus `"unknown"` — 2026-10-15 (local diagnostic only)

User approved a model-facing representation comparison, not a global type migration. **Ten paired real Coach-runtime runs** reuse the exact three public Burlington Finder picks from the live failure below. Both arms keep the same question, local family/context, prompt, tool definitions, model, 400-token step budget and production truncation-retry behavior. Only the `find_activities` tool result shown to the model changes `price: null` into `price: "unknown"`; runtime data and the actual tool handler keep null. Existing date/source problems in the fixture were intentionally retained identically rather than fixed during this experiment.

This is a controlled handoff replay: the Finder result is recorded real data, while Coach model calls and SMS post-processing are new and real. It does **not** re-run search/HTTP, a carrier send, or production state. Ordinary production tool code still sees internal null and generates its follow-up intent before the diagnostic-only display projection. All twenty runs actually received the tested representation, all kept internal null and a returned follow-up intent, and no run errored. The first model request is byte-identical across all twenty runs (asserted SHA256 `0d9ce7d7de98f421e68d1aa4099f588c8da158e024537a2f2ef9a15ee31f1400`); subsequent model tool choices/wording can vary normally.

The raw harness flags occurrences of the word Free for review. Manual review of all twenty actual replies separates confident assertions from hedged speculation; refusing to assume free would not be counted as an unsupported assertion.

| Final Coach price behavior | `null` (10 runs) | `"unknown"` (10 runs) |
| --- | --- | --- |
| Unqualified unsupported Free assertion | 3 (pairs 2, 7, 9) | 0 |
| Unsupported likely / usually / typically free speculation | 4 (pairs 1, 3, 5, 10) | 3 (pairs 4, 7, 8) |
| No unsupported free-price claim | 3 | 7 |
| Any unsupported free-price claim or speculation | **7/10** | **3/10** |

Actual old-representation pair 2:

```text
free - their event page doesn't list a price, which usually means it's free drop-in.
```

Actual unknown-representation pair 4, still a failure under the source-only price requirement:

```text
None of these list a price, so they're likely free, but that's not published
```

Actual unknown-representation pair 3, correct handling of the missing cost:

```text
Price isn't published on any of these pages.
```

**Verdict:** the observed sample improves, particularly by avoiding unqualified free assertions in the unknown arm. It does not prove a general effect or meet the no-unsupported-price requirement: **3/10 unknown runs still infer a free price**. Explicitly caveated speculation is distinguished from a confident free claim but is not accepted as a sourced price. Link refusal/simplification, stale activities and date-window losses remain outside this representation test and are not fixed. Known paid/free values were not newly evaluated in this pass.

Artifacts: [reproducible paired runtime diagnostic](../.local/vil423-pre-post/coach-price-null-unknown-2026-10-15.mjs), [all twenty final SMS bodies, real calls and internal/display values](../.local/vil423-pre-post/coach-price-null-unknown-2026-10-15.log). Projection assertions cover null passthrough, exact null→unknown-only changes and no mutation of the captured input. Script syntax, unchanged skill lock and diff checks pass. No production representation change, prompt edit, push or deployment was made; the local test is not a completed fix.

## Fresh website → Finder → actual Coach SMS generation — 2026-10-15 (local)

User requested the missing live/full-generation checks. Four English questions now ran through **the actual `channelCoachRuntime`, real agent loop/guards/tools, production Finder web search and DNS-pinned HTTP reads, real extraction, real Coach generation and `toSmsReply`**. Tool/client wrappers only observe real calls; no model response or page text was replayed. Family/child rows, audit and recommendation-history writes live in a disposable, fully migrated local PGlite database. Unrelated effectful tool handlers are refused; the activity tools use the same production implementations with an observed real Finder injected. No remote DB or carrier was used. Runtime prompts, model settings, 1024-token Finder budget and 400-token Coach step budget remain unchanged.

**Acceptance: not passed.** All four produced complete SMS bodies, but none satisfied all retrieval / factual / requested-schedule / exact-source-link requirements. The diagnostic's `calledFinder`, `freshPagesReachedExtract` and `realCoachOutput` flags describe plumbing only, not semantic acceptance.

| English live case | Actual outcome | Coach-runtime elapsed | Verdict |
| --- | --- | --- | --- |
| Burlington library storytimes, dates/times/prices/links | Finder returned three `price: null` picks; Coach added `these are free drop-ins`. An activity dated **2020-01-22** also entered extraction. | 99.7s | Fail |
| London library storytimes, ordinary wording | First `find_activities` query lost the operator, town and month; retry via `search_village` used the right city but read only the unfiltered adult-heavy first listing page and returned no picks. Final answer had no useful schedule or source link. | 103.0s | Retrieval fail, not evidence there are no storytimes |
| London library, explicitly asking whether free and not to assume | Three included session dates/times match the fresh filtered page; all prices remain unknown, and Coach correctly declines to call them free. Coach then shortens the filtered URL to `lpl.ca/whats-on`, which does not carry those sessions in the fresh unfiltered capture. | 169.3s | Price/time pass; source-link fail |
| RBG Oaks and Acorns, current dates/times/fees | Both Finder attempts failed with `not_grounded` / unreadable chosen sources; no page text reached extraction. Coach honestly deferred but did not answer the question. | 228.4s | Retrieval fail |

### Price leak is in the final Coach, not the new extraction field

Burlington's actual extraction omitted both price fields, and all three public tool picks had `price: null`. Neither of the two captured source texts contains the word Free. The actual final Coach answer nevertheless says:

```text
none publish a price (these are free drop-ins)
```

The contradiction exists in the raw Coach model answer and survives SMS post-processing; it is not introduced by `toSmsReply`. The provider's separate general program page does publish a free-program policy, but that page was not among this turn's read sources or supplied tool facts. The finding is an unsupported addition relative to this operation's evidence, not a claim that BPL necessarily charges. The quote-first field improves extraction but does not constrain the second model's writing.

### Other observed losses

- All initial `find_activities` calls omitted the parent's October 2026 window (`window: null`). `search_village` falls back to `this year`, even when October survives inside its query string. The recorded structured date window is not reliably preserved.
- London's initial tool call also uses a generic library subject and no town. The current bound activity reader resolves only known FSA municipalities; this local family had a saved London city rather than a GTA FSA. `search_village` later uses the saved city/province/country correctly. This is a demonstrated difference between the two real tool paths, not a hypothetical parser failure.
- Burlington's second captured page contains `2020-01-22`; the extractor kept it as an unyeared January pick. The Coach correctly calls it past rather than presenting it as an October session, but the irrelevant old pick should not have entered the requested October recommendations.
- In the successful London extraction, each pick cites the full Storytime-filter URL containing `field_topic_target_id=42`. The final raw Coach answer drops every query parameter. The unfiltered fresh page captured at this time contains afternoon adult programs, whereas the filtered page contains Beacock/Bostwick Oct 16 and Children's Library Oct 19 at 10:30–11:30. The source mismatch is introduced during final writing, not extraction or SMS cleanup.
- Two Coach steps (Burlington and RBG) hit the existing 400-token thinking budget; the existing thinking-off retry produced complete final messages. These are observed recovered steps, not final SMS clipping. No budget was changed for this test.

### Direct URL cross-check

To distinguish “no published data” from retrieval failure, the **same production pinned fetch function** directly read both forms of the correct [RBG fall program page](https://www.rbg.ca/events/oaks-and-acorns-nature-play-fall/) and the London Storytime-filter URL. All succeeded: RBG about 275 KB / 1.2s; London about 160 KB / 0.15s. RBG's 20k-character text includes $120/child for the six-week pass, HST/$2 fee, conditional $20 single sessions, dates and 9:30–11:30. [Official RBG source](https://www.rbg.ca/events/oaks-and-acorns-nature-play-fall/).

Thus RBG's public facts are readable by our safe HTTP implementation when given the right URL. The failed Finder runs' exact refused URLs/statuses were not captured, so URL selection, redirects and individual refusals remain **unresolved**, not diagnosed as a generic site outage. Direct reads were not fed back into the failed Coach test or used to relabel it a pass.

### Actual questions and final SMS bodies

**Burlington question:** Find Burlington Public Library storytime programs in Burlington, Ontario for my preschooler this October 2026. Check the official pages and give me the published dates, times and prices, with the links.

```text
Burlington Public Library's own event pages list a few options for Maya's age, and none publish a price (these are free drop-ins): Family Storytime runs Thu/Fri/Sat 10:30-11:00am at Central, Alton, Brant Hills, New Appleby and Tansley Woods; Tales for Toddlers runs at Aldershot, New Appleby and Central with dated sessions like Tue Oct 20 and Fri Oct 16/23/30, 10:30-11:00am. Their Preschool Storytime listing (ages 3-5, no caregiver needed) is only dated to a past January session, so check the current fall schedule for its next October date - their site doesn't have that one confirmed yet. Source links: https://attend.bpl.on.ca/event/993654 and https://bpl.libnet.info/event/3493258
```

**London ordinary question:** What storytimes does London Public Library in Ontario have for my preschooler in October 2026? Check the current official website and tell me the published dates, times and prices, with the official links.

```text
I looked through London Public Library's current listings and the live search came back with nothing confirmed for preschool storytimes in October 2026 - no dates, times, or prices I can hand you with a working link.
```

**London explicit price question:** Are the London Public Library Storytime programs free for preschoolers in October 2026? Please look at the current official pages now. If the pages do not publish a price, say that instead of assuming free. Include the source links and any published schedule.

```text
London Public Library's events page lists storytimes for ages 1+ but doesn't publish a price on any of the listings, so I can't say they're free without assuming. Scheduled sessions for October 2026 include Beacock Library on Oct 16, 10:30-11:30am, Bostwick Library (registered) on Oct 16, 10:30-11:30am, and the Children's Library on Oct 19, 10:30-11:30am - all per lpl.ca/whats-on.
```

**RBG question:** What does Oaks and Acorns Nature Play at Royal Botanical Gardens cost for my preschooler this October 2026? Please check the current official page and tell me the dates, times and prices, with the link.

```text
I wasn't able to pull up current details on Oaks and Acorns Nature Play at RBG for October 2026 - the live search didn't return a grounded page to read dates, times or pricing off. I'll go check it again and text you what I find.
```

The returned follow-up intents are recorded in the artifact, not armed on a real outbound message; no actual follow-up delivery was tested. These durations measure the runtime's response, not carrier first-reply p50/p95.

Artifacts: [real runtime harness](../.local/vil423-pre-post/fresh-finder-coach-2026-10-15.mjs), [full model/tool/page/final-SMS traces](../.local/vil423-pre-post/fresh-finder-coach-2026-10-15.log), [source cross-check harness](../.local/vil423-pre-post/fresh-page-probe-2026-10-15.mjs), [fresh source text and read timings](../.local/vil423-pre-post/fresh-page-probe-2026-10-15.log), [assert-based review](../.local/vil423-pre-post/fresh-finder-coach-review-2026-10-15.mjs), [reviewed outcomes and full replies](../.local/vil423-pre-post/fresh-finder-coach-review-2026-10-15.json).

Checks: review assertions, script syntax, unchanged skill hashes and diff whitespace pass. This does **not** mean the live cases pass: the review asserts and documents the observed failures. No runtime fix, prompt change, push, deployment, remote migration, inbound-router/carrier test or production SMS send was performed in this pass.

## Expanded price-evidence checks — 2026-10-15 (local)

User requested more tests. No runtime code, prompt, model or budget changes in this pass. **68 additional real model calls**: 40 London calls (20 old/new pairs), two repeated two-program synthetic positive controls, 24 boundary-fixture calls and two boundary rechecks. Source text was recorded or explicitly synthetic; these were not fresh website reads or final Coach SMS. Earlier artifacts remain untouched.

### Additional London repetitions

Two further batches each ran the existing 10-pair harness over identical saved London page text. Both arms still use Sonnet 5 adaptive/high and 1024 tokens. The old prompt is the pre-evidence version, not the older faulty `when` wording. No responses were replayed from output cache; provider prefix-cache usage is recorded.

| Check | Old: 20 new runs / 60 picks | Evidence-first: 20 new runs / 60 picks |
| --- | --- | --- |
| Unsupported Free | 2 runs / 6 picks | 0 runs / 0 picks |
| Any price despite no published cost in these pages | 2 runs / 6 picks | 0 runs / 0 picks |
| Invented price evidence | Not requested | None emitted; both fields omitted |
| Errors / truncation | 0 | 0 |
| Output tokens | 418–597; 10,081 total | 418–596; 9,630 total |
| Compose duration, not first-reply latency | 3.4–9.5s | 3.3–4.7s |

Failures were old extra-A pair 4 and extra-B pair 1: each labeled three library programs Free without published cost. All 60 new-arm picks omit both price fields. Combined with the preceding experiment, the **same London input** now has **3/30 old runs with unsupported Free versus 0/30 evidence-first runs** (9/90 versus 0/90 picks). This is an encouraging narrow comparison, not a statistical guarantee or proof of arbitrary-site accuracy. Both repeated synthetic two-program controls preserved the published $20 child fee and explicit Free, with verbatim quotes emitted before price.

### English boundary fixtures

Twelve short, explicitly synthetic source documents were each tested twice with fresh model calls. These isolate evidence interpretation and are not real-provider facts. Successful outputs below retain the required amount/qualification; omitted means both `price_evidence` and `price` absent. Every priced successful output quoted text present verbatim in its fixture's cited page and emitted evidence before price.

| Source scenario | Actual price output (one of the successful repetitions) | Result |
| --- | --- | --- |
| Explicit $20 per child | `$20 per child` | 2/2 initial |
| Explicit free admission | `Free`, evidence `Admission is free` | Initial 2 harness parse errors; 2/2 fresh rechecks |
| Drop in, no price | Omitted | 2/2 initial |
| Register, no price | Omitted | 2/2 initial |
| Free parking, admission unknown | Omitted | 2/2 initial |
| Adults free; children $12 | `Adults free; $12 per child` | 2/2 initial |
| Members free; non-members $15 | `Free for members; $15 per child for non-members` | 2/2 initial |
| Free admission, mandatory $8 materials | `Free admission; $8 per child required materials fee` | 2/2 initial |
| $10–$25 depending on age | `$10-$25 per session, depending on the child's age` | 2/2 initial |
| Adjacent, unrelated Chess Club is free; target price absent | Omitted | 2/2 initial |
| $30 standard; free only with approved subsidy | `$30 per child (free if approved for low-income subsidy)` | 2/2 initial |
| Starting at $25; total depends on supplies | `Starting at $25 per session (total varies by supplies selected)` | 2/2 initial |

**Harness issue retained, not recategorized as passing:** initial boundary results were **22 passes and 2 parse errors out of 24 calls**. The simple diagnostic reader demanded an array, while those two explicit-Free responses supplied a string in `picks`. Runtime already has `decodePicks` for JSON-encoded arrays/envelopes, but this diagnostic had omitted it. The original raw payloads were not retained by that strict reader, so their price quality and whether they would decode successfully cannot be retroactively established. The harness now loads the actual runtime decoder from the trusted local source, self-checks both supported encodings, preserves future `wirePicks`, and reran only that fixture. **Both new calls passed** (both happened to return direct arrays). This gives 24 assessed successful boundary outputs plus the two retained, unassessed original parse errors; it does not turn the original 24-call run into 24/24. No product parsing fix or prompt retry-until-green was made.

The local grader self-checks known-good and invalid outputs before API use. It checks required price terms/qualifications, verbatim quote membership, exact source URL and field order; it is a conservative case-specific test, not a general semantic proof or new production validator. Script syntax, unchanged prompt hash and skill lock, and diff checks pass. The prior 120 mechanical tests/typecheck remain the previous pass's results; they were not rerun for this diagnostics-only extension.

Artifacts: [London extra-A outputs](../.local/vil423-pre-post/london-price-evidence-ab-2026-10-15-extra-a.log), [London extra-B outputs](../.local/vil423-pre-post/london-price-evidence-ab-2026-10-15-extra-b.log), [boundary harness and fixture definitions](../.local/vil423-pre-post/price-evidence-boundaries-2026-10-15.mjs), [original 24 boundary outcomes, including errors](../.local/vil423-pre-post/price-evidence-boundaries-2026-10-15.log), [two explicit-Free rechecks](../.local/vil423-pre-post/price-evidence-boundaries-free-recheck-2026-10-15.log).

Not checked: new live sites, longer multi-program price pages, final Coach SMS or deployment. Schema ordering/instructions remain guidance, not deterministic evidence verification. No push or deployment.

## Quote-first `price_evidence` — 2026-10-15 (local)

User requested a `price_evidence` JSON field before `price`. The runtime tool schema and Zod parser now include that optional string immediately before `price`; the eval's tool schema mirrors the addition. The skill's example places a literal cost quote before its price, and the field instruction asks for the cited page's exact program-cost text before filling price. With no published cost, omit both fields; `Drop in` / `Register` do not establish price. The existing `price` format, public `ActivityPick`, normalization, model, budgets and page input are unchanged. Evidence is internal to extraction, not forwarded to Coach or stored in a new table. There is no second runtime model call or new deterministic evidence validator.

Mechanical red/green: a new request test failed on the absent field before implementation. It now verifies schema field order, optionality, prompt instructions and the unchanged public response (no `price_evidence` leak). **120 related tests pass**, Web typecheck, **56 skill hashes**, eval syntax/format and diff checks pass. Web Biome has only the two existing geography-test non-null warnings; the eval also has pre-existing console warnings. No unrelated user edits were changed.

Controlled comparison: **10 old + 10 new real compose calls** over identical saved London page text, using Sonnet 5 adaptive/high and 1024 tokens. Old and new arms differ only in the evidence field and its accompanying quote-first instructions/example. Pair launch order alternated; all model responses were newly generated. No fresh search, HTTP, DB or SMS was exercised.

| Check | Old (10 runs / 30 picks) | With price evidence (10 runs / 30 picks) |
| --- | --- | --- |
| Unsupported Free | 1 run / 3 picks (pair 10) | 0 runs / 0 picks |
| Any price on these pages without published cost | 1 run / 3 picks | 0 runs / 0 picks |
| Fabricated price evidence | No evidence field requested | None emitted; both fields omitted on all 30 picks |
| Unsupported recurrence | 0 runs | 0 runs |
| Errors / truncation | 0 | 0 |
| Output tokens | 397–597; 4,797 total | 418–554; 4,621 total |
| Compose duration (not SMS first-reply latency) | 3.3–4.6s | 3.3–4.4s |

All ten new outputs omit price and price evidence. For example, new pair 10 returns Children's Library STEAM on Oct 15 at 10:30–11:30, Masonville on Oct 16 at 10:30–11:30 and Bostwick on Oct 16 at 10:30–11:30, without either price field. Old pair 10 instead labels all three selected programs `Free`. Included dates/times in the new outputs match the saved sessions; selection remains non-exhaustive. These ten new outputs do not reproduce the earlier source-attribution failure, but this change does not enforce correct source attribution and does not establish that issue as fixed.

Positive control: **one additional real model call over explicitly synthetic English source text** containing two programs, not a real website read:

```json
{"name":"Painted Leaves Workshop, Example Community Centre","price_evidence":"Cost: $20 per child","price":"$20 per child"}
{"name":"Paper Stars Workshop, Example Community Centre","price_evidence":"Admission is free","price":"Free"}
```

Both quotes occur verbatim in that fixture's cited page text, both precede price in the actual tool output, and both prices are correct for the fixture. This checks that explicit paid and free costs can still be returned, rather than suppressing every price. It is not real-provider price validation. Tool-property ordering plus instructions encourage evidence-first generation; ordinary JSON Schema does not enforce emission order or prove a quote is grounded.

**Verdict:** this small London comparison is encouraging (1/10 → 0/10 unsupported-Free runs), not statistically conclusive or a guarantee. It tests the field plus its instructions/example, not field order in isolation. Other websites, realistic price qualifications, fresh-page retrieval, final Coach SMS and any production deployment remain unverified. No push or deployment.

Artifacts: [controlled comparison and synthetic positive control](../.local/vil423-pre-post/london-price-evidence-ab-2026-10-15.mjs), [all 21 real model outputs, evidence/order checks and usage](../.local/vil423-pre-post/london-price-evidence-ab-2026-10-15.log).

## Ten additional `when` repetitions — 2026-10-15 (local)

Ten fresh Sonnet 5 compose calls using the latest field instructions and the same saved London page texts; adaptive/high and 1024-token budget unchanged. No fresh search, HTTP, Coach SMS, DB or production activity. No additional production-code or prompt changes were made in this test pass.

| Check | Result in these 10 new runs |
| --- | --- |
| Included dates and corresponding session times | 30/30 picks correct against the two captured pages |
| Unsupported weekly recurrence | 0/10 runs |
| Bostwick Oct 21 borrowing Oct 16's time | 0/10 runs |
| Response error / token truncation | 0/10 runs |
| Unsupported `Free` | **3/10 runs**, 9 picks — still a failure |
| Cited page lacks the selected program | **1/10 runs**, 2 picks — still a failure |

All ten runs selected Bostwick. Seven returned both correctly paired occurrences; three returned only Oct 16. A correct subset is not counted as a date error or proof of completeness. Below, “both” is the actual schedule `October 16, 2026, 10:30 am - 11:30 am; also October 21, 2026, 9:30 am - 10:30 am` (runs 3–4 also correctly name Friday / Wednesday). “Oct 16 only” is `October 16, 2026, 10:30 am - 11:30 am`.

| Run | Bostwick schedule returned | Date/time verdict | Other failures | Output tokens |
| --- | --- | --- | --- | --- |
| 1 | Both | Correct | Unsupported Free on all 3 picks | 638 |
| 2 | Oct 16 only | Correct | None observed in these checks | 418 |
| 3 | Both | Correct | None observed in these checks | 598 |
| 4 | Both | Correct | None observed in these checks | 461 |
| 5 | Oct 16 only | Correct | None observed in these checks | 418 |
| 6 | Oct 16 only | Correct | None observed in these checks | 418 |
| 7 | Both | Correct in the combined input | Unsupported Free on all 3 picks; Masonville and Bostwick cite the unfiltered page, where neither program appears | 394 |
| 8 | Both | Correct | None observed in these checks | 441 |
| 9 | Both | Correct | None observed in these checks | 578 |
| 10 | Both | Correct | Unsupported Free on all 3 picks | 572 |

Run 7's dates/times exist in the filtered page in the input, but the model cited the unfiltered URL. This is a source-attribution failure, not fabricated session times. Neither input page publishes a free price. These failures were retained, not retried until green, and no price/source fix was added to this narrow repeat-test task.

Output tokens: **394–638**, **4,936 total**; compose call durations **3.3–5.3 seconds**, not first-reply p50/p95. Together with the previous three new-wording runs, the same London case has **13/13 runs without the two observed schedule errors**. This is evidence of improved repeatability for this input, not a general Finder acceptance result.

Artifacts: [repeat harness](../.local/vil423-pre-post/london-when-repeat-2026-10-15.mjs), [all ten raw model outputs and usage](../.local/vil423-pre-post/london-when-repeat-2026-10-15.log), [case-specific source review](../.local/vil423-pre-post/london-when-repeat-review-2026-10-15.mjs), [reviewed outputs and counts](../.local/vil423-pre-post/london-when-repeat-review-2026-10-15.json). The initial raw log's `unknownSourceUrls` flags looked at camelCase instead of the raw tool's `source_url`; they are diagnostic-harness errors, not model failures. The corrected reviewer checks actual `source_url` and the cited page's program text; its counts above supersede those flags. The repeat harness is corrected for future runs without changing or rerunning the recorded model outputs.

Not checked: new cities, actual weekly / term-range programs, fresh-page retrieval, final Coach SMS. No push or deployment.

## Explicit `when` field instructions — 2026-10-15 (local)

User requested changing the field description after the two earlier minimal experiments. Only the `when` description and its prompt hash were changed in this pass. It now requires published dates to stay paired with their own times, permits recurrence only when explicitly published, and clarifies that a calculated weekday applies to that specific date rather than establishing a weekly schedule. Published term ranges / registration dates and unknown-time omission are preserved. No examples were added, and the JSON schema, model, budgets and renderer remain unchanged.

Controlled comparison: **3 old-description + 3 new-description real compose calls** over the identical recorded two-page London input. Both arms omit the earlier JSON `when` example and the Step 3 SMS-writing instructions, so only the field description differs. The harness asserts that difference, uses the production tool-schema literal, `forceToolJson`, `activityClient`, Sonnet 5 extract lane (`adaptive` / `high`) and 1024-token budget. No new search/HTTP read, DB write or SMS was involved.

| Observed schedule error | Old description | New description |
| --- | --- | --- |
| Unsupported weekly/recurring claim | 3/3 runs | 0/3 runs |
| Oct 21 time incorrectly borrowed from Oct 16 | 1/3 runs | 0/3 runs |

Actual new-description Bostwick output:

```text
Friday, October 16, 2026, 10:30 am - 11:30 am; also Wednesday, October 21, 2026, 9:30 am - 10:30 am
```

Two new runs preserved both sessions with their correct distinct times; the third returned only the correctly dated Oct 16 occurrence. The nine returned picks' included dates/times and source URLs were checked against the captured pages. This verifies included facts in this sample, not completeness of all sessions. New output token counts were **463 / 620 / 568**, with no truncation; compose calls took **6.5 / 6.6 / 7.1s** (not end-to-end first-reply latency).

**Verdict:** this single-case comparison shows an improvement, unlike the two preceding experiments. It does not prove the wider Finder is fixed. Actual weekly/term-range sources, other cities, fresh-page retrieval and the final Coach SMS have not been re-evaluated for this wording. Price was not changed or treated as fixed. The text-only change and prior prompt experiments remain uncommitted/unpushed; the separate Burlington geography commit `b28f802f` is already remote.

Mechanical regression: **119 tests passed**, Web typecheck and **56 skill hashes** pass. No deployment or model change.

Artifacts: [reproducible local comparison](../.local/vil423-pre-post/london-when-description-ab-2026-10-15.mjs), [all six actual outputs and usage](../.local/vil423-pre-post/london-when-description-ab-2026-10-15.log).

## Extraction without follow-up SMS instructions — 2026-10-15 (local)

User approved a second minimal experiment after finding that the shared skill still contains weekday/time examples in Step 3. The production Finder's **extraction call only** now receives the existing prompt prefix before `## Step 3 — THE FOLLOW-UP TEXT`. Search and follow-up writing still use the original full skill. The eval's extraction request mirrors this boundary. No new prompt text, schema, model, token budget, dependency or DB change was introduced; the prior removal of the JSON `when` example remains in both arms.

Red/green request test: the added test initially failed because extraction still received the SMS examples; it now verifies the exact prompt prefix, continued Step 2 / no-invention rules, and that the research request retains Step 3 and its examples. Related mechanical regression **119 passed**; Web typecheck, **56 skill hashes**, eval script syntax and diff checks pass. Biome reports only the two existing non-null-assertion warnings in the geography test setup.

Controlled comparison: **3 full-prompt + 3 prefix-only real compose calls** with identical recorded London HTML text and unchanged Sonnet 5 extract settings (`adaptive` / `high`, 1024 tokens). No fresh search/HTTP, DB, carrier or Coach reply was exercised. Earlier experiment files were preserved; all six outputs below are new model responses, not cache replay.

| Observed behavior | Full prompt, already without JSON `when` example | Prefix only, without SMS-writing Step 3 |
| --- | --- | --- |
| Unsupported plural-weekday / recurrence claim | 2/3 runs | 2/3 runs |
| Bostwick Oct 21 included at the wrong 10:30–11:30 time | 1/3 runs | 1/3 runs |
| Unsupported `Free` claim | 0/3 runs | 0/3 runs |

Prefix-only first run still returned `Fridays, 10:30 am - 11:30 am (e.g. Oct 16, Oct 21), Bostwick Library`. Its third run instead returned the correct single occurrence, `Friday, October 16, 2026, 10:30 am - 11:30 am`. The full-prompt control also had a correct single-occurrence run. Prefix-only output tokens were 467 / 507 / 432, with no truncation.

**Verdict:** removing Step 3 did not show a reliable improvement in this small sample. Those SMS examples are not necessary for the error to occur; this does not rule out other prompt wording, such as `A day and a time`, nor establish the primary cause. The minimal phase boundary remains local for review; do not treat it as a schedule-quality fix. Broad Finder quality, fresh-page runs and final Coach SMS remain unverified for this change. No push or deployment.

Artifacts: [local comparison script](../.local/vil423-pre-post/london-extract-only-ab-2026-10-15.mjs), [all six actual outputs and usage](../.local/vil423-pre-post/london-extract-only-ab-2026-10-15.log).

## Minimal `when` prompt experiment — 2026-10-15 (local)

User-requested change: removed only the JSON example's `"when": "Saturdays 9:15am, fall session starts Sept 13"` line from `activity-finder.md`, and refreshed that skill's hash. No schema, model, budget, extraction-rule or database change. The remaining field instructions and follow-up examples are unchanged.

Controlled comparison: **3 old-prompt + 3 new-prompt real compose calls**, using the identical two London page texts captured during the city test. The input did not include previous model answers. The script asserts that the only system-prompt difference is the deleted line, reads the production JSON-schema literal, and reuses `forceToolJson`, the actual `activityClient`, Sonnet 5 extract lane (`adaptive` / `high`) and 1024-token budget. This isolates prompt behavior; it is **not** six fresh searches, HTTP reads or end-to-end Coach replies. Provider prefix-cache usage is recorded; model outputs were freshly generated, not replayed.

| Observed behavior | Old prompt | Example line removed |
| --- | --- | --- |
| At least one unsupported plural-weekday / recurring schedule claim | 3/3 runs | 3/3 runs |
| Bostwick Oct 21 incorrectly included at 10:30–11:30 rather than 09:30–10:30 | 2/3 runs | 3/3 runs |
| Unsupported `Free` claim | 2/3 runs | 0/3 runs |

New-prompt output still includes `Thursdays 10:30-11:30 am, e.g. Oct 15, 2026` and `Fridays 10:30-11:30 am, e.g. Oct 16 and Oct 21, 2026`. These source texts date individual sessions; they do not establish those recurring schedules. The three new runs emitted 452 / 448 / 458 output tokens, without truncation.

**Verdict:** removing this one example line did **not** resolve the schedule errors. This small experiment neither proves the original example caused the errors nor proves a price improvement; the new prompt still sometimes places `Drop in` in `price`. The one-line removal remains local as requested; no automatic schema refactor or extra prompt tightening was added.

Mechanical regression: **118 tests passed** (Finder lane, follow-up note and location); **56 skill hashes match**, script syntax and diff whitespace checks pass. Shared-prompt quality outside this London extraction case was not re-evaluated. No push or deployment.

Artifacts: [reproducible local comparison script](../.local/vil423-pre-post/london-when-prompt-ab-2026-10-15.mjs), [all six actual outputs and token usage](../.local/vil423-pre-post/london-when-prompt-ab-2026-10-15.log), [original context](../.local/vil423-pre-post/london-error-context-2026-10-15.json).

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

- `0173_drop_registration_catalog.sql`: copy only watch-owned source metadata into `registration_sequences.source_context`, retain historical window IDs for send dedupe, remove the catalog FK, and drop `registration_windows`.
- `0174_activity_history_only.sql`: preserve referenced/shared/endorsed/saved/reviewed receipts in `family_activity_history`, switch engagement FKs, then drop `village_candidates` and `village_feed_rank`.
- `0175_retire_civic_catalog.sql`: detach obsolete FKs and drop civic sessions/venues without deleting introduction proposals, watched sources, review IDs or activity receipts.
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
