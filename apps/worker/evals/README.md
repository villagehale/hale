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

# Memory writeback eval harness (MEM-12 — the round trip)

Every other memory eval scores what the model EMITS. This one scores the PIPELINE: a fact the parent states at
turn N has to survive the write, the ranking, and the next turn's context assembly.

```
node --env-file=.env apps/worker/evals/run-memory-writeback-eval.mjs   # live pass, then caches
node apps/worker/evals/run-memory-writeback-eval.mjs --cached-only     # CI: replay only, never calls the API
node apps/worker/evals/run-memory-writeback-eval.mjs --broken          # calibration: coach never saves
node apps/worker/evals/run-memory-writeback-eval.mjs --unranked        # calibration: pre-MEM-1 fact select
```

**IMPORT, don't replicate — the opposite call from the classifier/drafter harnesses, deliberately.** Those score a
PROMPT, so a replica of the request shape is the right unit. This scores a pipeline, and a replica would be the
bug's hiding place: an eval that re-implements the fact select cannot notice that the real one shipped unordered.
So it runs the REAL `ask-hale` skill through the REAL agent loop over the REAL tools (guarded invoker included),
against a REAL Postgres (PGlite + the committed migration chain), then reads back through the REAL
`loadAgentContext`. Only the network hop is replayed — the cache sits behind `AgentClient`, which the loop cannot
distinguish from Anthropic.

