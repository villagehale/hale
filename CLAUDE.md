# CLAUDE.md — Hearth project guidelines

Behavioral guidelines for AI collaborators working on this codebase. Inherits the user's global CLAUDE.md; this file adds Hearth-specific rules.

## Project context

Hearth is a passive, event-driven, multi-agent household AI assistant for families, across every stage of childhood (0–18). It began newborn-focused; the four-stage scope (newborn → toddler → child → teenager) is recorded in the rebuild addendum atop `docs/superpowers/specs/2026-05-26-haru-newborn-platform-design.md` — see that spec for the full design. (Compliance baseline is Canada — PIPEDA/Law 25 + data residency per hard rule #1; broadening to other regions is a deliberate multi-region decision, not an assumption.)

## Hard rules (Hearth-specific)

1. **Privacy first.** This product handles newborn data — among the most sensitive data possible. Default to most restrictive. PIPEDA + Quebec Law 25 + CASL compliance is non-negotiable. **Teen privacy (children 13+):** raw content is redacted from parents by default — only category/summary is surfaced. Raw-content access requires an explicit, logged, time-limited grant. Named exception: safety escalation, where the teen is notified.

2. **No inline prompts.** Langfuse is the authoring/versioning source of truth (traced). Runtime reads disk copies synced via `apps/worker/scripts/sync-prompts.mjs`, guarded by a CI drift-check gate against `apps/worker/prompts/.langfuse-lock.json` — not a hot-path fetch. Inline prompt strings remain forbidden; code loads prompts by name, never inline strings.

3. **Reviewer agent must invoke verification tools.** Never approve actions based on prose reasoning alone. This is a structural rule in the architecture, enforced by Reviewer's system prompt and code-level checks on `tool_results.length > 0` before accepting an `approve` verdict.

4. **No autonomous action without explicit user consent.** L3 autonomy unlocks only after explicit per-action-type approval (5-streak rule). New users default to L1 (observe only) for 7 days.

5. **Two-parent consent required** for actions affecting both parents' data. Single-parent households work, but cross-parent actions are blocked until co-parent signs up. **Teen assent** is additionally required before surfacing a 13+ child's content to a parent, except under the safety-escalation exception (rule #1).

6. **Every action produces an immutable audit_log row.** No exceptions. PIPEDA right-to-access depends on this.

7. **Spending caps are hard limits.** Reviewer must invoke `check_spending_cap` for any action with monetary cost. Cap exceeded → reject.

8. **No mocking the LLM in tests.** Use the Anthropic eval framework with real (cached) Claude responses for agent tests. Mocking masks prompt-engineering bugs.

9. **Migrations are additive in production.** No destructive schema changes without explicit feature flag and deprecation cycle.

10. **Never push to `main` or `production`.** Feature branches always. Hard-enforced via PreToolUse hook.

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
- Domain primitives in `@hearth/types`: family-stage (`deriveStage`, boundaries `[12,48,156]` months) and entitlement tiers (`PlanTier` free/plus/family)

## Development workflow

Use the chain that **already exists** — do not spin up bespoke "factory" agents; they duplicate installed tooling and violate Simplicity First. For non-trivial feature work:

1. **Research** — `feature-dev:code-explorer` (read-only) maps the affected code first.
2. **Brief** — `feature-dev:code-architect` (read-only) writes the technical brief. → **Human gate: approve the brief** before any code is written.
3. **Build** — `superpowers:subagent-driven-development` under `test-driven-development` (red-before-green). Respect hard rule #2 (prompts via `loadPrompt`, never inline) and #8 (no LLM mocking — use the `eval-scaffold` skill).
4. **Verify** — the `verifier` agent (no write access, adversarial) checks impl-vs-spec, then `security-reviewer` for secrets/PII.
5. **Review** — `superpowers:requesting-code-review`. → **Human gate: approve the PR.**

Reuse the locked spec (`docs/superpowers/specs/2026-05-26-haru-newborn-platform-design.md`) as the upstream product/UX/pricing ideation — never regenerate it.

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
