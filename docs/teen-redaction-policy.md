# Teen-redaction policy (13+) — canonical

**Status:** approved 2026-07-03. This is the single source of truth for how a 13+ child's data is treated across every surface. Implements hard rule #1; the redaction gate is deterministic + age-based (`deriveStage`), never the classifier flag. Wave 2 sweeps every surface to this policy.

## The five principles

1. **Redact the teen's own *content*, not their *identity*.** Raw content authored *by the teen* (their messages, the raw details of what they shared) is hidden from parents by default — only category/summary is surfaced. But the teen's **name is shown**: the parent entered it, the parent knows their own child's name. Hiding it (`"your teen"` everywhere) protects nothing and breaks UX — two teens must never render as two identical `"your teen"` chips.

2. **Parent-authored content is exempt.** A parent's *own* observation, quick-log, or plan *about* their teen is the parent's data, not the teen's private content — it is never redacted from that parent. (Fixes the companion black hole: a parent logs something about their 15-year-old, gets a "kept" confirmation, and it is then silently dropped.)

3. **Locked card is the standard treatment — never a silent drop.** When the teen's own content is redacted, show a **locked placeholder** ("something was logged — content is private") so the parent knows it exists and the loop is honest. Never make redacted items silently vanish, and never make them un-decidable where a decision is required (approvals).

4. **Raw-content access is an explicit, logged, time-limited grant with teen notification.** Where a parent genuinely needs the raw content, provide a **request-access affordance**: the grant is explicit, written to the audit log, time-limited, and **the teen is notified**. This is hard rule #1's named grant path.

5. **Safety escalation is the exception.** On a safety escalation, the teen's content is surfaced to the parent — and the teen is notified. (Rule #1's named exception.)

## Per-surface implications (the Wave-2 sweep)

- **Companion:** mark parent-authored quick-log episodes at write time; exempt them from `dropTeenEpisodes`. Today *all* unattributed episodes also vanish for any family with a teen — fix the attribution so a parent's own logs survive.
- **Plan:** teen items **count toward `hasPlan`** and render **one locked line** ("a plan for your teen — private") instead of being hidden entirely or double-printing the placeholder.
- **Ask / Plan / Home:** child **names** on scope chips and tags (principle 1) — never two identical `"your teen"` chips.
- **Approvals:** de-duplicate the placeholder and add the **request-access path** so a redacted row is still decidable (or clearly deferred), not a decision on invisible content.
- **Trail:** carries the teen-safe child label (`scopeChildren`) — name shown, content summary only.

## Invariant

Redaction is age-derived (`deriveStage(dob) === 'teenager'`) at the write+surface boundary — a backstop independent of the classifier. See memory `teen-safety-deterministic-age-gate`.
