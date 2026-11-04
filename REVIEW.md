# Review guide

Read by Devin Review and by every agent that reviews a pull request here. `CLAUDE.md` holds the full hard rules.

**Each rule below names the file that enforces it.** Read that file's comments before judging a change near it: the code is the source of truth, and this guide only says what to flag.

Hale is a planner that families with children in Canada and the US reach by SMS, iMessage and email. The parent opens the thread; Hale never texts first. The web app is the receipts surface. **This repository is public.**

## Critical: flag as severe

- **Teen and child data.** A child is a teen from 13, decided from the date of birth (`deriveStage` in `packages/types/src/stage.ts`). A teen's raw content reaches a parent only through the grant in `apps/web/lib/teen-access.ts`: teen-assented, logged, time-limited, and shown in the signed-in app only. The other route is a safety escalation in which the teen is notified. Flag:
  - any other way raw teen content reaches a parent, a group chat, an outbound message or a log;
  - a decision about who is a teen that doesn't come from the date of birth;
  - child content written without the child's id, since redaction keys on it.
- **STOP, opt-out and consent.** STOP and START are read by a model, the opt-out reader (`apps/web/lib/channel/intake/opt-out-reader.ts`). A read that fails twice becomes the opt-out hold (`opt-out-hold.ts`); there is no keyword fallback. The state is read three ways:
  - Whether a number is unsubscribed is decided by the number: `findRevokedChannelOwner` in `apps/web/lib/channel/intake/channel-state.ts`. Re-entry requires a current seat: `findReenrollableChannelOwner`.
  - A user's enrollment is the live channel row: `loadSmsChannelState` in `apps/web/lib/channels/sms-consent-core.ts`.
  - A consent scope is the latest ledger row, by `grantedAt` then id, with `granted = true` and `revokedAt` null: `apps/web/lib/channel/outbound-gate.ts`.

  Flag a sender or a channel or seat writer that skips these, a keyword STOP matcher, a check keyed on the wrong identity (user or number), and a consent read that accepts any granting row.
- **Autonomy, review and money.** `apps/worker/src/orchestrator/autonomy-gate.ts` sets the autonomy rules (the web pipeline keeps its own copy of the 7-day window in `apps/web/lib/pipeline/ingest.ts`):
  - a family is observe-only for its first 7 days;
  - an action type runs on its own only after 5 approvals of that type in a row;
  - booking, registration and paying never run on their own (`AUTONOMY_BY_KIND`).

  The Reviewer approves only when every check that `REQUIRED_CHECKS` (`packages/tools-contracts/src/index.ts`) lists for the action type ran and returned ok (`apps/worker/src/agents/reviewer.ts`). Any action with a cost passes a spending cap, and a cap is a hard limit. There are three caps:
  - the Reviewer's `check_spending_cap` (`apps/worker/src/tools/registry.ts`);
  - `checkSpendingCap` (`apps/web/lib/coach/guards.ts`, which the cron guard reuses);
  - `signupSpendingCap` for registration (`apps/web/lib/signup/run.ts`, up to `LINK_SPEND_CEILING_CENTS`).

  An action affecting both parents needs both parents (the co-parent hold, `coparent_ask` in `apps/web/lib/channel/outbound-gate.ts`). Every action path writes its own immutable `audit_log` row; there is no single seam.

  Flag any loosening of these: an action type whose `REQUIRED_CHECKS` entry is empty or drops a check, a cost path that reaches a wallet or executor without one of the caps, and a new action path that writes no audit row.
- **Group chats.** `apps/web/lib/channel/linq/group-audience.ts` decides what a group hears:
  - only the overlap of every member's role scope;
  - only the group content classes (schedule, pickup duty, event logistics). Health, registration, settings and suggestions stay 1:1, even in a chat of parents.

  A line with no class is refused, and a participant Hale cannot identify holds household lines. A direct reply (class `reply`) carries no household content and needs no other class. Today the check is armed by `LINQ_GROUP_ONBOARDING_V2_ENABLED`, which is on in prod; its flag-off bypass is being removed. Flag a group send that skips this check, omits its content class or widens the audience.
