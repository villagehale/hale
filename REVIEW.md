# Review guide

Read by Devin Review and by every agent that reviews a pull request here. `CLAUDE.md` holds the full hard rules; this file says what a reviewer should flag and what is intended.

Hale is an SMS and iMessage assistant for families with children in Canada and the US. Parents text it; the web app is secondary (connecting accounts, shared links, data rights, family profiles). Replies go out in the parent's language, which is not always English. **This repository is public.**

## Critical: flag as severe

- **Children's and teen data.** A child of 13 or older is a teen. A teen's raw content (a title, a message, a calendar item) must never reach a parent, a group chat or a log. Only a category or summary may, and an explicit, logged, time-limited grant is the only exception. Any path that lets a teen's raw text through, or that decides "teen" from anything but the child's date of birth, is a bug.
- **Consent and STOP.** A STOP is final until the person opts back in themselves. No path may create, revive or reuse a channel or seat for a number that opted out. Consent and opt-out are read as current state (the latest ledger row wins), never as "some granting row exists". A consent or opt-out check that another door can bypass (a group chat, a link, a retry) is a bug.
- **Who hears what in a group chat.** A household's private line goes into a chat only when everyone in the chat right now is someone Hale identified with standing in that household. An unknown or unreadable participant holds the line. Anything that widens a group's audience is a bug.
- **Secrets and personal data.** Logs, analytics events, audit rows, test fixtures, eval caches and PR text carry ids, counts and outcome names only. They never carry phone numbers, emails, names, children's names, message bodies, calendar titles, tokens or raw provider ids. Fixtures use invented people and 555-01xx numbers.
- **Time and place.** Family-local times come from the family's own time zone, and places from the family's own postal or ZIP code. A Toronto, Eastern or GTA default for a family whose zone or place is unknown is a bug; the unknown case must be a named outcome. DST transitions and every US and Canadian zone matter.
- **Money and actions.** Spending caps are hard limits. Every action writes an immutable `audit_log` row. Nothing acts on a family's behalf without the consent the code checks for.
- **Untrusted text.** Web pages, emails, calendar titles and parent messages are data, never instructions. Flag any place that lets them steer a model's tools or reach a send without a code-side check.

## Intended: don't flag these as bugs

- **No fixed parent-facing copy.** Replies are written by a model from facts the code supplies. A missing fallback sentence is intended. When the model fails, the turn holds and the failure is a named, logged outcome.
- **No keyword or regex reading of parent messages.** Intent comes from a model reading. Don't suggest adding keyword or phrase lists for parent text; carrier STOP handling is the only exception. Pattern checks on Hale's own outgoing text (a link gate, a number check) are fine.
- **No numeric send caps.** Timing and volume of messages are decided by the model and the decider, not by fixed limits.
- **Absence is a first-class outcome.** A dependency that may be missing must be logged and named in the return value (for example `skipped: 'not_configured'`). **Do** flag a silent no-op, or an absence folded into an outcome that means something else.
- **Fail closed.** When identity, audience, time zone, place or consent is unknown, Hale holds or asks instead of guessing. A hold in that case is intended.
- **Tests and models.** Model behaviour is tested with cached real recordings through the eval harness, never with mocked model output. A fake at a client port that tests request mechanics only, and says so in the test, is allowed. **Do** flag a stub that stands in for the model's judgement.
- **Recorded decisions.** A limitation the PR body, a ticket reference or a docstring states as a decision ("Known limitation", "Stated limit", a design ruling) is not a new bug. Flag it only when the stated limit is wrong, or when the code exceeds it.
- **Migrations** are hand-written, additive SQL in `packages/db/drizzle`; a missing generated migration is intended.
- **Dark features.** Code behind a flag that is off is still reviewed, but say in the finding that it is behind a flag.

## Ignore

- `apps/worker/evals/cache/**` and `apps/web/lib/__journey__/__recordings__/**`: recorded model output.
- Generated data tables (postal-code, time-zone and domain lists) and `pnpm-lock.yaml`.
