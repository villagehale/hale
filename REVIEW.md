# Review guide

Read by Devin Review and by every agent that reviews a pull request here.

**What is severe: the hard rules in `CLAUDE.md`.** Read them before reviewing:
- privacy and teen data;
- consent before any autonomous action;
- two-parent consent;
- the immutable audit row;
- spending caps;
- additive migrations;
- prompts loaded by name;
- named outcomes for an absent dependency.

Treat as severe any change that weakens one of them, and any new path that bypasses the code enforcing one. The code's own comments say how each rule is enforced. **This repository is public:** flag any real name, phone number, email or id in code, fixtures, PR text or commit messages.

## Intended: don't flag these as bugs

- **No fixed parent-facing copy.** A model writes replies from facts the code supplies. A missing fallback sentence is intended: when the model fails, the turn holds and the failure is a named, logged outcome.
- **No keyword or regex reading of parent messages, STOP included.** Intent comes from model readings. Pattern checks on Hale's own outgoing text (a link gate, a number check) are fine.
- **No numeric send caps.** The model and the decider choose timing and volume. The code rails are intended: opt-out, quiet hours, same-item dedupe, provider rate limits and line health.
- **Absence is a first-class outcome.** A dependency that may be missing is logged and named in the return value (for example `skipped: 'not_configured'`). **Do** flag a silent no-op, or an absence folded into an outcome that means something else.
- **Fail closed.** When identity, audience, time zone, place or consent is unknown, Hale holds or asks instead of guessing.
- **Tests and models.** Model behaviour is tested with cached real recordings through the eval harness, never with mocked model output. The repo's convention allows a fake at a client port that tests request mechanics only and says so (for example `apps/web/lib/testing/kid-judge-client.ts`). **Do** flag a stub that stands in for the model's judgement.
- **Recorded decisions.** A limit that the PR body, a ticket or a comment records as a decision ("Known limitation", "Stated limit", a design ruling) is not a new bug. Flag it only when the stated limit is wrong or the code exceeds it. A recorded decision never exempts a hard rule.
- **Migrations** are hand-written, additive SQL in `packages/db/drizzle`. A missing *generated* migration is intended. A schema change without its hand-written SQL is a bug.
- **Dark features.** Code behind a flag that is off is still reviewed; say in the finding that it is behind a flag.

## Ignore

- `apps/worker/evals/cache/**` and `apps/web/lib/__journey__/__recordings__/**`: recorded model output.
- `apps/web/lib/channel/off-domain/postal-cities/ca.json`, `postal-cities/us.json`, `apps/web/lib/channel/off-domain/public-suffix/suffixes.json` and `public-suffix/public_suffix_list.dat`: generated or vendored tables.
- `pnpm-lock.yaml`.

Not ignored, even though it looks like data:
- `apps/web/lib/channel/off-domain/postal-cities/coarsen.json` is the privacy allowlist of place names that may go to third-party search on a sensitive question. A small town moved onto it would reveal where a family lives.
- `apps/web/lib/channel/intake/postal-zone.ts` is hand-written logic.
