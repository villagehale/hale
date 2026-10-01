# VIL-376 model benchmark results

Last updated: 2026-10-01

## Decision and rollout state

Barton approved synthetic/mock conversations as the selection evidence. Production-data shadowing
is not required. Every candidate below is independently selectable and defaults to `current`, so
merging this code does not change production model routing. No flag was enabled or deployed here.

| Decision slice | Current | Candidate | Evidence/status | Flag |
| --- | --- | --- | --- | --- |
| Event classification | Sonnet 5 | Sonnet 5.5 | 3 × 50 at 100%, including teen-safety gates | `HALE_CLASSIFY_EVENT_MODEL_MODE` |
| Sentinel triage | Haiku 4.5 | JEV | 3 × 50 at 50/50; low-confidence `no` falls back | `HALE_TRIAGE_MODEL_MODE` |
| Reply intent | Sonnet 5 | JEV hybrid | Independent held-out 50/50 with zero false consent | `HALE_REPLY_INTENT_MODEL_MODE` |
| Inbound screen | Haiku 4.5 | JEV | 59/60 accepted by confidence gate; 1/60 falls back | `HALE_INBOUND_SCREEN_MODEL_MODE` |
| Memory inference | Sonnet 4.6 | DeepSeek V4.1 Flash | 3 × 50 at 50/50 vs current 47/50 | `HALE_MEMORY_INFER_MODEL_MODE` |
| Village search parsing | Sonnet 5 | DeepSeek V4.1 Flash | 3 × 50 at 50/50; parser only, not rank/curate | `HALE_VILLAGE_SEARCH_PARSE_MODEL_MODE` |
| Intake extraction | Sonnet 5 | Sonnet 5.5 available but not selected | Candidate and current both 3 × 20 at 20/20; keep current | `HALE_INTAKE_EXTRACT_MODEL_MODE` |

Parent-facing wording remains on the current Sonnet/Haiku routes. These are slice-specific
decisions, not global replacements for `classify`, `infer`, or `discover`.

## Safety and fallback behavior

- All flags treat unset, empty, and invalid values as `current`; only the literal `candidate`
  enables a candidate.
- Candidate errors log a content-free error category and cumulative fallback count.
- Triage never drops a low-confidence JEV `no`; it retries with Haiku.
- Reply intent lets high-confidence JEV decline/ambiguous decisions bypass Sonnet, but every
  `assent` still goes through Sonnet's verbatim guard before consent can be written.
- Inbound screen accepts JEV only at top probability ≥ 0.40 and margin ≥ 0.10; otherwise it
  retries Haiku.
- Village parsing retries Sonnet if DeepSeek fails or returns unusable JSON.
- Memory inference does not retry another model after a partial tool loop, because doing so could
  duplicate memory writes. A failed run is recorded and retried by the existing cron lifecycle.

## Quantitative results

### Reply intent: JEV held-out corpus

| Metric | JEV | Sonnet 5 current |
| --- | ---: | ---: |
| Accuracy | 50/50 (100%) | 50/50 (100%) |
| False consent | 0 | 0 |
| p50 / p95 | 284 / 537 ms | 1726 / 1939 ms |
| Cost per 50 fixtures | $0.002594 | $0.384042 |

The models disagreed on zero fixtures. At equal measured quality, JEV was about 6.1× faster at
p50, 3.6× faster at p95, and 99.3% less expensive on this corpus.

The independent corpus contains 38 non-assent cases, including French ambiguity and action
requests such as booking, moving, and cancelling. None of its reply strings appear in the
`reply-intent` skill. This is the release evidence for the JEV decision gate.

#### Earlier development corpus

| Metric | JEV median | Sonnet 5 median |
| --- | ---: | ---: |
| Accuracy, three rounds | 100% | 100% |
| False consent | 0 | 0 |
| p50 / p95 | 277 / 432 ms | 1667 / 2445 ms |
| Cost per 50 fixtures | $0.002583 | $0.247578 |

