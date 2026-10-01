# VIL-376 model benchmark results

Last updated: 2026-10-01

## Decision

Barton approved synthetic/mock conversations as the selection evidence. The benchmark compares
quality, latency, and cost; production-data shadowing is not a release requirement.

Four internal decision slices were selected. Each is behind an independent
`current|candidate` flag that defaults to `candidate`. Candidate request, provider, or parse
failures fall back to the current model for that call.

| Slice | Current | Selected candidate | Evidence | Flag |
| --- | --- | --- | --- | --- |
| Reply intent | Sonnet 5 | **JEV** | 3 × 50: 100% accuracy, 0 false consent | `HALE_REPLY_INTENT_MODEL_MODE` |
| Sentinel triage | Haiku 4.5 | **JEV** | 3 × 50: 100% recall and precision | `HALE_TRIAGE_MODEL_MODE` |
| Event classification | Sonnet 5 | **Sonnet 5.5** | 3 × 50: 100% event and teen-safety accuracy | `HALE_CLASSIFY_EVENT_MODEL_MODE` |
| Intake extraction | Sonnet 5 | **Sonnet 5.5** | 3 × 20: 20/20 each round; current also 20/20 | `HALE_INTAKE_EXTRACT_MODEL_MODE` |

These are slice-specific decisions, not global role replacements. Parent-facing wording remains
on the existing Sonnet/Haiku routing: `converse`, `draft`, `answer`, `acknowledge`, and `speak`
were not changed.

## Evaluation and verification coverage

The four selected decisions are backed by **510 candidate fixture executions** and **270 paired
current-model executions**, for **780 production-shaped fixture executions** in the final decision
set:

| Decision | Candidate executions | Current-model executions |
| --- | ---: | ---: |
| Reply intent | 150 (3 × 50) | 150 (3 × 50) |
| Sentinel triage | 150 (3 × 50) | 50 |
| Event classification | 150 (3 × 50) | 50 |
| Intake extraction | 60 (3 × 20) | 20 |
| **Total** | **510** | **270** |

This count excludes smoke/calibration runs, stopped no-go runs, judges, repair loops, and each
model's internal multi-turn calls, so it does not overstate those as additional independent test
cases.

The final post-`main`-sync verification pass ran **364 automated tests**: 119 in `@hale/agent`,
32 VIL worker/eval tests, and 213 targeted web tests. Agent, worker, and web typechecks passed,
as did Biome and `git diff --check`.

## Selected-candidate evidence

### Reply intent: JEV

| Metric | JEV median | Sonnet 5 median |
| --- | ---: | ---: |
| Accuracy, three rounds | 100% | 100% |
| False consent | 0 | 0 |
| p50 / p95 | 277 / 432 ms | 1667 / 2445 ms |
| Cost per 50 fixtures | $0.002583 | $0.247578 |

Decision: select JEV. It preserved every hard gate across three fresh rounds while reducing
median cost by about 99% and p95 latency by about 82%.

### Sentinel triage: JEV

| Metric | JEV | Haiku 4.5 current |
| --- | ---: | ---: |
| Quality | 50/50 in each of 3 rounds | 96.9% recall, 100% precision |
| p50 | 270–281 ms | 1146 ms |
| p95 | 408–518 ms | 1457 ms |
| Cost per 50 fixtures | $0.002348 | $0.0925 |

Decision: select JEV. DeepSeek also scored 50/50, but JEV was faster and cheaper.

### Event classification: Sonnet 5.5

| Metric | Sonnet 5.5 | Sonnet 5 current |
| --- | ---: | ---: |
| Event accuracy | 100% in all 3 rounds | 100% |
| Teen-safety accuracy | 100% in all 3 rounds | 97% |
| Mean latency | 3055–3176 ms | 2892 ms |
| Cost | about 8% higher | baseline |

Decision: select Sonnet 5.5. It is a modest latency/cost increase, but removed the observed teen
privacy miss and stayed within the modernization gate. GPT-6 Luna was rejected after one teen
privacy false negative.

### Intake extraction: Sonnet 5.5

