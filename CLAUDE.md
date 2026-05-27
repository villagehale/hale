# CLAUDE.md — Mira project guidelines

Behavioral guidelines for AI collaborators working on this codebase. Inherits the user's global CLAUDE.md; this file adds Mira-specific rules.

## Project context

Mira is a passive, event-driven, multi-agent AI product for newborn families in Canada. See `docs/superpowers/specs/2026-05-26-mira-newborn-platform-design.md` for the full spec.

## Hard rules (Mira-specific)

1. **Privacy first.** This product handles newborn data — among the most sensitive data possible. Default to most restrictive. PIPEDA + Quebec Law 25 + CASL compliance is non-negotiable.

2. **No inline prompts.** All LLM prompts live in Langfuse (versioned, traced). Code references prompt IDs, never inline strings. Same rule as `my.tripfix.ca`.

3. **Reviewer agent must invoke verification tools.** Never approve actions based on prose reasoning alone. This is a structural rule in the architecture, enforced by Reviewer's system prompt and code-level checks on `tool_results.length > 0` before accepting an `approve` verdict.

4. **No autonomous action without explicit user consent.** L3 autonomy unlocks only after explicit per-action-type approval (5-streak rule). New users default to L1 (observe only) for 7 days.

5. **Two-parent consent required** for actions affecting both parents' data. Single-parent households work, but cross-parent actions are blocked until co-parent signs up.

6. **Every action produces an immutable audit_log row.** No exceptions. PIPEDA right-to-access depends on this.

7. **Spending caps are hard limits.** Reviewer must invoke `check_spending_cap` for any action with monetary cost. Cap exceeded → reject.

8. **No mocking the LLM in tests.** Use the Anthropic eval framework with real (cached) Claude responses for agent tests. Mocking masks prompt-engineering bugs.

9. **Migrations are additive in production.** No destructive schema changes without explicit feature flag and deprecation cycle.

10. **Never push to `main` or `production`.** Feature branches always. Hard-enforced via PreToolUse hook.

## Stack reminder

- Language: TypeScript 5.x strict
- Runtime: Node 22 LTS
- Web: Next.js 15 App Router
- Agent SDK: `@anthropic-ai/claude-agent-sdk`
- DB: Postgres 16 (Supabase Toronto)
- ORM: Drizzle
- Queue: pg-boss
- Prompts: Langfuse
- Linting: Biome
- Testing: Vitest + Playwright

## Branch convention

- `feat/<short-description>` for features
- `fix/<short-description>` for bugfixes
- `chore/<short-description>` for housekeeping
- Never edit on `main` or `production`

## Commit convention

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Stage files explicitly (no `git add -A`).