This earlier corpus is not release evidence: it was committed with the adapter and many messages
closely resembled skill examples.

### Sentinel triage: JEV

| Metric | JEV | Haiku 4.5 current |
| --- | ---: | ---: |
| Quality | 50/50 in each of 3 rounds | 96.9% recall, 100% precision |
| p50 | 270–281 ms | 1146 ms |
| p95 | 408–518 ms | 1457 ms |
| Cost per 50 fixtures | $0.002348 | $0.0925 |

### Event classification: Sonnet 5.5

| Metric | Sonnet 5.5 | Sonnet 5 current |
| --- | ---: | ---: |
| Event accuracy | 100% in all 3 rounds | 100% |
| Teen-safety accuracy | 100% in all 3 rounds | 97% |
| Mean latency | 3055–3176 ms | 2892 ms |
| Cost | about 8% higher | baseline |

GPT-6 Luna was rejected for this slice after one teen-privacy false negative.

### Inbound screen: JEV + Haiku fallback

The confidence gate accepted 59/60 hard fixtures, sent 1/60 to Haiku, and accepted no error as a
decision. JEV measured p50 292 ms and p95 424 ms. The hybrid estimate is about $0.26 per 1,000
calls, approximately 94.2% below all-Haiku routing.

### DeepSeek internal parsers

| Slice | Quality | Candidate latency | Scope |
| --- | ---: | ---: | --- |
| Memory inference | 3 × 50 at 50/50; current 47/50 | p50 865–1029 ms | Nightly infer tool loop only |
| Village search parsing | 3 × 50 at 50/50 | p50 303–310 ms | Query parsing only |

DeepSeek pricing used by the estimator is $0.15/M input, $0.60/M output, and $0.003/M cached input.
The earlier runs did not produce a complete paired current-vs-candidate p95/cost table, so no
percentage savings claim is made for these two slices.

## Keep-current decisions

| Slice | Candidate result | Decision |
| --- | --- | --- |
| Reply resolver | JEV 43/50; GPT-6 Luna 41/50; Haiku current 50/50 | Keep Haiku 4.5 |
| SMS calendar reviewer | GPT-5.6 Luna 43/50 vs current 49/50; Sonnet 5.5 missed clean cancels | Keep Sonnet 5 |
| SMS coach/converse | DeepSeek 39/50 vs current 44/50; Sonnet 5.5 failed one voice hard gate | Keep Sonnet 5 |
| Shared draft | DeepSeek reminder regression; newer models had lower voice scores | Keep Sonnet 4.6 |
| General answer | DeepSeek exceeded SMS budget or quality floor | Keep Haiku 4.5 |
| Acknowledge | DeepSeek 7/8 sendable with an 18 s p95 outlier | Keep Haiku 4.5 |
| Party/RSVP extraction | Sonnet 5.5 20/20 but slower and more expensive | Keep Sonnet 5 |
| Medical extraction | Sonnet 5.5 17/20 with three workflow-contract misses | Keep Sonnet 5 |
| Activity finder/deep research | Small samples were slower, costly, or mixed with composer failures | Keep current routing |
| High-stakes judgment | Opus 5.5 truncated at current token ceilings | Keep Opus 5 |

Provider, adapter, and truncation failures were not counted as model-quality failures.

## Release sequence

The requested order is classification first, triage second, and reply intent last. Inbound screen,
memory inference, and Village parsing remain separate opt-in decisions. JEV is already approved,
and selecting a model provider no longer needs separate approval. This default-off code may be
merged once CI is green. Opening any flag, creating new spend, changing parent-visible wording,
changing consent logic, or otherwise changing live behavior still requires a Barton heads-up first;
post the plan and results in the Slack thread for review.

The repository contains no Twilio path after #741. Any live SMS verification must use Linq iMessage
and one test number to avoid consuming the 200-number allocation.
