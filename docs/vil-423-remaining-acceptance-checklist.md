# VIL-423 — single remaining recording / acceptance checklist (2026-10-22)

Status: **paid-call hold; no recording authorization**. This is the shared checklist for #875 and #877, not a request to run either suite live. It separates missing exact recordings from real quality failures. Documentation-only updates do not repair either kind.

## Frozen diagnostic inputs

- Finder #875 source head: `eed4d5713f8ce6d38b919465eec48aa82097e058`.
- Registration #877 source head: `ee7dd93e2362e9563577c63c500b8d75084ac664`.
- Both PRs still depend on the agreed #876 → #875 → #877 integration order. The priced proposal below explicitly covers each slice's distinct Coach request once; re-freeze the actual slice head before execution. These diagnostic keys are not execution approval.
- All checks here used cached-only mode or a client that captures the actual request and throws before any response/network. API credentials were removed and `HALE_RECORD=0`. No responses, judge scores, cache files, prompts, schemas or test assertions were changed.

| File (registration branch unless noted) | SHA-256 |
| --- | --- |
| `packages/agent/skills/registration-reminder.md` | `3d8af5148b489d2d906e8bd8069367eb248d19c58a5440d0368bba17302c2179` |
| `packages/agent/skills/registration-link-reply.md` | `9cd92580d2e83665ae3f26c2b1c275bb25c183b6487904f4143b34737ccc031e` |
| `packages/agent/skills/registration-message-dates.md` | `7f5ec1dfa4f9ac435d74977a55396c5cfc551683c1d1c6eeaabe64978bb6f69e` |
| `packages/agent/skills/verify-registration-window.md` | `cbd05a813b46446b52e0b7604af0cfe27e8c3e394758bc7937407e1a987a5679` |
| `apps/web/lib/testing/registration-acceptance.ts` | `6f2005ec0cf9ddc4de2380622bdc5090f95e7a22b281963ec98e8f9512456e0e` |
| Finder `packages/agent/skills/activity-finder.md` | `319f2bb36e10c9bcff84f0d013c6cc3c1ec6f076ff22122f075cc7d0af4fdf8a` |
| Finder `apps/web/lib/channel/activity/facts.ts` | `8719ac579b77b31c84e1391b22837b34268d7f085001fae68c31dc7da25e4c46` |
| Finder `apps/worker/evals/run-activity-finder-eval.mjs` | `214c3fd1a52b37d3c60009fd21fd3ccc72d36bd494155b176d7e890c9f896b99` |

## Missing recordings: observed first unanswered requests

