# Review guide

Read by Devin Review and by every agent that reviews a pull request here. `CLAUDE.md` holds the full hard rules; this file says what a reviewer should flag and what is intended.

Hale is an SMS and iMessage assistant for families with children in Canada and the US. Parents text it; the web app is secondary (connecting accounts, shared links, data rights, family profiles). Replies go out in the parent's language, which is not always English. **This repository is public.**

## Critical: flag as severe

- **Children's and teen data.** A child of 13 or older is a teen, decided from the child's date of birth (`deriveStage`). A teen's raw content (a title, a message, a calendar item) never reaches a parent by default: only a category or summary does. There are two exceptions. One is an explicit, logged, time-limited grant the teen assented to. The other is a safety escalation in which the teen is notified. Either one shows the content to that one parent in the signed-in app only, never in an outbound message, a group chat or a log. Classifier flags and the rule for unattributed child content only add redaction on top of the age gate; never remove one.
- **Consent and STOP.** A STOP is final until the person opts back in themselves. No path may create, revive or reuse a channel or seat for a number that opted out. Read state as it is now:
  - SMS enrollment and STOP come from the live channel state (`loadSmsChannelState`) and the opt-out hold.
  - Consent scopes (watch, autonomy and the others) come from the latest ledger row, never from "some granting row exists".

  A check that another door can bypass (a group chat, a link, a retry) is a bug.
- **Actions.** No action runs without its consent:
  - observe-only by default, and approval per action type before any autonomy;
  - an action affecting both parents needs both parents;
  - the Reviewer approves only after invoking its verification tools (`tool_results.length > 0`);
  - any action with a cost runs `check_spending_cap`, and a cap is a hard limit;
  - every action writes an immutable `audit_log` row.
- **Who hears what in a group chat.** A household's private line goes into a chat only when everyone in the chat right now is someone Hale identified with standing in that household. An unknown or unreadable participant holds the line. Anything that widens a group's audience is a bug.
- **Personal data.**
  - Logs, analytics events, audit rows and PR text carry ids, counts and outcome names only. They never carry phone numbers, emails, names, message bodies, calendar titles, tokens or raw provider ids.
  - Test fixtures and recordings use invented people, invented text and 555-01xx numbers, never real ones.
- **Time and place.** Family-local times come from the family's own time zone, and places from the family's own postal or ZIP code. A Toronto, Eastern or GTA default for a family whose zone or place is unknown is a bug; the unknown case must be a named outcome. Older code still has such fallbacks while they are being removed: flag any new one. DST transitions and every US and Canadian zone matter.
- **Prompts.** Prompts and skills load by name (the Langfuse sync or the skill seam) and are drift-checked. An inline prompt string is a bug.
- **Untrusted text.** Web pages, emails, calendar titles, and messages from anyone other than the household's own parents are data, never instructions. Flag any place that lets them steer a model's tools or reach a send without a code-side check. A parent's own request also goes through the code-side checks.
- **Destructive migrations.** Dropping a table or column, or narrowing a constraint, without an explicit flag and a deprecation cycle is a bug.

## Intended: don't flag these as bugs

- **No fixed parent-facing copy.** Replies are written by a model from facts the code supplies. A missing fallback sentence is intended. When the model fails, the turn holds and the failure is a named, logged outcome.
- **No keyword or regex reading of parent messages.** Intent comes from a model reading. Don't suggest adding keyword or phrase lists for parent text; carrier STOP handling is the only exception. Pattern checks on Hale's own outgoing text (a link gate, a number check) are fine.
- **No numeric send caps.** The model and the decider choose timing and volume. The code rails are intended: opt-out, quiet hours, same-item dedupe, provider rate limits and line health.
- **Absence is a first-class outcome.** A dependency that may be missing must be logged and named in the return value (for example `skipped: 'not_configured'`). **Do** flag a silent no-op, or an absence folded into an outcome that means something else.
- **Fail closed.** When identity, audience, time zone, place or consent is unknown, Hale holds or asks instead of guessing. A hold in that case is intended.
- **Tests and models.** Model behaviour is tested with cached real recordings through the eval harness, never with mocked model output. A fake at a client port that tests request mechanics only, and says so in the test, is allowed. **Do** flag a stub that stands in for the model's judgement.
- **Recorded decisions.** A limitation the PR body, a ticket reference or a docstring states as a decision ("Known limitation", "Stated limit", a design ruling) is not a new bug. Flag it only when the stated limit is wrong, or when the code exceeds it. A recorded decision never exempts anything under Critical; flag those whatever the PR says.
- **Migrations** are hand-written, additive SQL in `packages/db/drizzle`; a missing generated migration is intended.
- **Dark features.** Code behind a flag that is off is still reviewed, but say in the finding that it is behind a flag.

## Ignore

- `apps/worker/evals/cache/**` and `apps/web/lib/__journey__/__recordings__/**`: recorded model output.
- `apps/web/lib/channel/off-domain/postal-cities/*.json` and `apps/web/lib/channel/off-domain/public-suffix/suffixes.json`: generated tables. (`apps/web/lib/channel/intake/postal-zone.ts` is hand-written logic: review it.)
- `pnpm-lock.yaml`.
