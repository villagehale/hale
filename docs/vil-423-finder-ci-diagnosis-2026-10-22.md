# VIL-423 Finder CI diagnosis — 2026-10-22

## 2026-10-26 — post-rebase checkpoint (not model acceptance)

Rebased #875 onto main `d4806e32709ab2bc76d10db77bf2ba803ee38268`. The earlier checkpoint below is pre-rebase history, not the current input freeze. #872/#877 were not changed; no paid calls, production changes or merge.

| Before rebase / input gap | Current adaptation |
| --- | --- |
| The branch used title-matched URL attachment; main now uses cited link refs. | Keep main's ref mechanism. Both Finder tools project supported picks, uncertain references and checked sources to refs; the existing turn ledger keeps exact URLs. Uncited refs attach nothing, and typed URLs are not trusted. |
| Main's country/timezone intake and async group travel opening conflict with the older slice. | Preserve main's CA/US postal intake, country code and timezone, and await its existing group writer. No old keyword location gate was restored. |
| A supported recommendation alongside an uncertain reference lost the reference before the follow-up writer. | Both the sweep and writer projection retain mixed references, separate from picks and without rejected raw research. The eval mirrors that projection. |
| NY's positive fixture asked for September while its fixed clock was October 15. | Explicitly change that fixture to **November 12–15, 2026**, retaining the fixed clock. A mechanical test requires positive travel ranges to be future-dated. No dates roll at runtime. |
| A null date/price was described as proof the page had not published it. | The tool now says only that this read did not establish it; it cannot assert absence on the website. |

Per Sloane's [October 26 clarification](https://linear.app/villagehale/issue/VIL-423#comment-13ba6e59-1a3a-4944-9246-775df934e566), full publisher-identity/currentness proof and exact-child eligibility are **not additional prerequisites**. Named uncertain references with caveats are acceptable, never as confirmed picks or unsupported facts. Same-page fact ownership and model wording remain limitations to observe in actual acceptance, not claims repaired by buying recordings. No site allowlist was added.

Verified after adaptation: **157/157** follow-up/travel checks; **29/29** Finder/Coach ref checks; **110/110** reader/intake checks; **3/3** eval source/clock checks; **72/72** CI-script checks. These are separate, overlapping scopes, not an aggregate. Web typecheck and all **80** skill locks pass; Web lint has 71 warnings but no errors. The additional source-read label/retirement/reader/facts/lane regression passes **95/95**.

Both rebased full Web runs, including the final runtime at `a0d49c793`, report **9,970 pass / 9 fail / 12 skip**; all nine failures stop at eight exact missing writer keys, re-observed unchanged from the pre-rebase journey table. The unchanged send/fulfillment/dedupe assertions remain red, not waived. This is the current main corpus, not the older 10,506-pass corpus below. No green CI claim.

Final runtime/eval freeze: `6d13fe29ba4eb22f8fde5dc6ca5b0959dd5ed0a7`. The loader fix reuses existing `loadAgent()`; cached-only preflight and all per-case runs reach actual requests. Final source review also removed the Coach skill's contradictory “unknown price = unpublished” sentence. Its prompt hash supersedes the earlier Coach keys: final `move-named-day` starts `b13d073c…`, not historical `4edc30c7…` or superseded `fc637694…`. Full Web on this final prompt still reports **9,970 pass / 9 fail / 12 skip**. Loader startup time is not first-reply model latency.

CI on superseded head `2dbfe603f` exposed main's new group-privacy gate before Coach: a shared-prompt cache miss, not a demonstrated privacy failure. All four group cases have now been inventoried against the final prompt; only per-case CLI selection/invalid-ID regression was added, without changing privacy policy or scoring. The CLI/menu regressions pass **8/8**.

