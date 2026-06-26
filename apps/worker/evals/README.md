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

# VIL-143 launch evals (memory-cost curve + model-per-role matrix)

Two evals that answer the launch questions the per-agent evals above don't: (1) does the coach stay cheap + accurate as
a family's memory grows, and (2) which Claude model is right per agent role. Both make REAL (cached) Claude calls and
share `evals/lib/` (a seeded long-history simulator + the cache/judge/cost primitives). CI runs the combined gate free:

```
pnpm eval:vil143                                              # root: cached-only + calibration, one exit code
node --env-file=../../.env evals/run-memory-cost-eval.mjs     # live: populate the cost-curve cache
node --env-file=../../.env evals/run-model-matrix-eval.mjs    # live: populate the matrix cache
node evals/run-memory-cost-eval.mjs --cached-only             # CI replay (never calls the API)
node evals/run-memory-cost-eval.mjs --broken                  # calibration: a memory-blind coach must be REJECTED
node evals/run-model-matrix-eval.mjs --cached-only            # CI replay
node evals/run-model-matrix-eval.mjs --broken                 # calibration: a uniformly-failing matrix must be REJECTED
```

## 1. Cost + accuracy as memory grows (`run-memory-cost-eval.mjs`)

The architecture's bet is the BOUNDED `memory_slice` (`apps/web/lib/coach/context.ts`: currently-valid facts capped at
`RELEVANT_FACT_LIMIT` + the newest `RECENT_EPISODE_LIMIT` episodes — the coach never reads the raw log). The eval pits
it against the naive alternative (DUMP every fact + episode) across small/medium/large synthetic history (a child
0→3yr: 4/6/6 facts, 12/92/290 episodes). It runs the REAL `runAgent` ask-hale loop (imported via tsx) for both arms —
the ONLY difference is the memory the context + `search_memory` carry — and measures per arm: input tokens, latency,
fact-store recall, episode-store recall, and a cached Haiku faithfulness judge. Reference Q&A is derived FROM the
generated facts (`evals/lib/synth-family.mjs`), never from model output.

Result (live, claude-sonnet-4-6 coach + haiku judge):

| size   | arm     | in_tok | latency | fact_recall | episode_recall | judge |
|--------|---------|--------|---------|-------------|----------------|-------|
| small  | bounded | 2866   | 5997ms  | 92%         | n/a            | 5.0   |
| small  | dump    | 3026   | 7925ms  | 92%         | n/a            | 5.0   |
| medium | bounded | 3024   | 7548ms  | 94%         | 0%             | 4.0   |
| medium | dump    | 9420   | 6561ms  | 94%         | 100%           | 4.8   |
| large  | bounded | 3012   | 7933ms  | 94%         | 0%             | 4.0   |
| large  | dump    | 24848  | 7469ms  | 94%         | 100%           | 4.9   |

Input-token growth small→large: **bounded 1.05x** (flat), **dump 8.21x** (linear in history). The bounded slice keeps
the coach cheap as memory grows and holds fact recall at 92–94% (the fact store is consolidated, so it fits the slice
at every size). The DOCUMENTED TRADEOFF (reported, not gated): the recency-only bounded slice loses OLD episodes a dump
retains (episode recall 0% vs 100% at medium/large) — the price of bounding. Gate: bounded fact-recall ≥ 80% + judge
≥ 4 at every size AND bounded token-growth ≤ 1.5x. The episode loss is NOT gated (the slice is recency-only by design;
gating it would gate the architecture out). Calibrated BOTH directions: real cached coach PASSES; `--broken` (a
memory-blind coach that recalls nothing) collapses fact recall and is REJECTED with zero API calls.

## 2. Model per role (`run-model-matrix-eval.mjs`)

Runs the SAME representative inputs for each role (classify / draft / review / coach) across `claude-haiku-4-5`,
`claude-sonnet-4-6`, `claude-opus-4-8`, scoring quality (reference + judge), latency, cost. Each role REPLICATES its
real request shape (same prompt from `prompts/*.md` or the `ask-hale` skill, same tool-forced schema) with `model` the
only variable — the same replicate-not-import discipline the other evals use. REVIEW is scored on the single-turn
VERDICT with the verification `tool_results` supplied (the judgment model tier affects), on the SAFETY DIRECTION: for a
clean draft `approve`/`flag_for_human` both pass, for a violating draft `reject`/`flag_for_human` both pass — the
reviewer prompt's "default to flag under ambiguity" makes conservative escalation correct, not a miss.

Result (live):

| role     | haiku       | sonnet      | opus        | current | recommend |
|----------|-------------|-------------|-------------|---------|-----------|
| classify | 88% (teen 0%) 2446ms | 100% (teen 100%) 4606ms | 100% 3389ms | haiku | **sonnet** (teen-content detection — rule #1) |
| draft    | 67% 2031ms  | 100% 4777ms | 100% 3970ms | sonnet  | sonnet (well-placed) |
| review   | 100% 1821ms | 100% 7176ms | 100% 4872ms | sonnet  | haiku ties + 4x faster (safety-critical → advisory) |
| coach    | 100% 3049ms | 98% 5207ms  | 100% 5114ms | sonnet  | haiku ties + ~2s faster (cuts the 11–17s coach latency) |

Headline findings: **classify on Haiku misses teen-content detection (0% vs 100% on Sonnet/Opus)** — a rule-#1 safety
gap that argues for Sonnet on the teen-content path even though Haiku is cheapest. **Coach holds quality on Haiku** at
~half Sonnet's latency, the cheapest win against today's 11–17s coach. Gate: a COMPETENCE FLOOR (current tier ≥ 70%
quality per role), not "current == single best" — on a small per-role set one disagreement is 12–20%, so a top-model
gate would flap on noise; cheaper/better-tier findings are NOTES for a human to act on. Calibrated BOTH directions:
real cached matrix PASSES; `--broken` (a uniformly-failing matrix) is REJECTED with zero API calls.

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
