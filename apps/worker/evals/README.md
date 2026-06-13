# Classifier eval harness (B12)

Run from the repo root (the harness reads `ANTHROPIC_API_KEY` from `--env-file`):

```
node --env-file=.env apps/worker/evals/run-eval.mjs                 # scored set
node --env-file=.env apps/worker/evals/run-eval.mjs --include-holdout
node apps/worker/evals/run-eval.mjs --classifier=broken             # gate-fails-on-purpose calibration
```

Responses are content-addressed to `cache/` (key = sha256 of model + prompt + fixture input); a cache hit
makes zero API calls, so re-runs are free. The first run over uncached fixtures makes one live haiku call each.
Gate: exit 0 iff event_type accuracy >= 85% on the scored set AND every calibration case (`expect.maxConfidence`)
stays below the orchestrator's autonomy threshold (read live from `src/orchestrator/index.ts`). It REPLICATES the
classifier request shape rather than importing the stale `dist/`; see the header of `run-eval.mjs` for why.

# Drafter eval harness (review finding #14)

The drafter is the only agent whose text a family actually receives, so it gets its own eval:

```
node --env-file=.env apps/worker/evals/run-drafter-eval.mjs                 # live pass, then caches
node --env-file=.env apps/worker/evals/run-drafter-eval.mjs --drafter=broken # calibration: must FAIL
node apps/worker/evals/run-drafter-eval.mjs --cached-only                   # CI: replay only, never calls the API
```

Same cache + replicate-not-import design as the classifier (it mirrors the `draft_action` request shape, reading
`SONNET_MODEL`/`HAIKU_MODEL` live from `src/anthropic/client.ts`). Draft text is open-ended, so the gate is on
CHECKABLE properties, not exact strings:

- deterministic, every fixture: no placeholder tokens (`[NAME]`, `{{…}}`, `TODO`, `<name>`), within `maxBodyChars`,
  no ungrounded specifics (an email/amount/long-digit token in the draft must appear verbatim in the input — a
  cheap hallucination check), required structural fields present, and the recipient echoed (`recipientEchoOf`).
- LLM-as-judge (cached, real haiku): tone & appropriateness scored 1–5, must be >= 4. Scoped to outbound prose
  (the email-type actions); `add_to_digest_only` is internal structured data, not a message, so it sets
  `judgeTone:false` and relies on the deterministic battery (a recipient-tone rubric would be a category error there).

Calibrated BOTH directions: the real cached model passes 10/10; the `--drafter=broken` stand-in (placeholder-laden,
oversized, recipient-dropping, ungrounded) is rejected on every fixture by the deterministic checks alone (no API
call). Gate: real mode exits 0 iff every fixture passes; broken mode exits 0 iff at least one fixture is rejected.