Cloud evidence: [#875 Worker](https://github.com/villagehale/hale/actions/runs/39702566599/job/119575074022), [#877 Worker](https://github.com/villagehale/hale/actions/runs/39690991266/job/119536940859), [#877 workspace](https://github.com/villagehale/hale/actions/runs/39690991266/job/119536834179). Registration localized failures and Finder Coach miss were also reproduced locally.

| Owner / request | Exact missing key |
| --- | --- |
| #875 Coach `move-named-day` | `4edc30c7c649e200f38e3de1fa5532b27651570db1f686aaf8d148a8a538f69b` |
| #877 Coach `move-named-day` | `1847f8be5db63f533f2d2b1085a95be811456bfc405929cca938d32e4cfa2cd5` |
| #877 registration `strict:us-course-source-zone` (direct cached-only runner) | `2332f86e995362c495f147ffffb8d64e575a2f48a295524cc8b205f269143259` |
| #875 deep `cartwheels-live-research:1` follow-up (direct cached-only runner) | `13127d5b7fd4e04c3b44c25f8aa80490e804251ec385abdc2afacadb6058129d` |

The Coach failure stops the Worker job before registration/Finder/deep steps. Skipped downstream steps are **not green**. A first miss does not enumerate all later agent legs, independent parser calls or judge draws. None of the two Coach keys or the registration key had a file in locally available Git history; no substitute/re-keyed answer was used.

### #877 localized suite — 16 failing cases, not 16 validated new answers

Cache destination: `apps/web/lib/registration/sequence/__recordings__/localized.json`.
The first 13 writer requests were captured from the real composers without supplying a response; each misses in both this branch and the original source checkout. Writer model `claude-sonnet-5-5`, thinking `between_tools`. Independent date-parser work after a successful new writer response is not yet enumerable from that unavailable response.

| Case | First missing request key |
| --- | --- |
| open en reminder | `58b40f3628fd9d36bdbc666db89d140cb434fcf7bb5f25f320ca380f48b98079` |
| open fr-CA reminder | `d880be55827fbb1a656b31936c06b84ea7d90c502e515bb338908ef7aadc7aca` |
| full en reminder | `56df402d2c8ad1473ab8c88a7a439d7b4cda08038b26301e93be37c7ac1c2970` |
| full ar reminder | `ac06e296a9feb6016527f08eeacaba7526e0a8ee750fa5e92091633de84dd07f` |
| closing-soon en reminder | `800a5d9c419f76d78b07e6460eb15abd25d9c380f74e0f41b975a8349f4c9276` |
| closing-soon fr-CA reminder | `6590168ee0546db691963338d047d9d6c29ba728714eacf6946a1594c7a5498c` |
| unconfirmed en reminder | `725fa85c468356cf3ab44e4a748b87b78ce5a42d775b7f2e3d4ebebbb4b18ff1` |
| unconfirmed ar reminder | `48f98f4aafc7d5be393a28aed78cc2f81fd38bc5cf4dfdff558490c2bf84ceab` |
| pending en reminder | `f3c3acac26d180c3c24b2319d90345480c7c4d3802c2b90fb86e258aec25dfe8` |
| check-in en reminder | `949e62c60510160f63c8b07081faedc6c72dd530c57f021e283ba741f98030fe` |
| en link reply | `248ed4b22faef6c2b7b294c76d6be45074ed95a57a3ca664fbe6916194e691f0` |
| fr-CA link reply | `1becb0dd10f4ffec7d910ab41a096f23ded1d26c8cf62f9740f4c06b45cefaac` |
| ar link reply | `ab88adaf23addfd414d2ec419aab2fc04ed2133bdb34a8dea899e5012e996c7f` |
| historical corrupted French parser control | `4e336cf8d650897c454e2f70a2ed8e008633fa025a92aa7aede39c3b76d75bcb` |
| injected wrong opening date parser control | `3fb19d8e2cd20a18298ef1501bad7fb340351f3d61b5cf705051e868ce0b1001` |
| wrong French weekday parser control | `d071e74c7a7acb6e314845fac81b14edfcb93f37b5ddc76d6360414b35709247` |

Root cause: replay hashes include the current model, thinking mode, skill text and projected user message. Existing historical answers are not answers to the changed request. The composers safely return no sendable copy on a miss; the tests deliberately assert there were no misses, so those catches cannot hide missing coverage. Restoring the old prompt or weakening that assertion is not a repair.

## Genuine quality failures — not recording-only

Direct #875 `node evals/run-activity-finder-eval.mjs --cached-only` completed at the source head above: **3/8 pass, 5/8 fail; 0 live API calls / $0**. No hidden original-cache fallback was loaded.

| Fixture | Actual replay failure |
| --- | --- |
| `free-drop-in-georgetown` | Toddler query selected a birth-to-crawling group. |
| `named-venue-cartwheel` | No retained picks, but the composed text stated $140 per term. |
| `travel-visit-new-york` | No retained picks despite a viable find in the research; availability/retention needs investigation. |
| `travel-visit-montreal` | Thin/refused retrieval and no retained picks; incomplete hours must not become a fabricated schedule. |
| `travel-visit-ottawa-month-boundary` | Reseller evidence attributed to the museum; unsupported converted/approximate price. |

These remain failures. Re-recording might produce different answers but does not establish a fix. Do not weaken stage/source/price gates, promote unknown references into verified picks, or reroll until green. The shared evidence/selection/final-copy boundary needs a reviewed fix followed by approved model acceptance.

## What is green / what remains

- Fresh #877 local deterministic registration checks: **29 files, 696 pass / 2 skip**; additional Coach registration-tool + intake-answer checks **35 pass**. They cover mechanics, not real AI wording. The localized recording suite was run separately and remains **16/16 failed**.
- #877 cloud workspace had **10,656 pass / 16 fail / 7 skip** in Web tests; all 16 failures are in that localized suite. Other diagnostic stderr from deliberate failure-injection tests is not another failing test.
- Before acceptance: integrate prerequisites, freeze final production prompts/tools/projections, update this same checklist with exact inputs and one consolidated estimate, and obtain Barton's explicit approval. Preserve the existing spend ledger/cap; historical remaining balance is not authorization.
- Then, and only then: record missing final-head requests, check actual King/sibling-year and waitlist behavior, inspect EN/FR/Arabic text and date-parser controls, run Finder/source-ownership regressions and real Finder → Coach output. Post requested verbatim samples for review before committing new recordings.
- First-reply p50/p95 still needs real timing evidence; no new latency/quality acceptance is claimed from cached replay. Complete exact-head Actions after any approved repairs/recordings.
- Production cutover/backup approvals are separate: #876's synthetic recovery report does not approve a production restore or merge.

No paid estimate API, fresh page fetch, production access/write, real SMS, environment change or merge occurred in these diagnostics.

## Single priced request — proposal only, awaiting Barton's explicit approval

This is the **one consolidated remaining request**, not another approved allowance. It replaces unpriced placeholders in this checklist; historical estimates in the original #872 docs are not current permission. No approval card has been tapped and no new paid call has run.

### Amount and accounting

- **Estimated additional allowance: US$18.25. Proposed hard additional ceiling: US$20.00.** Unchanged exact cache hits cost $0 and are reused; the table conservatively budgets every listed case.
- Read-only original ledger snapshot: **US$14.233469475 spent, 576 calls, US$0 reserved**. Current cumulative cap is US$15, leaving **US$0.766530525**, which is neither enough for this proposal nor authorization to use it.
- This is explicitly a request to increase the **same ledger's cumulative ceiling** to **US$34.233469475**, not to start a new ledger or claim another $20 is already approved. Estimated cumulative spend would be **US$32.483469475**. If Barton does not approve that higher ceiling, nothing live runs; reduce/reprice the scope here instead.
- No environment variable, ledger content or configured cap was changed while preparing this request. Keep the historical refusal entry and all earlier usage; no reset, refund assumption or budget bypass.
- Price is a planning allowance derived offline from returned historical usage and the repository's billing table, **not a newly verified provider quote or a token-count API call**. Search/result size, reasoning, cache misses and bounded production retries can change actual cost. Reserve each call's maximum charge before it runs; an insufficient reservation stops the run even if actual usage might have been lower.
- One frozen pass per slice/case, not reroll-until-green. Existing runtime-bounded retries count toward the same ceiling; no manual quality reruns, paid new models, MinerU service or screenshot experiments. Real failures remain failures and are reported.

### Roll-up

| Scope | Planned case executions | Per-case allowance | Subtotal |
| --- | ---: | ---: | ---: |
| #875 Coach cached-CI repair envelope | 45 | $0.10 | $4.50 |
| #877 Coach cached-CI repair envelope | 47 | $0.10 | $4.70 |
| Finder source/age/price/retention acceptance | 8 | $0.55 | $4.40 |
| Deep extract → follow-up acceptance | 8 | $0.10 | $0.80 |
| Registration extraction including King | 12 | $0.015 | $0.18 |
| Reminder/link writers + independent date checks and language/fact review | 13 | $0.03 | $0.39 |
| Historical corrupt/wrong-date/wrong-weekday controls | 3 | $0.01 | $0.03 |
| Four fresh Finder → Coach cases below | 4 | varies | $3.25 |
| **Total planning envelope** | **140 case executions** | | **$18.25** |
| **Hard additional ceiling requested** | | | **$20.00** |

A case is **not** one API call. Coach can use up to six agent steps plus its existing bounded truncation recovery and three judge draws; Finder/deep include the relevant extraction, final copy and judge legs. Localized closing-soon includes the extra independent waitlist-deadline parse. The allowances cover those legs, not just the first missing key. The ceiling is not a guarantee that all cases finish.

Why two Coach rows: #875 and #877 have different actual tools/registration context and different first missing keys, already reproduced above. Each PR must pass CI independently. Do not replay one branch's response under the other's key. Reuse any later request only if its actual key is identical. The envelope budgets both slice freezes once; final integration cannot silently trigger a third paid run.

### Every Coach case

Each amount includes subject and applicable judge legs. A dash means that fixture is not in #875's corpus.

| Case | #875 | #877 | Combined estimate |
| --- | ---: | ---: | ---: |
| `move-named-day` | $0.10 | $0.10 | $0.20 |
| `cancel-ambiguous-two-swims` | $0.10 | $0.10 | $0.20 |
| `cancel-named-day` | $0.10 | $0.10 | $0.20 |
| `no-such-event` | $0.10 | $0.10 | $0.20 |
| `chit-chat` | $0.10 | $0.10 | $0.20 |
| `changed-their-mind` | $0.10 | $0.10 | $0.20 |
| `multi-intent` | $0.10 | $0.10 | $0.20 |
| `typos-and-voice-to-text` | $0.10 | $0.10 | $0.20 |
| `french-adjacent` | $0.10 | $0.10 | $0.20 |
| `teen-item-asked-about` | $0.10 | $0.10 | $0.20 |
| `four-changes-in-one-text` | $0.10 | $0.10 | $0.20 |
| `village-one-verified-one-not` | $0.10 | $0.10 | $0.20 |
| `village-nothing-verified-yet` | $0.10 | $0.10 | $0.20 |
| `find-activities-bare-ask` | $0.10 | $0.10 | $0.20 |
| `yes-with-nothing-open` | $0.10 | $0.10 | $0.20 |
| `coaching-solids` | $0.10 | $0.10 | $0.20 |
| `coaching-co-sleeping` | $0.10 | $0.10 | $0.20 |
| `coaching-sleep-offerable` | $0.10 | $0.10 | $0.20 |
| `coaching-night-wakeups` | $0.10 | $0.10 | $0.20 |
| `acute-symptom-slip-through` | $0.10 | $0.10 | $0.20 |
| `refer-a-friend` | $0.10 | $0.10 | $0.20 |
| `connector-ask-safety-net` | $0.10 | $0.10 | $0.20 |
| `registration-watch-asked` | $0.10 | $0.10 | $0.20 |
| `registration-watch-not-armed` | $0.10 | $0.10 | $0.20 |
| `registration-live-read-unavailable` | — | $0.10 | $0.10 |
| `registration-live-date-only` | — | $0.10 | $0.10 |
| `registration-window-plus-a-find` | $0.10 | $0.10 | $0.20 |
| `continuity-bare-noun` | $0.10 | $0.10 | $0.20 |
| `continuity-restate-fact` | $0.10 | $0.10 | $0.20 |
| `continuity-after-proactive-send` | $0.10 | $0.10 | $0.20 |
| `coaching-co-sleeping-restated` | $0.10 | $0.10 | $0.20 |
| `coaching-solids-restated` | $0.10 | $0.10 | $0.20 |
| `capability-park-nearby` | $0.10 | $0.10 | $0.20 |
| `capability-park-nearby-again` | $0.10 | $0.10 | $0.20 |
| `capability-hale-does-not-have` | $0.10 | $0.10 | $0.20 |
| `spot-watch-link-pasted` | $0.10 | $0.10 | $0.20 |
| `spot-watch-no-link` | $0.10 | $0.10 | $0.20 |
| `nearby-count-three-families` | $0.10 | $0.10 | $0.20 |
| `nearby-count-below-threshold` | $0.10 | $0.10 | $0.20 |
| `weekend-saved-find-school-age` | $0.10 | $0.10 | $0.20 |
| `weekend-empty-live-search` | $0.10 | $0.10 | $0.20 |
| `saturday-morning-block-afternoon-find` | $0.10 | $0.10 | $0.20 |
| `autonomy-off-email-en` | $0.10 | $0.10 | $0.20 |
| `autonomy-off-email-fr` | $0.10 | $0.10 | $0.20 |
| `autonomy-off-email-zh` | $0.10 | $0.10 | $0.20 |
| `autonomy-off-email-es` | $0.10 | $0.10 | $0.20 |
| `autonomy-complaint-one-email` | $0.10 | $0.10 | $0.20 |
| **Subtotal** | **$4.50** | **$4.70** | **$9.20** |

### Every Finder / deep case

The five failed Finder cases are acceptance targets for a reviewed fix, not a promise that buying a new answer repairs them. Keep evidence/source-ownership and final-copy checks unchanged.

| Runner | Case | Estimated allowance |
| --- | --- | ---: |
| Finder | `toddler-fall-programs-halton-hills` | $0.55 |
| Finder | `preschool-swim-oakville` | $0.55 |
| Finder | `free-drop-in-georgetown` | $0.55 |
| Finder | `named-venue-cartwheel` | $0.55 |
| Finder | `travel-visit-new-york` | $0.55 |
| Finder | `travel-visit-montreal` | $0.55 |
| Finder | `travel-visit-ottawa-month-boundary` | $0.55 |
| Finder | `nothing-running-underwater-basket-weaving` | $0.55 |
| Deep | `cartwheels-live-research` | $0.10 |
| Deep | `registration-in-plain-sight` | $0.10 |
| Deep | `registration-opens-later` | $0.10 |
| Deep | `price-is-on-a-different-page` | $0.10 |
| Deep | `every-fetch-refused` | $0.10 |
| Deep | `read-and-empty` | $0.10 |
| Deep | `followup-language-zh` | $0.10 |
| Deep | `followup-language-ar` | $0.10 |
| **Subtotal** | | **$5.20** |

### Every registration / wording case

Saved-page extraction uses the explicit fixture clock; it is not a fresh fetch claim. Historical corruption and wrong-date controls must still be held. Waitlist deadlines stay parent-reported; missing eligibility remains uncertain with the source link.

| Runner | Case | Estimated allowance |
| --- | --- | ---: |
| Registration extract | `us-course-source-zone` | $0.015 |
| Registration extract | `uk-course-date-only` | $0.015 |
| Registration extract | `weekday-unique-year` | $0.015 |
| Registration extract | `markham-fall-2026` | $0.015 |
| Registration extract | `markham-other-cycle-same-page` | $0.015 |
| Registration extract | `toronto-arc-rule-is-not-a-date` | $0.015 |
| Registration extract | `burlington-table-row` | $0.015 |
| Registration extract | `king-cross-year-registration` | $0.015 |
| Registration extract | `stale-prior-year-trap` | $0.015 |
| Registration extract | `toronto-announced-later` | $0.015 |
| Registration extract | `halton-hills-no-table` | $0.015 |
| Registration extract | `no-year-stated` | $0.015 |
| Writer + verifier/review | open en reminder | $0.03 |
| Writer + verifier/review | open fr-CA reminder | $0.03 |
| Writer + verifier/review | full en reminder | $0.03 |
| Writer + verifier/review | full ar reminder | $0.03 |
| Writer + verifier/review | closing-soon en reminder | $0.03 |
| Writer + verifier/review | closing-soon fr-CA reminder | $0.03 |
| Writer + verifier/review | unconfirmed en reminder | $0.03 |
| Writer + verifier/review | unconfirmed ar reminder | $0.03 |
| Writer + verifier/review | pending en reminder | $0.03 |
| Writer + verifier/review | check-in en reminder | $0.03 |
| Writer + verifier/review | en link reply | $0.03 |
| Writer + verifier/review | fr-CA link reply | $0.03 |
| Writer + verifier/review | ar link reply | $0.03 |
| Parser negative control | historical corrupted French parser control | $0.01 |
| Parser negative control | injected wrong opening date parser control | $0.01 |
| Parser negative control | wrong French weekday parser control | $0.01 |
| **Subtotal** | | **$0.60** |

### Every fresh end-to-end case

These are the four existing fresh-conversation shapes, not a new country rollout. Use synthetic local families and private local artifacts; no production DB, watches or carrier SMS. Keep the actual source inputs, intermediate picks/references and final reply, including failures.

| Case | Acceptance purpose | Estimated allowance |
| --- | --- | ---: |
| `fresh-burlington-storytime` | Burlington Ontario, current library event/session/age and matching official event URL; no unsupported price | $1.25 |
| `fresh-rbg-paid-program` | Published paid-program price stays attributable to that program in final Coach copy | $0.50 |
| `fresh-us-zip-burlington` | Existing ZIP/country handoff does not select Canadian Burlington for the US request | $0.75 |
| `fresh-montreal-french` | Existing French follow-up preserves location, source and unknown facts without garbling | $0.75 |
| **Subtotal** | | **$3.25** |

Record first-reply latency from these same four real turns at no extra model-call budget; show all raw timings and N=4 if reporting p50/p95. This is a small-sample observation, **not** a statistically established latency SLO. A larger timing campaign is not silently included.

### Basis, stop conditions and handoff

Offline basis from the **same** historical ledger (multiple earlier passes, not this proposal): Coach 272 calls / $3.2700942; Finder 110 calls / $6.6818211; deep 30 calls / $0.4813891; registration extraction 12 calls / $0.0605929. Prior fresh cases cost Burlington $1.0399006, RBG $0.4097694, US ZIP $0.6038092, Montreal $0.5428712. Per-case allowances round those observations upward; they are not measured future-case costs. Reminder/link planning also includes new parser purposes; no claim that unchanged historical copy proves current language quality.

1. #876 is first. Its exact documentation head `81d0273565a8f84e363c3754ea15d1dbd9e6f2fb` now has **all Actions checks green**, including workspace, cached Worker and Web E2E. Production backup/restore preflight and merge-window approval remain separate.
2. Follow #876 → #875 → #877. Before executing each model phase, pin that slice's final head, prompt/tool/projection hashes and current exact misses. Do not buy recordings for the provisional integration worktree. If the priced case set/model/request contract changes, amend this **same** request for review before calling.
3. Obtain Barton's explicit card approval for this amount/scope and ceiling. This document is not the card and does not approve itself. If separate slices require a different ceiling, stop and amend rather than quietly running against the old $15.
4. Execute sequentially on the unchanged shared ledger, credentials available only after approval, SDK automatic retries disabled. Every paid model/judge leg and web-search fee is charged to this request. Never run a live whole-suite fallback just to discover what else is missing.
5. Reuse exact hits; record actual calls/cost by case and stop at the proposed hard ceiling, a budget refusal, an unlisted request, or a required prompt/schema change. A failed acceptance is reported; it does not authorize another paid sample. Post verbatim successes/failures and requested language samples for review before committing recordings, then replay and require each PR's exact-head CI green.

No production backup/restore, merge/deploy, pause/resume, env/settings or feature-flag change, email/SMS send, or model call is authorized by this request.

