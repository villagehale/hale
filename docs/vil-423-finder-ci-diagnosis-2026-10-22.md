# VIL-423 Finder CI diagnosis — 2026-10-22

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

#876 must land first; the prepared catalog/history handoff stays separate until that integration. Re-freeze final inputs before asking Barton for one spend approval. Cached-only diagnostics do not authorize new calls or establish King, wording, source ownership or p50/p95 acceptance.

No model/page API calls, production actions, settings changes or merge. This documentation-only update intentionally leaves the failing checks visible.