Use the [one canonical priced checklist on #875](https://github.com/villagehale/hale/blob/codex/vil-423-finder-sources/docs/vil-423-remaining-acceptance-checklist.md). It includes **24 frozen file hashes and 72 unique actual first misses**: 45 Coach subjects, 4 group-privacy subjects, 8 Finder ground requests, 7 deep writers and 8 journey writers. All 49 Coach/group cases reach missing requests, without import timeouts. One deep refusal case passes. Downstream keys are explicitly unknown, not fabricated. The four new group cases add $0.40 to the same proposal: **153 executions / estimated $19.45; proposed $20 additional ceiling unchanged**. #877's older copy remains historical until its later rebase, not a second request. No new model quality score or paid authorization is implied.

## Historical 2026-10-26 pre-rebase free-code checkpoint

The sections below this checkpoint are historical. #876 is already merged/deployed; #875 remains the next draft, before #877. No paid call, recording rewrite, schema/prod change or merge was made in this update.

### Concrete before/after examples

| Input and provenance | Before | Current deterministic result |
| --- | --- | --- |
| **Real committed Georgetown extraction + page snapshot**, not a fresh fetch: Kids & Me's Tuesday Georgetown / Thursday Acton quotes contain literal `\\u2019` / `\\u2013`; the page contains typographic characters. | Both genuine schedules failed the byte-level quote check, leaving an infant-only group as the supported result. | Exact quote matching normalizes encoding/typography. Both Kids & Me schedules survive; the birth-to-crawling group is an unconfirmed reference, not a toddler recommendation. |
| **Synthetic contradiction:** model says Friday, source schedule says Monday. | A valid `when_evidence` could sit beside independently generated `when`. | Display uses the verified schedule quote itself. Age and price follow the same source-wording rule. This does not prove same-program ownership. |
| **Synthetic contradiction:** session date says 2026 but its own quote says 2020. | Valid date syntax plus quote presence could admit the wrong year. | Explicit conflicting quoted years are rejected. Missing years and same-page cross-program attribution are not independently solved. |
| **Existing recorded travel inputs through real Finder/renderer**, clock fixed to the fixture's T−7 date. | The test silently used today's real date in Finder; reference handling was absent, and its audit counted named references as picks. | CMOM remains a supported recommendation with its schedule. Zoo tariff wording does not establish program age: zoo is separately caveated, its price omitted, and the receipt is `picks: 1, references: 1`. |
| **Synthetic reference-only travel integration.** | `no_picks` discarded source-bound references before rendering. | Names/source attribution and explicit historical/unconfirmed caveats reach the text, not unverified dates/ages/prices. Separate reference receipts; existing consent/privacy/dedupe/GSM/whole-item limits remain. A successful reference-only text closes the existing one-text-per-trip flow. |
| **Follow-up instructions.** | An old rule said no picks meant nothing matching was running. | No supported pick means this search could not establish a recommendation; retain references/uncertainty. A return promise still requires a real watch. New model wording is untested. |

The shared age parser is reused with canonical stage boundaries, including explicit `up to`, `all ages` and minimum ages. Narrower numeric restrictions win over universal wording. Unsupported qualitative wording stays a reference. Stage overlap means possible band fit, not exact-child eligibility. No per-city/site keyword table, API or dependency was added.

### Free checks and exact recording boundary

- Red-before-green regressions cover the actual Georgetown recordings, age restrictions, source-schedule mismatch, explicit year conflict, reference transport and catalog guard.
- Facts/age/lane: **95/95**. Travel copy/sweep/journey: **54/54**. These are mechanics/frozen-input tests, not new model acceptance. Web typecheck, syntax/diff checks and **71/71** skill locks pass; Biome has warnings, no errors.
- Finder's actual deterministic travel renderer now runs in the eval, with separate receipts. Requested date range/timezone/stages reach the same binder as production. Positive `expectPicks` gates remain; references cannot satisfy them. The legacy New York fixture explicitly asks for September 2026 while the corpus clock is October 15: it is marked past, not silently rolled forward. This stale positive fixture needs a declared clock/date correction before a paid freeze.
- Current cached-only Finder stops at the first changed ground request: `activity-ground:toddler-fall-programs-halton-hills`, key `218db7f6160b108ef82cd734e9caf16b725d99d149f6a86629469b9c13caa932`. No new 3/8 or 8/8 score is claimed. Broken-mode calibration passes with **0 live calls / $0**.
- Final frozen-runtime full Web: **10,506 pass / 9 fail / 12 skip**. All nine failures are the exact writer recording misses listed below (three ordinary activity journey cases, six deep-answer cases); original send/fulfillment/dedupe assertions remain. This is **not green**. Local JSON report: `/tmp/vil423-finder-web-final-20261026.json`. The initial run exposed the scripted Coach's unsupported `picks[0]` assumption; the fixture now reads the unconfirmed reference and invokes the real promise tool. It does not promote qualitative ages into recommendations or replace model responses.

Observed exact writer misses after the prompt change (eight unique keys, nine journey cases; redelivery repeats one):

| Journey | Missing key |
| --- | --- |
| Activity answered: ordinary follow-up | `8ca90aeccc6af168a3157a2d558f0bc12f26c9f5e86546926389e13e646fb3b8` |
| Activity answered: empty result | `ccd553b2b707e2816f4ff26788c1a7f5299ef5fee4dd4264b5579ae58d6a4c52` |
| Activity answered: deep follow-up | `02363e35f5aa5c67f2ece580ccbc6f337a7fc593e3fa947be09ae26d7f1c2761` |
| Deep answer: complete Tiny Gym / redelivery | `fde3ff8d34ac262cdc10b97c85e80151c13e99adf2442f37c1122ff83aeb27db` |
| Deep answer: dropped unquotable fact | `7c9ab3e325a16f19b0adda1700f0f4567ea70f172c345c23ca401dce91f07f15` |
| Deep answer: swim grid | `f229a6e63b165a8eff9d5180f21bb9328c517605c6feb9a3b723afbc45ef98fb` |
| Deep answer: uncertainty | `362ba73b034d04cd3c76a8cba54afeb277150df111a8c95fb608b127d6d65b6d` |
| Deep answer: genuinely silent page | `84a8b4994b94d9258d9426063a324fff8b3e5f004af624d751b6cd02ec82c98e` |

### Still substantive, not cured by buying recordings

Same-page quote presence still does **not** establish which program owns a fact, that a publisher is the first-party operator, or that an undated recurring schedule is current. Ottawa's reseller ownership and the broader stale-page/source-selection problem are not declared fixed. A stronger page/program evidence contract needs to be agreed before declaring the final paid freeze; no new site allowlist or guessed metadata is used to conceal that gap.

The original eight-case quality result remains the historical **3 pass / 5 fail**, not a new result. Georgetown has direct frozen-input repair evidence; Cartwheels' unsafe raw-notes path and contradictory empty wording are closed at the input/instruction boundary; travel references now reach the actual renderer. Their new model outputs, source identity, real non-GTA/US ZIP recommendation and first-reply timing remain unaccepted.

Use the **same** linked shared priced checklist, not another allowance. Its old freeze and case accounting must be amended for these exact requests and remaining source/fixture decisions before approval. The historical ledger is still $14.233469475 spent / 576 calls / $0 reserved; remaining balance is not permission. No change to #877 is included here.

Checkpoint hashes (SHA-256): skill `57c1fbbb3a97bf1117e5d210703c81d33e93d0e80a230705551b847e70c417c7`; facts `ea63d90999e4ab7a167b16ce43a97e16be53fd08d23c8acdaf7bbeb79985e3c0`; Finder eval `0dc3f5f314bf194ed2ad58ecbbd8c929593608d5d640435d7ebf2957168da23f`; fixtures `3c85dd1bcbdaed7c1eeefb5c1f7ae942d650d6c71c4c274b88c6e1fe2e57a60a`. These identify code, not approved final recording inputs.

## Historical 2026-10-22 evidence

Source head: `eed4d5713f8ce6d38b919465eec48aa82097e058`. This update documents failures; it does not claim they are fixed.

## Actual checks

- Cloud workspace lint/typecheck/test/build and Web E2E passed. [Cached Worker failed](https://github.com/villagehale/hale/actions/runs/39702566599/job/119575074022), causing the aggregate failure.
- Failure is `coach-channel:move-named-day`, missing exact request key `4edc30c7c649e200f38e3de1fa5532b27651570db1f686aaf8d148a8a538f69b`. The same miss was reproduced with `node evals/run-coach-channel-eval.mjs --cached-only --only=move-named-day`.
- The key has no file in the locally available committed Git history or original source cache. Existing answers were not re-keyed. Prompt, tool and request changes are intentional content-addressed invalidations, not license to reuse an answer to another request.
- Downstream Worker steps are skipped after that failure; they must not be reported as passing.
- Direct activity Finder cached replay completed **3/8 pass, 5/8 fail**, explicitly **0 live API calls / $0**. Unlike the earlier exploratory replay, this run needed no original-cache fallback.
- Direct activity-deep replay stopped at `activity-deep-followup:cartwheels-live-research:1`, key `13127d5b7fd4e04c3b44c25f8aa80490e804251ec385abdc2afacadb6058129d`. That is another first missing recording, not a full deep-pass result.

## Not just recording gaps

Actual cached quality failures remain: Georgetown toddler query selected a birth-to-crawling group; Cartwheels text quoted $140 with no retained pick; New York and Montreal lost viable/uncertain finds; Ottawa attributed reseller evidence to the museum and used an unsupported approximate price.

Those are factual selection, source and output-boundary failures, not missing JSON files. No prompt edits, site-specific patches, gate reductions or fabricated recordings were made to hide them. They need a reviewed shared-boundary fix and eventual approved real-model validation, not repeated paid rerolls.

## Single handoff checklist

Use the [shared remaining acceptance checklist in #877](https://github.com/villagehale/hale/blob/codex/vil-423-registration-truth/docs/vil-423-remaining-acceptance-checklist.md) for exact missing keys, localized cases, source hashes, genuine quality blockers and the approval sequence. Do not maintain a second competing recording estimate here.

## 2026-10-23 — integration after #876

Rebased locally onto main `3f35ce48d` (post-rebase head `c103eb19e`). Resolved the activity pick conflict by retaining main's nullable compatibility fields and Finder evidence; retained the new municipality helper and US ZIP intake. No migration, production change or paid call.

### Implemented, not claimed as model acceptance

| Before | Now / deterministic evidence |
| --- | --- |
| The new family adapter only admitted mapped GTA FSAs. | Reuses the existing qualified location/timezone readers. Burlington ON/Canada, Burlington VT/US and Victoria BC/Canada pass through without postal/name data. Teen-only and missing-location refusals remain. |
| Unconfirmed finds and checked URLs disappeared at the family adapter and `search_village`. | They reach Coach as references, not offers/history. A Biosphère-shaped transport fixture retains unknown age/date plus its URL; it does not become a verified recommendation. |
| Reference URLs had no Village → final SMS collector path. | The production Village tool records additional source references in the existing per-turn link ledger. Confirmed offers still use their original ledger, avoiding duplicates that break shortened-title matching. |
| An empty-search writer received raw research containing rejected facts such as `$140`. | The real writer input and eval mirror carry only town, bound references and checked sources; raw notes are excluded. This proves the fallback path is closed, not that a newly generated SMS is accepted. |
| A real price quote could sit beside an invented/converted `price`. | Display uses the quoted source wording itself, not a separately generated amount. Positive controls retain the published fee/conditions; Free, invented/converted amounts and numeric prefixes cannot replace that quote. This still does not prove the quote belongs to the right program. |
| A free-text city fallback could contain a household name. | Shared de-identification refuses it before Finder; the new integration regression reproduced the leak before the guard. |

Focused checks after these changes: **224/224** across Finder/location/travel/Coach/follow-up; after the final price-wording and link-ledger adjustment, **219/219** across the affected facts/lane/follow-up/Coach paths. These are separate, overlapping test runs, not an aggregate. Web typecheck, lint (existing warnings), syntax/diff checks and **71/71 skill locks** pass. No prompt or recording was rewritten. Full Web and latest-head Actions are reported separately when complete.

### Still blocked / not fixed

- Before these edits, fresh unchanged-recording replay reproduced **3/8 pass, 5/8 fail; 0 live calls / $0**. New cached replay stops on the changed empty-result writer input: `activity-followup:toddler-fall-programs-halton-hills:1`, key `7ff895e20c5384405419a835541f4aacb26b3291951a353bf4df0f44399fc4e5`. It is **not** a new 3/8 or an 8/8 acceptance run.
- Age/stage compatibility and first-party/operator ownership are not proved by quote presence. Georgetown's birth-to-crawling choice and Ottawa's reseller-only retrieval remain real quality work; no keyword/site-specific allowlist was added to disguise them.
- New York/Montréal reference preservation is repaired for the family/Coach path, not yet the travel renderer or the travel eval's pick-only positive-result gate. Unknown references must not be promoted into supported picks or counted as a successful recommendation.
- The old follow-up prompt still contains a contradictory “no picks means nothing matching is running” rule, despite its earlier reference-state instruction. It must be reconciled before the final recording freeze; no claim of stable corrected model wording is made here.
- Changing a writer or judge input changes its content-addressed key. Existing answers cannot be re-keyed. Requiring a new full 8/8 model/judge replay **before** authorizing any missing final-input recording is a sequencing blocker; approval for a frozen priced pass or clarification is needed, not fabricated green results.

### Remaining catalog-name audit

No active table reader/writer remains in `apps/web/lib` or `packages/db/src`. Stale schema/intake/integration comments were corrected. Two intentional runtime strings remain: `reviews/subject.ts` accepts the historical provenance key but reads **family_activity_history**, and `trail/verbs.ts` renders old audit rows. The two immutable eval-cache responses also retain their historical text. Removing these strings merely to make `rg` empty would break preserved history or alter recordings. They need an explicit legacy-compatibility exception (or separately approved data/provenance migration), not silent deletion. Historical SQL migrations and retirement tests remain unchanged.

Use the existing single priced checklist above; its old freeze heads/hashes need refreshing after the actual accepted fix set. No second allowance or budget reset is proposed.

Current offline hashes: Finder skill `319f2bb36e10c9bcff84f0d013c6cc3c1ec6f076ff22122f075cc7d0af4fdf8a` (unchanged), facts binding `2b14f509a7705ddcbe70447ccad23c90848552c2f339bad78bba7ee34bc76a53`, Finder eval `22c810d258f47a9d11788749ddd86b1053dcaa314330cfd1c23633203fd4c01a`. These identify the current code, not recording authorization or a final acceptance freeze.

Frozen runtime/full Web replay on `99985c758`: **10,490 pass / 1 fail / 12 skip**. The one failure is `activity-answered` → “the promise is kept even when the second look finds nothing”. Isolated replay confirms the changed empty-result writer request misses journey key `77314b87005d4f74370554029dd01f0c015f44979b71b276c0e495cc2aca0b6c`; the promise stays open and no text is sent. An added assertion exposes that exact missing key before the send-count assertion, without removing any acceptance assertion. No recording was fabricated and this is **not** a green full run. Local JSON report: `/private/tmp/hale-vil423-finder-web-20261023.json`.

#876 must land first; the prepared catalog/history handoff stays separate until that integration. Re-freeze final inputs before asking Barton for one spend approval. Cached-only diagnostics do not authorize new calls or establish King, wording, source ownership or p50/p95 acceptance.

No model/page API calls, production actions, settings changes or merge. This documentation-only update intentionally leaves the failing checks visible.