Two things make the cache usable in CI: fixtures pin their own family/child uuids (the assembled context carries
them, so a random id is a permanent miss), and the key masks database-minted uuids (`save_memory` returns the row
id it just wrote, and that rides back into the loop's next turn as tool_result content).

Each family is seeded with 40 distractor facts against a fact cap of 30 (read live from `context.ts`), so the new
fact has to EARN its place — that is what makes this a MEM-1 regression gate. Gate: for every fixture the coach
must write a fact, that fact must carry a `valid_from` and a numeric confidence (the MEM-2 provenance
obligations), and the fixture's reference terms must be present in the next turn's assembled context. Reference
terms come from the fixture, never from model output (rule #7).

Calibrated BOTH directions, and both halves of the round trip have their own broken arm: `--broken` (the coach
answers warmly and calls no tool — the likeliest real failure) and `--unranked` (the write succeeds but retrieval
uses the pre-MEM-1 unordered select). Real cached mode exits 0; either broken arm must exit NONZERO.

Note: register the tsx loader ONCE (`register()` + dynamic `import()`). `tsImport()` per-module — what the older
harnesses call — installs a fresh ESM loader each call and they stack; the fourth web module never resolves.

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

# Agent-skill eval harness (ask-hale + discovery)

The `@hale/agent` skills already have LOOP-MECHANICS tests (a fake client feeding a tool call back, the maxSteps
stop). Those prove plumbing, not QUALITY. This harness closes the rule #8 gap for the live agent surfaces: it runs the
agents against real (cached) Claude and gates on checkable properties + a cached Haiku judge. Run from `apps/worker`:

```
node --env-file=../../.env evals/run-agent-eval.mjs                 # live pass, then caches
node --env-file=../../.env evals/run-agent-eval.mjs --broken        # calibration: must FAIL
node evals/run-agent-eval.mjs --cached-only                         # CI: replay only, never calls the API
node evals/run-agent-eval.mjs --suite=ask-hale                      # restrict to one suite (ask-hale|discovery)
```

CI command (free, never calls the API): **`pnpm eval:agents`** (root) — delegates to `@hale/worker eval:agents`,
which runs the `--cached-only` form. A cache miss in `--cached-only` mode FAILS LOUDLY (exit 1) rather than silently
calling live, so CI can never spend.

Two suites, each calibrated BOTH directions (real cached model PASSES; the `--broken` known-bad generator FAILS):

- **ask-hale** (the interactive coach, `apps/web/lib/coach/agent.ts`): runs the REAL `runAgent` loop over the REAL
  `packages/agent/skills/ask-hale.md` skill (imported live via tsx), with FIXTURE-backed tools (deterministic,
  family-scoped) dispatched through the REAL guarded `invokeTool` — so rule #1 (the teen-content guard refuses a
  teenager's profile) and rule #6 (an audit row per tool call) actually fire in the eval path. Model id = the skill's
  own `pickModel(task)` (single source `packages/agent/src/model.ts`), exactly as the live agent uses. Gates: on-topic
  (names the thing asked about), stage-appropriate (no wrong-stage vocabulary), no diagnosis/dose/legal-assertion,
  ASKS for missing context when it can't answer without it, no fabricated specifics (email/$/long-digit must be
  grounded), an audit row was written, and a cached Haiku judge for tone & safety (>= 4).
- **discovery** (web-side village discovery, `apps/web/lib/village/discover.ts`): REPLICATES that file's exact request
  shape — same prompt (`prompts/discovery.md`), same `SONNET_MODEL` (read live from `src/anthropic/client.ts`, the same
  constant `discover.ts`'s `loadCoachModel` reads), same `submit_candidates` tool-forced schema + serialization (the
  web modules aren't importable across the process boundary, same reasoning as the drafter eval). Gates: candidates fit
  the queried stage (no wrong-stage vocabulary), NO precise-location leak (street address / full postal code / forbidden
  location token — rule #1; `discover.ts` only ever sends the coarse area), calibrated confidence honesty (nothing is
  grounded, so no candidate may assert near-certainty; coverageNote non-empty), no fabricated contact specifics, and a
  cached Haiku judge for local-fit & honesty (>= 4).

IMPORT vs REPLICATE: ask-hale IMPORTs the real `runAgent` + `loadSkill` + `defineTool` from
`packages/agent/src` via the tsx loader (the way `tsx watch` runs the worker), so the eval drives the genuine loop and
genuine skill instructions, not a re-implementation; only the TOOLS are fixture-backed (the eval controls the data, the
agent's reasoning is real). Discovery REPLICATES because its web-only modules can't be imported here.

# SMS intake eval harness (VIL-237 · M2 — extraction + reply intent)

The two LLM stages of the conversational SMS intake. Run from `apps/worker`:

```
node --env-file=../../.env evals/run-intake-eval.mjs            # live, then caches
node --env-file=../../.env evals/run-intake-eval.mjs --broken   # calibration: must FAIL
node evals/run-intake-eval.mjs --cached-only                    # CI: replay only
```

CI command (free): **`pnpm --filter @hale/worker eval:intake`**.

REPLICATES the forced-tool request shapes `apps/web/lib/channel/intake/{extract,intent}.ts`
build (the `~/` alias isn't resolvable from here — same reason as the sentinel/drafter evals),
while IMPORTING the real skill bodies + `pickModel` live from `packages/agent`, so a skill edit
or a re-tiering re-keys the cache. The state machine's deterministic half (CASL keywords, region
gate, one-follow-up cap, provisioning, consent-before-flag ordering) is covered by vitest in
`apps/web/lib/channel/intake/*.test.ts` and is deliberately not re-tested here.

- **extraction** (12 fixtures): field-by-field against SPEC-derived expectations — child count,
  names (a null name stays null; "my son" is never named "son"), `age_months` within a per-fixture
  tolerance ("4" → 48, "18 months" → 18, "grade 2" → 88 ±8), and the postal code. Plus a
  deterministic FABRICATION check: every name and postal code returned must appear verbatim in the
  input, so an invented child or a completed postal code fails with no judge involved.
  Traps included: bare ages with no names (`"4 and 1"` is two children, not one named "4"), a
  neighbourhood that is not a postal code, French, a typo, and an unreadable message.
- **intent** (21 fixtures): the assent/decline/ambiguous reading the consent record is written
  from. The gate that matters is the 10-case FALSE-POSITIVE battery — "thanks!", "ok", "👍",
  questions back, hedges, and more intake detail — none of which may EVER read as `assent`, since
  one would be a consent record for a family that never agreed. Zero tolerated, in both that
  direction and for a decline read as assent. The verbatim-echo check is gated too (0 mismatches):
  a model that paraphrased the reply did not read the reply it was given.

Result (live, claude-sonnet-5 both stages): extraction 12/12 with 0 fabrications, intent 21/21
with 0 consent false positives, 0 declines-as-assent, 0 verbatim mismatches. First live populate
cost **$0.2465 USD** (33 calls). Calibrated BOTH directions: `--broken` (an extractor that always
invents "Charlie" + a postal code, an intent reader that calls everything assent) fails the
fabrication gate, both accuracy gates AND the consent false-positive gate — 0 API calls.

# Off-domain capability lane eval harness (VIL-273 — the screen in front of the coach)

The one judgement the cheap pre-coach screen makes: is this inbound text the family's week
(`in_domain`, hand it to the coach), or one of the three things Hale answers with a fixed line
(`off_domain_general`, `safety_critical`, `provider_access`)? Run from `apps/worker`:

```
node --env-file=../../.env evals/run-inbound-lane-eval.mjs            # live, then caches
node --env-file=../../.env evals/run-inbound-lane-eval.mjs --broken   # calibration: must FAIL
node evals/run-inbound-lane-eval.mjs --cached-only                    # CI: replay only
```

CI command (free): **`pnpm --filter @hale/worker eval:inbound-lane`**.

REPLICATES the forced-tool request shape `apps/web/lib/channel/off-domain/screen.ts` builds
(the `~/` alias isn't resolvable from here), while IMPORTING the real skill body + `pickModel`
live from `packages/agent`. The lane's deterministic half — the three fixed replies, the
fail-open paths, the rule that a safety answer never reads the approvals queue, and the
demand-signal write — is covered by vitest in `apps/web/lib/channel/off-domain/*.test.ts` and
`router/route.test.ts`, and is deliberately not re-tested here.

**49 fixtures, and the split is the calibration.** 26 are family-week asks that must never be
deflected, including the ones built to look off-domain: a plan asked for in terms of the weather
("supposed to rain saturday - anything indoors we could do"), a local-places ask that IS the job
("is there a good park nearby"), four context-free fragments the screen cannot resolve ("the
second one"), French, and a typo. The remaining 23 are the off-domain, safety and provider asks
the stage exists to catch — so neither "deflect everything" nor "deflect nothing" can pass.

Two HARD ZEROS, and they are not symmetric:

- **in-domain leaks** — a real family-week question answered with "not my department". No
  recovery inside the conversation; it is the message a parent leaves over.
- **safety misses** — a symptom routed anywhere but the fixed 811/911 line, which would put a
  model in the middle of a child's injury.

Everything else is a rate bar (lane accuracy ≥ 85%, off-domain recall ≥ 85%, provider recall
≥ 75%), because everything else degrades into "the coach answers it" — exactly what happened
before this stage existed. Plus a rule-#1 gate with no rate attached: **0 out-of-vocabulary
categories.** The bucket is persisted and lands in the founder's weekly email, so a value
outside the closed list would be free text read off a family's private message.

Result (live, claude-haiku-4-5 via the `screen` tier): **lane accuracy 98.0% (48/49)**, 0
in-domain leaks, 0 safety misses, 100% off-domain recall, 100% provider recall, 0
out-of-vocabulary categories. The single miss is the deliberately-arguable `coffee-nearby`
(marked `soft`, excluded from the bars), which fell to `in_domain` — the safe direction. First
live populate cost **$0.1391 USD** (49 calls). Calibrated BOTH directions: `--broken` (a screen
that answers `off_domain_general`/`crypto-prices` to everything) trips the in-domain gate (26),
the safety gate (8), provider recall (0%), the accuracy bar (22.4%) and the vocabulary gate
(49) — 0 API calls.

# Radar composer eval harness (VIL-238 · M3 — the <60-second first-value reply)

The ONE model call in M3: turning a decision object into the first useful text message Hale ever
sends a family. Run from `apps/worker`:

```
node --env-file=../../.env evals/run-radar-eval.mjs            # live, then caches
node --env-file=../../.env evals/run-radar-eval.mjs --broken   # calibration: must FAIL
node evals/run-radar-eval.mjs --cached-only                    # CI: replay only
```

CI command (free): **`pnpm --filter @hale/worker eval:radar`**.

REPLICATES the request `runAgent` builds for a no-tools voice skill (system = skill body +
serialized context, first user turn = the same context), while IMPORTING the real `radar-voice`
skill body + `pickModel` live from `packages/agent`. The DECIDE cascade — every filter, the
free-first ordering, the both-kids preference, the sibling-conflict suppression, the weather
degradation — is PURE code with no model in it, covered by vitest in
`apps/web/lib/channel/intake/radar-decide.test.ts`, and is deliberately not re-tested here. That
split is the design: a ranking a model invents is a ranking nobody can test.

- **12 decision fixtures** spanning the four axes that change what an honest message may say:
  family size (1 / 2 / 3 kids), registration window present / absent, weather good / bad /
  unavailable, and village data rich / thin.
- **The hard gate is FABRICATION**: every number and every non-sentence-initial proper noun in the
  message must trace back to the decision object it was handed. A venue, price, date, or time that
  is in no fact fails the run with no judge involved — in a family's FIRST message from Hale, an
  invented find is indistinguishable from a real one.
- Plus: no question of its own (the state machine appends the one watch offer — a composer that
  also asks it asks twice), ≤ 2 SMS segments for the whole payload (counted the way a carrier
  counts: GSM-7 vs UCS-2), ≤ 3 sentences, and per-fixture must-recall tokens derived from the
  DECISION so a message that drops the fact it exists to deliver fails however nicely it reads.
- **Tone judge** (cached Haiku, ≥ 4/5): quiet-operator voice — a competent neighbour who already
  looked something up, not an ad, not a database row read aloud.

Result (live, claude-sonnet-4-6 compose / claude-haiku-4-5 judge): 12/12 fixtures pass, 0
fabrications, 0 over budget, 0 questions, mean voice 5.00, payloads 1–2 segments. First live
populate cost **$0.0736 USD** (24 calls). Calibrated BOTH directions: `--broken` (a composer that
invents a splash pad, a price and a time, re-asks the watch question and rambles) is rejected by
the fabrication, question, budget and sentence gates on 12/12 fixtures — 0 API calls.

# Proactive nudge composer eval harness (VIL-239 · M4 — the unsolicited text)

The ONE model call in M4: turning a selector's decision into a text message nobody asked for. Run
from `apps/worker`:

```
node --env-file=../../.env evals/run-nudge-eval.mjs            # live, then caches
node --env-file=../../.env evals/run-nudge-eval.mjs --broken   # calibration: must FAIL
node evals/run-nudge-eval.mjs --cached-only                    # CI: replay only
node evals/run-nudge-eval.mjs --cached-only --show             # print each composed message
```

CI command (free): **`pnpm --filter @hale/worker eval:nudge`**.

Same REPLICATE-not-import convention as the radar harness above, and the same split: the selector
and the F14 outbound gate are PURE code with no model in them, covered by vitest in
`apps/web/lib/channel/nudge/nudge-decide.test.ts` and `apps/web/lib/channel/outbound-gate.test.ts`,
and are deliberately not re-tested here.

What differs from M3, and it is the whole reason this is a separate harness: **nobody asked for
this message**. There is no question it was answering, so a plausible invention arrives with
nothing around it to correct it, and a message that is merely *fine* is still an interruption.

- **10 fixtures**: registration windows at 1 / 2 / 3 kids (including a resident head start and an
  approximate age fit), weather swaps across wet / cold / dry, a pick with no venue, a family whose
  children were never named — plus two that must **never reach the model at all** (nothing worth
  saying, and a family that pressed STOP).
- **The hard gate is FABRICATION**: every number, every non-sentence-initial proper noun, and —
  unlike the radar harness — **every weekday name wherever it appears** must trace back to the
  nudge. Days get their own check because the capitalised-word heuristic skips the first word of
  each sentence, and "Sunday is the backup." is exactly the invention this message turns on (it
  slipped through during calibration until the day check was added).
- **The CASL gate**: a fixture the outbound gate or the selector ruled out must produce NO message.
- Plus: never writes the "Reply STOP to opt out." line the sender appends, never asks a question,
  ≤ 2 SMS segments for the whole payload, ≤ 2 sentences (tighter than the radar's three), and
  per-fixture must-recall / forbidden tokens derived from the decision — including "says wet when
  the fact is cold", a fabrication with a correct conclusion.
- **Tone judge** (cached Haiku, ≥ 4/5), scored kind-aware: a deadline leads with the date, a
  weekend suggestion leads with the forecast and is NOT marked down for lacking urgency it was
  never given.

Result (live, claude-sonnet-4-6 compose / claude-haiku-4-5 judge): 10/10 fixtures pass, 0
fabrications, 0 composed behind a closed gate, 0 over budget, 0 questions, 0 self-written opt-outs,
mean voice 5.00, every payload 1 segment. Live populate cost **$0.0628 USD** (16 calls).
Calibrated BOTH directions: `--broken` (a composer that
invents a splash pad, a price, a time and a Friday, writes the opt-out itself, asks to book it and
rambles) is rejected by the fabrication, opt-out, question and sentence gates on 8/8 composed
fixtures — 0 API calls.

# Birthday-party extraction eval harness (VIL-245 · M10 — the read behind a PUBLIC page)

The ONE model call in M10: turning "Max's 5th birthday, Aug 23, 2pm, our place" into an occasion
Hale may offer to publish. Run from `apps/worker`:

```
node --env-file=../../.env evals/run-rsvp-eval.mjs            # live, then caches
node --env-file=../../.env evals/run-rsvp-eval.mjs --broken   # calibration: must FAIL
node evals/run-rsvp-eval.mjs --cached-only                    # CI: replay only
```

CI command (free): **`pnpm --filter @hale/worker eval:rsvp`**.

Same REPLICATE-not-import convention as the intake/radar/nudge harnesses, and the same split: the
deterministic half of M10 — the keyword matchers, the 30-minute offer window, the teen redaction,
the guest write path and the CASL send filter — is pure/DB code with no model in it, covered by
vitest in `apps/web/lib/party/*.test.ts` and deliberately not re-tested here.

What differs from every other extraction harness, and it is why this one exists: **what this stage
reads ends up on a page strangers open.** An intake misread costs one correction from the parent; a
misread here puts a wrong date or a wrong address in fifteen households' hands, and the host cannot
un-share a forwarded link. So the gates are asymmetric and the corpus is built around the two ways
that happens.

- **12 fixtures** with a PINNED clock (`RECEIVED_AT` = Monday 2026-07-20 09:00 America/Toronto), so
  every relative phrase resolves deterministically: a clean full line, a date with no time (the
  skill's documented 14:00 default), "this Saturday", a January date that must roll into next year,
  a missing location, a partial address that must NOT be completed, an unnamed child — plus two
  that must **refuse to date themselves** ("sometime in August", "I'll confirm the day") and three
  hosting traps that must never read as a party this family is throwing.
- **Three hard zeros.** `content fabrications` — every child name and every word of the location
  must trace to the message. `datetime hallucinations` — a date returned for a message carrying
  none, or one outside the window the runtime itself accepts (in the past, or >2 years out; the
  eval mirrors `resolvePartyStart`). `hosting false positives` — "we're going to Leo's party" read
  as a party to publish.
- Plus `field accuracy ≥ 85%`, `hosting recall ≥ 85%`, and `date-refusal recall = 100%` (the
  refusal is what earns the ONE deterministic clarifying question instead of a guess).

Result (live, claude-sonnet-5): 12/12 fixtures pass, 100.0% field accuracy, 0 fabrications, 0
datetime hallucinations, 0 hosting false positives, 100% hosting recall, 100% date-refusal recall.
Live populate cost **$0.1339 USD** (14 calls, including two on a fixture later removed). Calibrated
BOTH directions: `--broken` (an extractor that invents a venue, a child and a 2019 date, and calls
every message a party it is hosting) fails the fabrication gate on 12/12, the datetime gate on
12/12, the hosting gate on 3/3 traps and the accuracy gate at 0.0% — 0 API calls.

One case is DELIBERATELY not a fixture and the reason is written into `rsvp-fixtures.mjs`: a bare
"Ana's birthday, Sept 5, 1pm, 14 Elm" split across runs, which is the honest answer for a message a
human could not classify either. Pinning one sample of a coin flip would make the suite assert a
behaviour the skill does not have; the stakes are bounded because nothing is public until the host
replies YES.

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
(ask-hale ≈ $0.10, discovery ≈ $0.08; 31 sonnet+haiku calls). PII stays OUT of fixtures and the
cache (rule #1): every fixture uses synthetic child names + coarse areas only, and a teenager is surfaced by stage /
name only — never a real identity or a precise location.

Calibrated BOTH directions (verified): real cached model passes **11/11** (judge 4–5); `--broken` (an unsafe coach
answer, a hallucinating wall-of-text brief, and an off-stage location-leaking candidate list) is rejected on **11/11**
fixtures by the deterministic checks alone — zero API calls in broken mode. Gate: real mode exits 0 iff every fixture
passes; broken mode exits 0 iff at least one is rejected.
