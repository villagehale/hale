# VIL-423 — steps 3 and 4

Local implementation on `codex/vil-423-live-truth`, 2026-10-10. Builds on the
existing uncommitted steps 1 and 2. No deployment, production migration, model
change, commit/push, or real parent message was performed.

## Step 3: live facts at the conversation and reminder entry points

- Coach registration questions (including date follow-ups in a registration
  discussion), Radar/nudge, rec-morning and reminder proposals read the known
  source page. Stored dates and old answers are not fallback facts.
- A Coach read of a saved watch also records the observation and runs the same
  scheduling decision as cron. A newly postponed date is reported as paused,
  not as an active promise based on the old anchor.
- A public HTTPS course link can create a URL-only pending watch without a GTA
  `registration_windows` row. The existing reviewer/action approval path remains
  responsible for consent. A pasted link or bare YES is not new consent; an
  explicit reminder request uses the existing approval checks.
- Existing PerfectMind course binding, age/readiness checks and already-open
  spot routing remain. The spot allowlist is not broadened.
- Facts retain the source's timezone; reminder slots and quiet hours use the
  parent's timezone. Missing source timezone requires clarification.
- A date-only page cannot support a fifteen-minute reminder. An unavailable
  page cannot support an old clock, even repeated inside a disclaimer.

## Step 4: bounded refresh and send-time verification

The existing five-minute registration cron now claims due `next_check_at` rows
before its normal proposal/send phases. There is no new discover-events job.

- Far-future dates: daily. Within seven days, unknown/unreadable dates and
  pending postponed-date reviews: hourly. Old/past stored anchors do not exclude
  a saved watch from refreshing.
- Refresh claims are ordered, bounded to 24, locked and leased. Page/extraction
  results are shared only within that operation; wall budgets defer excess work.
- Earlier dates update the anchor and matching open commitment deadlines.
  Already-delivered stage dedupe keys remain delivered.
- Later dates preserve the old anchor, pause date reminders, record a candidate
  and create a separate reviewed approval. Approval rereads the page. A changed
  candidate invalidates the old review, including a queued YES.
- Failed reads pause opening-date reminders and retry hourly. They preserve a
  pending candidate, so a temporary outage does not lose its approval state.
- Change notices have their own dedupe identity and pending acknowledgement;
  partial two-parent delivery retries only the unsent copy.
- Each eligible unsent stage rereads the page using a separate reader, refreshes
  the state and recomputes the phase. Consent, STOP/quiet-hour gates and the
  current watch are checked again before each wire copy. An expired go phase
  does not send late.
- Reported waitlist-offer guards retain their separate clock. An unavailable
  registration opening does not silently stop them.
- The weekly verification sweep uses the shared evidence gate without treating
  hourly watch reads as weekly sweep runs.

## Storage and boundaries

`registration_windows` identifies known pages/cycles and remains compatibility
metadata; its dates do not become parent-facing truth without this operation's
verification. `registration_sequences` stores watches, observations, next-check
time, scheduling anchors, paused state, candidates and notice acknowledgement.
`actions` carries consent/review, `audit_log` carries before/after/source/evidence,
`agent_commitments` carries matching promise deadlines, `rate_limits` carries
expiring send leases, and `channel_messages` retains delivered-message dedupe.

The new fetch boundary rejects private/reserved addresses, mixed DNS answers,
credentials, non-HTTPS and redirects; it pins the validated DNS answer to the
socket and bounds response bytes/time. Unknown year, source zone, eligibility,
unsupported or insufficient evidence is held unverified, not inferred from DB.

## Verification

- Related web regression: 2,546 passed, 1 skipped, including PGlite migration,
  watch lifecycle, consent withdrawal, postponed-date confirmation, send leases,
  date-only behavior, waitlist independence and partial two-parent retry.
- Real extraction eval: 11/11, including US/UK source zones, date-only precision,
  unique weekday/year, stale-year and unpublished-date cases. Broken calibration
  is rejected. Cached replay makes zero API calls.
- Real Coach registration eval: 5/5; complete Coach cached corpus: 38/38.
  The one-to-one base Coach skill and model routes are unchanged; the live-truth
  extension is appended only for registration-related turns.
- Web/worker typechecks, DB build, web production build, scoped new-code lint
  (error level) and `git diff --check` pass.
- DB suite: 101 passed, 2 skipped. Markham public-page fetch smoke succeeded.
- Current content-addressed recordings remain in `apps/worker/evals/cache`.
  67 obsolete recordings created during iteration were moved, not deleted, to
  ignored `.local/vil-423-obsolete-evals` and are recoverable there.

Run from the repository root using the pinned pnpm launcher:

```sh
node .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web test lib/registration lib/channel/coach lib/channel/intake lib/channel/nudge lib/channel/rec-morning lib/channel/router lib/channel/reconcile
node .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web typecheck
node .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/worker typecheck
node .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web build
```

From `apps/worker`, replay real model recordings without API calls:

```sh
node evals/run-registration-verify-eval.mjs --cached-only
node evals/run-registration-verify-eval.mjs --broken --cached-only
node evals/run-coach-channel-eval.mjs --cached-only
```

## Not a release approval

Production still needs the additive `0161_registration_live_watch_storage.sql`
migration before this code is rolled out, plus explicit rollout authorization.
No production end-to-end SMS test was run. Public-page support is not universal:
redirects, login/JS-only pages or ambiguous source facts are deliberately held;
they pause date reminders rather than silently reusing the cached date. The
existing waitlist response-policy semantics were preserved, not redesigned.
