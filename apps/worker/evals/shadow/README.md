# Shadow-prompt eval (prod-truth A/B)

The offline evals (`run-eval.mjs` etc.) grade a prompt against **frozen cached fixtures**. That's necessary but not sufficient — a cached eval can pass while the prompt drifts on real inputs (the ISSUE-5 lesson: offline-green ≠ prod-true). A **shadow eval** closes that gap: it runs the current live prompt (**baseline**) and a proposed new version (**candidate**) over the *same* inputs, records only where they **disagree**, and — after enough disagreements — produces a switch recommendation. It never touches the live prompt; it only accumulates comparison data.

## What it is / isn't
- **Is:** a read-only A/B that tells you whether a candidate prompt is actually better on representative inputs, with the disagreements laid out so you can judge.
- **Isn't:** an auto-switcher. It writes a recommendation, never the live Langfuse prompt. (Green/read-only loop.)

## Rule #1 — non-negotiable
This runs on Hale prompts that can see family data. **It must never process raw newborn/family PII.** Two allowed input sources, in order of preference:
1. **Synthetic fixtures** (default) — hand-authored representative events, no real data. The scaffold ships with these.
2. **Redacted prod samples** — real event shapes with all PII stripped *before* the prompt runs (names, DOB, precise location → placeholders). Enabling this requires an explicit `--redacted-source` flag AND your sign-off; the redactor must be verified to fail-closed. Until that's built + reviewed, the runner refuses real traffic.

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
`run-shadow-eval.mjs` is a **scaffold**: the sampler, the prompt-pair loader, and the diff/judge harness are wired against **synthetic fixtures** so it runs end-to-end today. To point it at a real candidate prompt, fill the two marked seams (`loadPromptVersions`, `sampleInputs`) — and do not enable `--redacted-source` until the redactor is built and reviewed. Wire into CI only after a first manual run reads clean.
