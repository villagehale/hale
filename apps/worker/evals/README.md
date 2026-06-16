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

# Village eval harness (discovery + routine)

The village feature has two agents with very different testability, so the harness scores them differently.
Run from the worker package dir (`apps/worker`):

```
node --env-file=../../.env evals/run-village-eval.mjs                 # live pass, then caches
node --env-file=../../.env evals/run-village-eval.mjs --routine=broken # calibration: must FAIL
node evals/run-village-eval.mjs --cached-only                         # CI: replay only, never calls the API
```

- ROUTINE (the novel reasoning): REPLICATES the `runRoutine` request shape — same prompt (`prompts/routine.md`),
  same model (`SONNET_MODEL` read live from `src/anthropic/client.ts`), same `submit_routine` tool-forced schema
  and serialization. Per fixture (a family stage + a candidate set), deterministic checks gate that every proposed
  item references a PROVIDED candidate, is not drawn from an off-stage candidate, carries the candidate's confidence
  through unchanged, and keeps the week light (item-count bound); a cached Haiku judge then scores stage-fit 1–5
  (must be >= 4). Cache + replicate-not-import design identical to the classifier/drafter (the stale `dist/` still
  references the removed Mastra layer).
- DISCOVERY (the Fake floor): the REAL `FakeDiscoveryProvider` is the subject, imported live from
  `src/agents/discovery-providers/fake.ts` via the tsx loader (never the stale dist; copying its SEED table would be
  a second source of truth). A reference-recall check confirms the curated items a stage/interest query should
  surface do surface, the ranking holds, and `source`/`confidence`/`coverageNote`/`areaCoarse` are honest (rule #1:
  no `sourceUrl` finer than the coarse area). Zero spend — no model, no key needed for this half.

Calibrated BOTH directions: the real cached model must pass every fixture; the `--routine=broken` stand-in (an
invented, off-stage, confidence-inflated item) is rejected on every routine fixture by the deterministic checks alone
(no API call), while the deterministic discovery fixtures still pass. Gate: real mode exits 0 iff every fixture
passes; broken mode exits 0 iff at least one is rejected. Token usage per keyed call is logged as the budget instrument.
