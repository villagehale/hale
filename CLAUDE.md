# CLAUDE.md — Hale project guidelines

Behavioral guidelines for AI collaborators working on this codebase. Inherits the user's global CLAUDE.md; this file adds Hale-specific rules.

## Project context

Hale is a **planner for your kids' year** (**Find what's on. Hear how it went.**) — an event-driven, multi-agent quiet operator for families raising children across every stage of childhood (0–18; beachhead toddler–preschool). Parents should never need another app: Hale lives in SMS and email, and **the parent opens the thread — Hale never texts first**, which is the promise the /text page makes in those words and the posture CASL is read against here. Today Hale recommends and prepares; completing a registration itself is roadmap (VIL-338 / VIL-339, Stripe plus execute) and is deliberately **not** part of the pitch. The web app is the receipts surface (approvals, audit, settings) rather than the daily one. The F14 decision register (D1–D25) fixes the choices that rest on: messaging-first surface, single-ask intake then just-in-time everything, the registration-and-coverage radar as the flagship job, scoped caregiver roles, privacy as the moat, natural-language consent, ICS-first calendar output, the dashboard demoted to receipts, and — D22 to D25 — the positioning above, asking only about what Hale actually saw, reviews and attendance as byproducts rather than a ratings product, and never-template meaning voice rather than generation. **Release is no longer one flag flip.** There are eight or more independent dark flags, each with its own probe and a staged lighting order; the current list and that order live in the Linear document "Product direction 2026-09-21". The [F14 · Messaging-First Operator](https://linear.app/villagehale/project/f14-messaging-first-operator-hale-is-a-number-you-text-ad65e88d5775) Linear project — its design documents, that register, and the per-feature briefs — is the design source of truth; read it before changing product behaviour, and treat the pre-pivot newborn-platform spec, the "family chief of staff" framing and the six 2026-07 design documents as history rather than direction (each of those six is annotated in Linear with what it now gets wrong). (Hale serves families in Canada and the US. Compliance baseline is PIPEDA/Law 25 for Canadian families plus the applicable US rules (including COPPA) for US families, per hard rule #1.)

## Hard rules (Hale-specific)

1. **Privacy first.** This product handles newborn data — among the most sensitive data possible. Default to most restrictive. PIPEDA + Quebec Law 25 + CASL compliance is non-negotiable. **Data residency:** Hale serves Canada and the US, so processing in a US region is acceptable (e.g. Browser Use Cloud's US region for authorized signup); a vendor outside Canada and the US still needs an explicit decision. Data minimization, encryption at rest and deletion windows apply wherever it runs. **Teen privacy (children 13+):** raw content is redacted from parents by default — only category/summary is surfaced. Raw-content access requires an explicit, logged, time-limited grant. Named exception: safety escalation, where the teen is notified.

2. **No inline prompts.** Langfuse is the authoring/versioning source of truth (traced). Runtime reads disk copies synced via `apps/worker/scripts/sync-prompts.mjs`, guarded by a CI drift-check gate against `apps/worker/prompts/.langfuse-lock.json` — not a hot-path fetch. Inline prompt strings remain forbidden; code loads prompts by name, never inline strings.

3. **Reviewer agent must invoke verification tools.** Never approve actions based on prose reasoning alone. This is a structural rule in the architecture, enforced by Reviewer's system prompt and code-level checks on `tool_results.length > 0` before accepting an `approve` verdict.

4. **No autonomous action without explicit user consent.** L3 autonomy unlocks only after explicit per-action-type approval (5-streak rule). New users default to L1 (observe only) for 7 days.

5. **Two-parent consent required** for actions affecting both parents' data. Single-parent households work, but cross-parent actions are blocked until co-parent signs up. **Teen assent** is additionally required before surfacing a 13+ child's content to a parent, except under the safety-escalation exception (rule #1).

6. **Every action produces an immutable audit_log row.** No exceptions. PIPEDA right-to-access depends on this.

7. **Spending caps are hard limits.** Reviewer must invoke `check_spending_cap` for any action with monetary cost. Cap exceeded → reject.

8. **No mocking the LLM in tests.** Use the Anthropic eval framework with real (cached) Claude responses for agent tests. Mocking masks prompt-engineering bugs.

9. **Migrations are additive in production.** No destructive schema changes without explicit feature flag and deprecation cycle.

10. **Never push to `main` or `production`.** Feature branches always. Hard-enforced via PreToolUse hook.

11. **An injected effect is required, or its absence is a first-class outcome.** Any dependency that sends, writes, enqueues, notifies or executes must be non-nullable — or, if it may genuinely be absent, its absence must be LOGGED and named in the return value (the channel adapters' `skipped: 'not_configured'`, the push channel's `disabled`, the dispatch's `channel_unavailable`). Never a silent no-op, and never folded into a bucket that means something else. Three of the eight P0s in the toddler audit were one shape — `transport: ChannelTransport | null` plus a result variant meaning "did the work, sent nothing" — so a caller that wants to compose without sending models that explicitly and visibly, not by withholding a dependency (VIL-262/267).

## Dec 1 launch hard rules

These sit on top of the Hale-specific hard rules above. If they conflict, this section wins. Only Barton's own quoted words approve a product or flag decision; record it in the Linear ticket.

1. **Every message a human receives is fully AI-composed from facts.** No templates, skeletons, code-assembled prefixes, or fallbacks. **If the model cannot write it, send nothing** (and page #ops). The only exception is the OTP login text. This covers parents, caregivers, co-parents, and anyone else Hale texts.
2. **No word lists, regex, or keyword matching to understand parent intent.** Use the model's meaning read. No character caps.
3. **Linq only, never Twilio.**
4. **No STOP or HELP** in messages or on the site.
5. **No Sunday week-ahead** (retired). Use only the night-before and 1-hour-before reminders.
6. **No referral program, no gift-a-year.**
7. **Report registration honestly:** say "registered" only after the provider's confirmation.
8. **Promo flags, Meta CAPI, payment flows A–F, and the weekly proactive cap stay off** until Barton says go in his own words.
9. **Never print secrets.** Never run tests or evals with Production secrets loaded (no Prod `DATABASE_URL`, `SUPABASE_*`, `STRIPE_*`, `LINQ_*`, or Production `ANTHROPIC_API_KEY`). Paid evals use `ANTHROPIC_API_KEY_TEST` only. Develop with `--cached-only` / `--dry`, one paid run per PR, re-record only failures, and put `Eval spend: $X.XX` in the PR body.
10. **Every new behavior ships behind a default-off flag** declared in `@hale/flags`, on only for the exact value `true`. No direct `process.env` flag reads. Test with the flag on and off.
11. **Never use GitHub stacked PRs.** Never push to `main`. Do not merge; Barton reviews and merges after `scripts/ci/merge-ready.mjs` says ready, one PR at a time.
12. **Group privacy:** say only what every member present may hear. Health and payment details only in DMs. One parent's inbox content is never shown to another parent.
13. Raising a guard-test allowlist is forbidden (counts only go down) unless Barton's own words are in the PR body. Prompts load through `loadPrompt`, never inline. New DB-query tests use pglite. If a migration is needed, pick the number with `pnpm db:next-migration` after fetching `origin/main`.

## Mac setup (Claude Code on a fresh clone)

- Clone `villagehale/hale`, check out the ticket's branch (or `main` for unstarted work), then `pnpm install`.
- Copy `.env.example` to `.env.local` and fill **local/dev values only**. Never load a Production env dump or `vercel env pull` from production into the shell that runs tests.
- Run only the tests you touched, one job at a time: `cd apps/web && pnpm exec vitest run --maxWorkers=1 <files>`. For web typecheck, use `NODE_OPTIONS=--max-old-space-size=8192`.
- Evals: `pnpm --filter @hale/worker eval:<name>` with `--cached-only` or `--dry` first. Do not record a paid eval unless Barton says so for that PR.

## Stack reminder

- Language: TypeScript 5.x strict
- Runtime: Node 22 LTS
- Web: Next.js 15 App Router
- LLM: raw `@anthropic-ai/sdk` (tool-forced JSON for structured output) — no Mastra / Vercel AI SDK (removed, R5); `@anthropic-ai/claude-agent-sdk` deferred (R1)
- DB: Postgres 16 (Supabase Toronto)
- ORM: Drizzle
- Queue: pg-boss
- Prompts: Langfuse (authoring source) → disk sync, drift-checked (see rule #2)
- Linting: Biome
- Testing: Vitest (runner) + Playwright
- Domain primitives in `@hale/types`: family-stage (`deriveStage`, boundaries `[12,48,156]` months) and entitlement tiers (`PlanTier` free/plus/family)

## Development workflow

Use the chain that **already exists** — do not spin up bespoke "factory" agents; they duplicate installed tooling and violate Simplicity First. For non-trivial feature work:

1. **Research** — `feature-dev:code-explorer` (read-only) maps the affected code first.
2. **Brief** — `feature-dev:code-architect` (read-only) writes the technical brief. → **Human gate: approve the brief** before any code is written.
3. **Build** — `superpowers:subagent-driven-development` under `test-driven-development` (red-before-green). Respect hard rule #2 (prompts via `loadPrompt`, never inline) and #8 (no LLM mocking — use the `eval-scaffold` skill).
4. **Verify** — the `verifier` agent (no write access, adversarial) checks impl-vs-spec, then `security-reviewer` for secrets/PII. Devin Review reviews only PRs that are ready for review, so open PRs ready, not as drafts. The verifier judges every unresolved Devin finding against the code and tests, and a PR does not merge while a confirmed red Devin finding is open. `REVIEW.md` tells Devin and other reviewers what to flag and what is intended.
5. **Review** — `superpowers:requesting-code-review`. → **Human gate: approve the PR.**

Reuse the locked spec (`docs/superpowers/specs/2026-05-26-hale-newborn-platform-design.md`) as the upstream product/UX/pricing ideation — never regenerate it.

**Work the real seams, not a frontend/backend folder split** (App Router colocates server + client per-file):

- `apps/web` ↔ `apps/worker` — process boundary (web enqueues, worker consumes).
- pg-boss `events.ingested` — the async contract between them.
- `packages/{db,types,tools-contracts}` — leaf packages both apps depend on.

On architectural drift (an agent built on a stale assumption), restart the session with the corrected assumption rather than patching forward.

## Branch convention

- `feat/<short-description>` for features
- `fix/<short-description>` for bugfixes
- `chore/<short-description>` for housekeeping
- Never edit on `main` or `production`

## Commit convention

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Stage files explicitly (no `git add -A`).
