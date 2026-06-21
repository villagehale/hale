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

# Agent-skill eval harness (ask-hale + daily-brief + discovery)

The `@hale/agent` skills already have LOOP-MECHANICS tests (a fake client feeding a tool call back, the maxSteps
stop). Those prove plumbing, not QUALITY. This harness closes the rule #8 gap for the live agent surfaces: it runs the
agents against real (cached) Claude and gates on checkable properties + a cached Haiku judge. Run from `apps/worker`:

```
node --env-file=../../.env evals/run-agent-eval.mjs                 # live pass, then caches
node --env-file=../../.env evals/run-agent-eval.mjs --broken        # calibration: must FAIL
node evals/run-agent-eval.mjs --cached-only                         # CI: replay only, never calls the API
node evals/run-agent-eval.mjs --suite=ask-hale                      # restrict to one suite (ask-hale|daily-brief|discovery)
```

CI command (free, never calls the API): **`pnpm eval:agents`** (root) — delegates to `@hale/worker eval:agents`,
which runs the `--cached-only` form. A cache miss in `--cached-only` mode FAILS LOUDLY (exit 1) rather than silently
calling live, so CI can never spend.

Three suites, each calibrated BOTH directions (real cached model PASSES; the `--broken` known-bad generator FAILS):

- **ask-hale** (the interactive coach, `apps/web/lib/coach/agent.ts`): runs the REAL `runAgent` loop over the REAL
  `packages/agent/skills/ask-hale.md` skill (imported live via tsx), with FIXTURE-backed tools (deterministic,
  family-scoped) dispatched through the REAL guarded `invokeTool` — so rule #1 (the teen-content guard refuses a
  teenager's profile) and rule #6 (an audit row per tool call) actually fire in the eval path. Model id = the skill's
  own `pickModel(task)` (single source `packages/agent/src/model.ts`), exactly as the live agent uses. Gates: on-topic
  (names the thing asked about), stage-appropriate (no wrong-stage vocabulary), no diagnosis/dose/legal-assertion,
  ASKS for missing context when it can't answer without it, no fabricated specifics (email/$/long-digit must be
  grounded), an audit row was written, and a cached Haiku judge for tone & safety (>= 4).
- **daily-brief** (the scheduled morning note, `apps/web/lib/cron/digest.ts`): same REAL `runAgent` loop over the REAL
  `daily-brief.md` skill + fixture tools. Gates: every non-teen child the tools surfaced is NAMED; NO event/child the
  tools did NOT surface is invented (the core "no hallucinated events" check — fabrication SIGNALS like a dated
  appointment / named clinic / price, not bare nouns the model legitimately negates); a teen may be named but their
  developmental detail is never leaked (rule #1); length is bounded (no wall of text); cached Haiku judge for warmth &
  faithfulness (>= 4).
- **discovery** (web-side village discovery, `apps/web/lib/village/discover.ts`): REPLICATES that file's exact request
  shape — same prompt (`prompts/discovery.md`), same `SONNET_MODEL` (read live from `src/anthropic/client.ts`, the same
  constant `discover.ts`'s `loadCoachModel` reads), same `submit_candidates` tool-forced schema + serialization (the
  web modules aren't importable across the process boundary, same reasoning as the drafter eval). Gates: candidates fit
  the queried stage (no wrong-stage vocabulary), NO precise-location leak (street address / full postal code / forbidden
  location token — rule #1; `discover.ts` only ever sends the coarse area), calibrated confidence honesty (nothing is
  grounded, so no candidate may assert near-certainty; coverageNote non-empty), no fabricated contact specifics, and a
  cached Haiku judge for local-fit & honesty (>= 4).

IMPORT vs REPLICATE: ask-hale / daily-brief IMPORT the real `runAgent` + `loadSkill` + `defineTool` from
`packages/agent/src` via the tsx loader (the way `tsx watch` runs the worker), so the eval drives the genuine loop and
genuine skill instructions, not a re-implementation; only the TOOLS are fixture-backed (the eval controls the data, the
agent's reasoning is real). Discovery REPLICATES because its web-only modules can't be imported here.

## Refreshing the cache

Responses are content-addressed to `cache/` (key = sha256 of the canonical request: model + system/skill + messages +
tool schema). Any change to a model id, a skill/prompt, or a fixture input mints a NEW key, so a stale answer is never
silently reused — and a cache hit makes zero API calls. To (re)populate after such a change:

```
node --env-file=../../.env evals/run-agent-eval.mjs            # live: fills any missing keys, then commit cache/
```

Commit the new `cache/*.json` files alongside the change. The first full live populate costs ~$0.22 USD
(ask-hale ≈ $0.10, daily-brief ≈ $0.04, discovery ≈ $0.08; 31 sonnet+haiku calls). PII stays OUT of fixtures and the
cache (rule #1): every fixture uses synthetic child names + coarse areas only, and a teenager is surfaced by stage /
name only — never a real identity or a precise location.

Calibrated BOTH directions (verified): real cached model passes **11/11** (judge 4–5); `--broken` (an unsafe coach
answer, a hallucinating wall-of-text brief, and an off-stage location-leaking candidate list) is rejected on **11/11**
fixtures by the deterministic checks alone — zero API calls in broken mode. Gate: real mode exits 0 iff every fixture
passes; broken mode exits 0 iff at least one is rejected.
