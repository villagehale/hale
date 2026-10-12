# VIL-423 — remaining execution scope

2026-10-12. Linear is In Progress. Same branch: `codex/vil-423-live-truth`.
This push is a WIP checkpoint, not completion or production rollout approval.

## Verified checkpoint

- Existing live reader, URL-owned watch storage, ask/send verification and scheduled refresh implementation are on this branch.
- Held dates notify parents with the source, never an old cached date. Coach's protected SMS suffix now retains a paused watch's source even if the model omits it or the answer is trimmed.
- Local PGlite fixture drives watch → scheduled check → stored paused state → outbound transport for `uncorroborated`, `eligibility_unverified` and `not_published`. Each sends the source link, omits the cached October 20 date, and dedupes a second cron run.
- A separate scheduled-check fixture runs before the old 20th's heads-up interval starts, observes the 18th, updates the anchor, and delivers the change notice, heads-up and evening-before reminder against the new date.
- This fixture uses synthetic family/watch state and injected page readings/transport. It is not a real carrier delivery or preview deployment test.
- Current checks: 2,475 related web tests plus 163 rights/journey tests passed (one live-intake skip); latest live-flow suite 25/25. Web/worker typechecks and web build passed. Real Coach registration cases 5/5, with the source-link fabrication gate and judge policy aligned to the approved live-truth rule, without lowering scoring thresholds. Extraction cached replay 11/11 and broken calibration passed.

## Remaining work, in dependency order

1. Remove the legacy registration catalog and its runtime paths. Move watch-owned target identity, URL and last-known scheduling state off the legacy association before dropping it. Replace Coach/Radar/admin/sweep/reply joins; remove seeding/discovery-of-dates scripts and static date fixtures. Verify: URL-only US/UK watch still answers and receives week/evening reminders; a source shift from the 20th to the 18th is detected before the old reminder is due.
2. Remove rec-morning's hardcoded facts and GTA topic routing, using the existing live Coach/Finder path instead. Include intake and retired-portal behavior. Verify: no fixed YMCA date, city schedule or portal instructions are served; unverified replies retain the official link and no unsupported date.
3. Replace stored recommendation reads with the existing live activity finder at every asked/proactive surface. Remove weekly catalog population and its worker writer. Retain only family-owned recommendation history/bookmarks/share/endorsement/review/acceptance state needed by existing features, not a renamed discovery feed. Migrate dependent foreign keys before dropping the catalog. Verify: non-GTA family gets a current sourced recommendation; no read-less fallback from saved listings; saved/shared and follow-up state survives.
4. Run migrations in local PGlite and complete affected web/worker/DB regression, typechecks, live-source checks and build. Push the same branch with evidence and remaining limitations.

## Guardrails and estimate

- Production migrations, merge, deployment and real parent SMS remain separate, unauthorized actions.
- Do not weaken the three source-reading holds. PDF extraction remains unsupported until separately addressed; notify with its URL rather than infer a date.
- A global `rg` includes historical migrations/snapshots and evidence documents. Remove all active schema/runtime/test/skill catalog paths; preserve already-applied migration history rather than rewriting it to satisfy a literal global search.
- Initial estimate: 1–2 working days for a review-ready expanded change, including local reminder E2E and migration/regression tests; not a deployment ETA. Largest risk is preserving family-owned saved/share/review state while retiring the activity feed.
