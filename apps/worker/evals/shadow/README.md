# Shadow-prompt eval (prod-truth A/B)

The offline evals (`run-eval.mjs` etc.) grade a prompt against **frozen cached fixtures**. That's necessary but not sufficient — a cached eval can pass while the prompt drifts on real inputs (the ISSUE-5 lesson: offline-green ≠ prod-true). A **shadow eval** closes that gap: it runs the current live prompt (**baseline**) and a proposed new version (**candidate**) over the *same* inputs, records only where they **disagree**, and — after enough disagreements — produces a switch recommendation. It never touches the live prompt; it only accumulates comparison data.

## What it is / isn't
- **Is:** a read-only A/B that tells you whether a candidate prompt is actually better on representative inputs, with the disagreements laid out so you can judge.
- **Isn't:** an auto-switcher. It writes a recommendation, never the live Langfuse prompt. (Green/read-only loop.)

## Rule #1 — non-negotiable
This runs on Hale prompts that can see family data. **It must never process raw newborn/family PII.** Two allowed input sources, in order of preference:
1. **Synthetic fixtures** (default) — hand-authored representative events, no real data. The scaffold ships with these.
2. **Redacted prod samples** — real event shapes with all PII stripped *before* the prompt runs. The **fail-closed redactor is built** (`apps/worker/src/redaction/redact.ts`, unit-tested): every input is redacted (names/DOB/postal/email/phone → placeholders) and `assertNoPII` **drops** any input where PII survives — wired on the always-on path. What's still a stub is the real-traffic *sampler* (SEAM 2); wire that + get sign-off to point it at prod.

## How it works
1. Sample `N` inputs (half edge-cases, half high-frequency shapes).
2. Run `baseline` and `candidate` prompt versions on each (real model call, cached — same content-addressed cache as the other evals, so a re-run is free).
3. Keep only **disagreements** (outputs that differ materially); skip matches.
4. For each disagreement, a judge (cheap tier) labels: which is better, why, and whether the candidate is more *consistent*.
5. After `TARGET` disagreements (or a day/iteration cap), emit a **switch recommendation**: candidate win/tie/loss ratio, the typical disagreement shapes, and a risk assessment.

## The loop (per loop-mode)
- **State file:** `shadow-STATE.md` — baseline version, candidate version, accumulated disagreements, current conclusion.
- **Stop:** `TARGET` disagreements (default 50) or 14 days.
- **Color:** 🟢 green — read-only + writes a state file, never mutates the live prompt.
- **Model tiering:** the two prompt runs use the prompt's own tier (via `pickModel`); the judge is cheap (Haiku).

## Status
`run-shadow-eval.mjs` runs end-to-end against **synthetic fixtures**, with the fail-closed redactor wired on the always-on input path (`redact.ts` + `assertNoPII`). To point it at real work, fill the two marked seams: `loadPromptVersions` (baseline vs candidate Langfuse versions) and `sampleInputs` (a real, redacted traffic sampler). The redactor makes the input path safe; the sampler is the remaining piece + needs your sign-off. Wire into CI only after a first manual run reads clean.