Sonnet 5.5 completed 20/20 fixtures in each of three rounds; current Sonnet 5 completed 20/20.
Candidate p50 was 1426–1478 ms, p95 was 2048–2561 ms, and each 20-fixture round cost about
$0.126.

Decision: select Sonnet 5.5 for this narrow extraction slice. The structured request uses the
model-compatible `tool_choice:auto` shape.

## Keep-current decisions

| Slice | Candidate result | Decision |
| --- | --- | --- |
| Reply resolver | JEV 43/50; GPT-6 Luna 41/50; Haiku current 50/50 | Keep Haiku 4.5 |
| SMS calendar reviewer | GPT-5.6 Luna 43/50 vs current 49/50; Sonnet 5.5 missed clean cancels | Keep Sonnet 5 |
| SMS coach/converse | DeepSeek 39/50 vs current 44/50; Sonnet 5.5 failed one voice-quality hard gate | Keep Sonnet 5 |
| Shared draft | DeepSeek reminder regression; newer models had lower voice scores | Keep Sonnet 4.6 |
| General answer | DeepSeek exceeded SMS budget or quality floor | Keep Haiku 4.5 |
| Acknowledge | DeepSeek 7/8 sendable with an 18 s p95 outlier | Keep Haiku 4.5 |
| Inbound screen | DeepSeek misclassified a safety category | Keep Haiku 4.5 |
| Party/RSVP extraction | Sonnet 5.5 20/20 but slower and more expensive | Keep Sonnet 5 |
| Medical extraction | Sonnet 5.5 17/20 with three workflow-contract misses | Keep Sonnet 5 |
| Activity finder/deep research | Compatible small samples, but slower, costly, or mixed with composer failures | Keep current routing |
| High-stakes judgment | Opus 5.5 truncated at current production token ceilings | Keep Opus 5 |

Model/provider/adapter errors were not counted as model-quality failures. Examples include Gemini
invalid/truncated structured output, early Sonnet 5.5 forced-tool incompatibility, and Opus 5.5
token-ceiling truncation.

## Strong evidence outside the current rollout

These results remain useful, but are not part of the four selected production flags:

| Slice | Candidate | Result | Status |
| --- | --- | --- | --- |
| Memory inference | DeepSeek V4.1 Flash | 3 × 50 at 50/50; current 47/50; p50 865–1029 ms | Strong candidate; deferred |
| Village search parsing | DeepSeek V4.1 Flash | 3 × 50 at 50/50; p50 303–310 ms | Strong candidate; deferred |
| Village search parsing | Sonnet 5.5 | 3 × 50 at 50/50; p50 1039–1102 ms | Compatible modernization; deferred |

These results apply only to the named slice. They do not justify replacing the global `infer` or
`discover` role, nor do Village parsing results cover rank/curate tool loops.

## Benchmark rules and scope

- Fixtures are synthetic and include English/French, vague requests, false-consent traps, safety
  cases, and action requests such as “can you book it?”.
- Comparisons use production-shaped prompts and output contracts where the candidate supports
  them.
- Large early suites used 50 fixtures. Later expensive or multi-stage suites used 1–20 samples as
  integration/calibration evidence and cannot override a 50-sample hard-gate failure.
- Quality hard gates take priority over cost and latency improvements.
- A role-level result cannot be extrapolated across skills with different prompts, tools, or
  output contracts.
- Raw model responses and telemetry remain in `apps/worker/evals/cache/`; runner and fixture files
  remain under `apps/worker/evals/`.

## Rollout state

- All four flags default to `candidate`; set any one to `current` to restore its old model.
- `candidate` failures automatically retry the current model.
- Rollback is setting the affected flag to `current` and redeploying/restarting the web service.
- The obsolete live shadow module was removed; it is not a Barton requirement or release gate.
- The repository default uses the selected candidates; no deployment or production environment
  change was performed as part of this work.

Deployment switches are documented in
[`../docs/deploy/README.md`](../docs/deploy/README.md#vil-376-model-rollout-and-kill-switches).
