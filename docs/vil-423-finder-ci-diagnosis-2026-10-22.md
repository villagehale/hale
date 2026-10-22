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

#876 must land first; the prepared catalog/history handoff stays separate until that integration. Re-freeze final inputs before asking Barton for one spend approval. Cached-only diagnostics do not authorize new calls or establish King, wording, source ownership or p50/p95 acceptance.

No model/page API calls, production actions, settings changes or merge. This documentation-only update intentionally leaves the failing checks visible.