- **Personal data in a public repository.**
  - Logs and analytics events carry ids, counts and outcome names only.
  - Audit rows may also carry masked phones and reversal handles (provider event or message ids). They never carry raw phone numbers or message bodies. Two existing writers store a plan's title (`plan_created` in `apps/web/lib/plan/plan-core.ts`, `linq_group_plan_started` in `apps/web/lib/channel/linq/group-plan-rsvp/store.ts`); flag any new free-text title in an audit row.
  - PR bodies, commit messages, fixtures and recordings never carry real names, phone numbers, emails or real family or user ids. Use invented people; existing tests use fictional 555 numbers, and a new number should be 555-01xx.
- **Time and place.**
  - A family's local time comes from its own zone, derived from its postal or ZIP code (`apps/web/lib/channel/intake/postal-zone.ts`). Mapping an Ontario or Quebec code to `America/Toronto` there is geography, not a default.
  - Its place comes from its own rows: an active saved area, a stored city that matches the checked-in table, or the postal or ZIP area (`apps/web/lib/channel/off-domain/place.ts`).

  An unknown zone or place is a named outcome, never a Toronto, Eastern or GTA default. Older code still has such defaults while they are removed: flag any new one. DST and every US and Canadian zone matter.
- **Prompts.** Prompts and skills load by name, through the Langfuse sync (`apps/worker/scripts/sync-prompts.mjs`) or the skill seam (`packages/agent/skills`, whose lock file is drift-checked). An inline prompt string is a bug.
- **Untrusted text.** Some text is data, never instructions:
  - web pages, emails and calendar titles;
  - messages from anyone other than the household's own parents;
  - anything a parent forwards or pastes.

  Flag any place where such text steers a model's tools or reaches a send without a code-side check.
- **Destructive migrations.** Dropping a table or column, or narrowing a constraint, without an explicit flag and a deprecation cycle.

## Intended: don't flag these as bugs

- **No fixed parent-facing copy.** A model writes replies from facts the code supplies. A missing fallback sentence is intended: when the model fails, the turn holds and the failure is a named, logged outcome.
- **No keyword or regex reading of parent messages, STOP included.** Intent comes from model readings. Pattern checks on Hale's own outgoing text (a link gate, a number check) are fine.
- **No numeric send caps.** The model and the decider choose timing and volume. The code rails are intended: opt-out, quiet hours, same-item dedupe, provider rate limits and line health.
- **Absence is a first-class outcome.** A dependency that may be missing is logged and named in the return value (for example `skipped: 'not_configured'`). **Do** flag a silent no-op, or an absence folded into an outcome that means something else.
- **Fail closed.** When identity, audience, time zone, place or consent is unknown, Hale holds or asks instead of guessing.
- **Tests and models.** Model behaviour is tested with cached real recordings through the eval harness, never with mocked model output. The repo's convention allows a fake at a client port that tests request mechanics only and says so (for example `apps/web/lib/testing/kid-judge-client.ts`). **Do** flag a stub that stands in for the model's judgement.
- **Recorded decisions.** A limit that the PR body, a ticket or a comment records as a decision ("Known limitation", "Stated limit", a design ruling) is not a new bug. Flag it only when the stated limit is wrong or the code exceeds it. A recorded decision never exempts anything under Critical.
- **Migrations** are hand-written, additive SQL in `packages/db/drizzle`. A missing generated migration is intended.
- **Dark features.** Code behind a flag that is off is still reviewed; say in the finding that it is behind a flag.

## Ignore

- `apps/worker/evals/cache/**` and `apps/web/lib/__journey__/__recordings__/**`: recorded model output.
- `apps/web/lib/channel/off-domain/postal-cities/ca.json`, `postal-cities/us.json`, `apps/web/lib/channel/off-domain/public-suffix/suffixes.json` and `public-suffix/public_suffix_list.dat`: generated or vendored tables.
- `pnpm-lock.yaml`.

Not ignored, even though it looks like data:
- `apps/web/lib/channel/off-domain/postal-cities/coarsen.json` is the privacy allowlist of place names that may go to third-party search on a sensitive question. A small town moved onto it would reveal where a family lives.
- `apps/web/lib/channel/intake/postal-zone.ts` is hand-written logic.
