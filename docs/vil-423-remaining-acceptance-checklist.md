# VIL-423 — single remaining recording / acceptance checklist (2026-10-22)

Status: **paid-call hold; no recording authorization**. This is the shared checklist for #875 and #877, not a request to run either suite live. It separates missing exact recordings from real quality failures. Documentation-only updates do not repair either kind.

## Frozen diagnostic inputs

- Finder #875 source head: `eed4d5713f8ce6d38b919465eec48aa82097e058`.
- Registration #877 source head: `ee7dd93e2362e9563577c63c500b8d75084ac664`.
- Both PRs still depend on the agreed #876 → #875 → #877 integration order. Re-freeze on the actual integrated head before pricing/approval; the two standalone Coach keys below are different requests, not permission to buy two copies of the final acceptance.
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

