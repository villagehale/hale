# Hearth — Newborn Platform Design

**Date:** 2026-05-26
**Status:** Draft for user review
**Author:** Barton Dong (with AI brainstorming assistance)

---

## 2026-06-12 Rebuild addendum — ratified deviations

The body of this spec is preserved as the locked product/UX/pricing ideation. The rebuild loop (Phase A→B) ratified the deviations below; where they conflict with the body, **the addendum wins**. Rationale and provenance live in `.loop/BRIEF.md` (and `.loop/STATE.md` for the gate decisions).

**Architecture/stack reversals (R1–R5, BRIEF "reversals to ratify"):**

- **R1.** No `@anthropic-ai/claude-agent-sdk` for now (reverses §8.1) — revisit at portal-automation / Computer-Use features.
- **R2.** Langfuse is the authoring/versioning source synced to disk at build/deploy, not a hot-path fetch (adjusts hard rule #2's letter; inline prompts still forbidden).
- **R3.** One checkpointed pg-boss queue (`events.ingested` + `events.status` transitions) now; the §2.4 multi-queue state machine is deferred until a second consumer exists.
- **R4.** The vertical slice executes via Postmark outbound; true Gmail reply-threading is not built yet.
- **R5.** Mastra + Vercel AI SDK removed (reverses the PR-#2 migration) — structured output is now raw `@anthropic-ai/sdk` tool-forced JSON, so the raw `tool_use` blocks hard rule #3 counts stay visible.

**Four-stage scope expansion** (the body locks newborn 0–12mo only): the product spans the ~18-year childhood. Stage is derived per-child from `dateOfBirth` (no migration — already in schema) via `deriveStage` in `@hearth/types`, with boundaries `[12, 48, 156]` months → `newborn | toddler | child | teenager`.

**Pricing as ratified** (user gate; supersedes any pricing in the body): one family-level plan on an autonomy-tier axis — **Free** (L1–L2 observe/draft, all stages, all children) / **Plus $24/mo CAD** (L3 autonomy) / **Family $49/mo CAD** (L3 + commerce + portal automation). Per-stage plans were **rejected** because stages coexist within one family (a household can hold a newborn and a teen at once). Per-child fairness is a bundled event allowance metered off `agent_runs.cost`.

**Teen privacy** (children 13+): raw content is redacted from parents by default (category/summary only); raw-content access needs an explicit, logged, time-limited grant; safety escalation is a named exception with teen notification. Read-only self-view at 13, own-account opt-in at 16. Teen-facing code is deferred past this loop. See hard rules #1 and #5.

For full rationale on every item above, see `.loop/BRIEF.md`.

---

## Executive Summary

**Hearth** is a passive, event-driven, multi-agent autonomous AI system for new parents in Canada. It ingests a family's data streams (email, calendar, photos, integrations), classifies events, drafts actions in the family's voice, verifies them through an independent reviewer agent, and executes routine work autonomously. Parents receive a daily digest of work done on their behalf.

The wedge is **household admin for newborn families** (paperwork, pediatric scheduling, supplies, photo curation, postpartum benefits) layered with **proactive parenting coaching** (sleep, feeding, milestones, behavior) grounded in named frameworks (Karp, Ferber, Markham, Health Canada, AAP).

The product brand is comprehensive newborn support; the build sequence is platform-first with a design-partner cohort active from month 3.

---

## Locked Scope Decisions

| Decision | Locked answer |
|---|---|
| Wedge | Household admin (autonomous) + coaching (advisory) |
| Age phase 1 | Newborn 0-12 months |
| Age expansion path | Preschool 2-5, then school-age 5-12 |
| Geography | Canada first → US → global |
| Family unit | Two equal parent accounts per family; extended caregivers added later as read-only |
| Language | TypeScript |
| Runtime | Node.js 22 LTS |
| Web framework | Next.js 15 (App Router) |
| Agent framework | Claude Agent SDK (TypeScript) |
| Database | Postgres 16 (Supabase Toronto region) |
| System architecture | Two services sharing Postgres: Next.js app + Agent Worker |
| Build order | Platform-first with design-partner cohort by month 3 |
| Constraint | Solo dev, no timeline pressure, build it right |

---

## Section 1 — System Architecture Overview

### 1.1 Service topology

```
┌───────────────────────────────────────────────────────────────┐
│                      Newborn Parent (PWA)                     │
│           iPhone / Android / desktop web — Next.js UI         │
└──────────────────────────────┬────────────────────────────────┘
                               │ HTTPS
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                     Next.js App  (Vercel)                     │
│                                                               │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│   │ Web App     │  │ API routes  │  │ Webhook receivers   │   │
│   │ (App Router)│  │ (auth, CRUD)│  │ (Gmail, Cal, Stripe)│   │
│   └─────────────┘  └──────┬──────┘  └──────────┬──────────┘   │
└────────────────────────────┼────────────────────┼─────────────┘
                             │                    │ enqueue
                             │                    ▼
                             │      ┌─────────────────────────┐
                             │      │  Agent Worker Service   │
                             │      │  (Fly.io YYZ Toronto)   │
                             │      │                         │
                             │      │  ┌───────────────────┐  │
                             │      │  │ Orchestrator      │  │
                             │      │  │ (deterministic)   │  │
                             │      │  │ workflow runner   │  │
                             │      │  └─────────┬─────────┘  │
                             │      │            │ dispatches │
                             │      │            ▼            │
                             │      │  ┌───────────────────┐  │
                             │      │  │ Claude Agent SDK  │  │
                             │      │  │   subagent pool   │  │
                             │      │  │ (LLM agents only) │  │
                             │      │  └─────────┬─────────┘  │
                             │      │            │            │
                             │      │  ┌─────────▼─────────┐  │
                             │      │  │ Executor service  │  │
                             │      │  │ (mostly determin- │  │
                             │      │  │  istic + browser  │  │
                             │      │  │  automation)      │  │
                             │      │  └───────────────────┘  │
                             ▼      └───────────┬─────────────┘
                  ┌───────────────────────────────────────┐
                  │  Postgres (Supabase Toronto region)   │
                  │  users · families · children          │
                  │  family_memory_graph                  │
                  │  events · actions · audit_log         │
                  │  pg-boss job queue                    │
                  │  agent_runs (traces, costs)           │
                  └───────────────────────────────────────┘
                                  ▲
                                  │ tools (OAuth, MCP, browser)
                  ┌───────────────┴───────────────────────┐
                  │           External Services           │
                  │  Gmail / Outlook (OAuth + REST)       │
                  │  Google / Apple Calendar (OAuth+REST) │
                  │  Photos library (delegated read)      │
                  │  Stripe (OAuth + REST)                │
                  │  CRA / ESDC (where APIs exist;        │
                  │   else browser automation + OCR)      │
                  │  Pediatric portals (browser auto.)    │
                  │  Twilio (SMS, scheduled reminders)    │
                  │  PDF form-fill engines (deterministic)│
                  └───────────────────────────────────────┘
```

Two services, one shared database. The Agent Worker is the only place that holds LLM context, makes Claude API calls, or runs browser automation. The Next.js app stays thin: UI, auth, CRUD, webhook ingestion, queue enqueue.

### 1.2 LLM agents (5 — only where reasoning is required)

| Agent | Job | Model | Sees | Produces | Tools |
|---|---|---|---|---|---|
| **Classifier** | Reads raw signals and classifies into structured event types with confidence + suggested routing | Haiku 4.5 | Raw signal + family preferences slice | `Event { type, payload, suggested_action, confidence, rationale }` | Memory read-only |
| **Drafter** | Composes the action — email reply, calendar invite, form fill, supply order, digest entry — in the family's voice | Sonnet 4.6 | Event + targeted memory slice + family voice profile | Draft `Action` object — NOT executed | Memory read, template library, voice samples |
| **Coach** | Generates parenting advice grounded in named frameworks | Sonnet 4.6 | Question or proactive trigger + child profile + parenting-style preference | Advice text with framework citations + confidence | Memory read, RAG over coaching knowledge base |
| **Reviewer** | Independent safety/correctness check before any autonomous action commits — **must invoke verification tools** | Sonnet 4.6 | Draft action + safety policy + context summary | `{ verdict, tool_results, rationale }` | Calendar conflict check, vaccine-schedule lookup, spending cap, recipient allowlist, sender allowlist, action time window, idempotency check, PII leak check, user-override lookup |
| **Memory Inferencer** | Periodically infers patterns and preferences from accumulated events; runs nightly or on-demand | Sonnet 4.6 | Last N events + memory snapshot | Fact updates, episode summaries, pattern detections | Memory read/write |

### 1.3 Deterministic services (3 — no LLM needed)

| Service | Job | Tech |
|---|---|---|
| **Orchestrator** | State-machine workflow runner. Picks jobs off pg-boss, dispatches them through Classifier → (Drafter \| Coach) → Reviewer → Executor based on event type. Owns retries, timeouts, parallelism. No LLM calls. | TypeScript state machine (xstate or hand-rolled), pg-boss consumer |
| **Memory Writer** | Persists events, actions, and Memory Inferencer outputs to Postgres. Maintains the family graph schema. No LLM calls. | Drizzle ORM, Postgres |
| **Executor** | Takes approved actions and runs them via real-world tools. Mostly deterministic dispatch (Gmail send, Calendar create, Stripe charge, PDF fill). Exception: browser-automation actions invoke Claude Agent SDK Computer Use. | TypeScript dispatcher + Anthropic Computer Use for portal automation |

Total system: **5 LLM agents + 3 services**. Half the LLM call volume of a naive "8 agents all LLM-powered" design.

### 1.4 The three Cherny properties, mapped concretely

1. **Isolation** — Drafter never sees coaching content; Coach never sees email contents; Reviewer never sees Drafter's reasoning (only the proposed action and policy). Enforced at the Claude Agent SDK subagent level via separate prompts and explicit context scoping.

2. **Verification** — Reviewer is structurally different from Drafter in two ways: (a) different system prompt focused on "find what's wrong with this action," and (b) required to invoke deterministic verification tools rather than reasoning about correctness from prose. This is the only path to L3-L4 reliability — independent process + ground-truth tool checks.

3. **Parallelism** — Multiple events in a window are processed concurrently by the Orchestrator (deterministic, no LLM bottleneck) and converge in the family digest.

### 1.5 Latency and cost budget

**Latency targets:**

| Event class | Target end-to-end | Why |
|---|---|---|
| Real-time (clinic response, appointment in <2hr) | < 30 seconds | Parent may be watching for this |
| Standard event (school email, supply order, photo) | < 2 minutes | Parent finds it in evening digest |
| Inferred insight (pattern detection, weekly summary) | Hours (batch) | No human waiting |

**Cost budget:** ≤ **$0.10 / event in LLM costs**, ≤ **$5 / family / month** at steady state.

**Cost levers:**

| Lever | How |
|---|---|
| Model routing | Classifier on Haiku 4.5; Drafter/Coach/Reviewer on Sonnet 4.6; extended thinking only when needed |
| Prompt caching | Family memory + system prompts cached at 5-min TTL |
| Context scoping | Each agent sees only its slice of family memory |
| Deduplication | Classifier emits content-hash; identical events within 24h skip downstream agents |
| Batch inference | Memory Inferencer runs nightly, not per-event |

### 1.6 Data flow for one event (concrete example)

**Event:** Pediatric office emails a vaccine appointment reminder for next Thursday.

```
1. Gmail webhook → Next.js /api/webhooks/gmail
2. Next.js verifies HMAC signature, enqueues `email_received` job in pg-boss
3. Orchestrator (deterministic) picks job, fetches email content
4. Orchestrator dispatches Classifier (Haiku)
   → Classifier emits: { type: PediatricAppointmentReminder,
                          confidence: 0.97, suggested_action: confirm }
5. Orchestrator routes by event type → dispatches Drafter (Sonnet)
   → Drafter generates Action: confirm_appointment with pre-visit form pre-filled
6. Orchestrator dispatches Reviewer (Sonnet)
   → Reviewer invokes tools (NOT reasoning):
     - calendar_conflict_check(thursday_10am) → no conflict
     - vaccine_schedule_check(child_age, vaccine_type) → on schedule
     - sender_allowlist_check(clinic_email) → allowed
     - spending_cap_check(action) → no $ involved
   → Reviewer verdict: { approve, tool_results, rationale }
7. Orchestrator dispatches Executor (mostly deterministic)
   → Gmail API: send confirmation reply
   → Google Calendar API: create event with reminder
   → PDF service: fill pre-visit form, attach to event
8. Memory Writer (deterministic) persists:
   → events table: PediatricAppointmentReminder
   → actions table: confirm_appointment_thursday
   → audit_log: every step + tool result + LLM call cost
9. Daily digest (scheduled job) surfaces in tonight's recap

Latency: ~30-45s (mostly waiting on Gmail/Calendar APIs, not LLM)
Cost: ~$0.04 (1 Haiku call + 2 Sonnet calls, mostly cached)
```

**Failure modes the design handles** (full treatment in Section 6):

- Classifier low confidence → human review queue
- Reviewer rejects → action stays as draft, surfaced for explicit approval
- Executor fails → retry with backoff, then human queue
- Tool returns unexpected state → Reviewer flags-for-human
- Hallucinated tool args → rejected at API schema boundary

### 1.7 Why this shape, not the simpler alternative

A single Claude call per event with all tools attached fails for four reasons:

1. **Hallucination compounds without independent verification.** A single agent that decides + drafts + executes will commit hallucinated actions. The Reviewer-as-separate-agent pattern with required tool-based verification is the only known mitigation.
2. **Context pollution degrades both tasks.** Coach's parenting wisdom and Drafter's email composition are different cognitive shapes. Mixing them measurably degrades both.
3. **Cost explodes without model routing.** A single Sonnet 4.6 call per event with full context costs 5-10x what our split pipeline costs.
4. **Regulatory defensibility requires hard isolation.** When PIPEDA/Quebec Law 25/COPPA reviewers ask "what data does your coaching agent see?", we want the answer to be "child age and parenting style — yes; email contents — never." Enforced subagent isolation makes this credible.

---

## Section 2 — Data Model

### 2.1 Core entities (normalized tables)

```sql
-- Identity
users
  id, email, password_hash, name, locale, timezone, created_at

families
  id, display_name, country_code, province_or_state, primary_language,
  created_at, onboarding_stage

family_members
  family_id, user_id, role (primary_parent | co_parent | extended | service),
  invited_by, joined_at, permissions_json

children
  id, family_id, name, date_of_birth, biological_sex, gestational_weeks,
  birth_weight_g, hospital_of_birth, parenting_style_overrides_json

-- Consent + integrations
integrations
  id, family_id, user_id (optional), provider, scopes, oauth_tokens_encrypted,
  status, last_sync_at, created_at

consent_records
  id, family_id, user_id, consent_type, granted, granted_at, ip, ua,
  policy_version, revoked_at
```

### 2.2 Family memory graph (hybrid: relational + JSONB)

The memory graph is the moat. It needs to compound and be queryable cheaply by agents.

```sql
family_memory_facts
  id, family_id, child_id (nullable), fact_type (preference | routine |
  medical | logistic | relationship | voice), fact_key, fact_value_json,
  confidence (0-1), source_event_id, inferred_by (agent_name | user),
  valid_from, valid_until, superseded_by

family_memory_episodes
  id, family_id, child_id, occurred_at, episode_type, summary,
  payload_json, source_event_id, sentiment_score

family_voice_profile
  family_id, user_id, voice_samples_json, tone_descriptors,
  signature_block, updated_at
```

**Why hybrid:** Drafter needs fast lookup (preference query → indexed); Coach needs rich context (episode scan over last N days). JSONB stores the long tail; indexable axes are normalized.

### 2.3 Event/action/audit pipeline

```sql
events
  id, family_id, source, source_external_id (for dedup), event_type,
  payload_json, raw_signal_ref, classified_at, classifier_confidence,
  dedup_hash, status (pending | classified | routed | actioned | ignored | failed)

actions
  id, event_id, family_id, action_type, payload_json, drafted_at,
  drafted_by_agent_run_id, reviewer_verdict (approved | rejected | flagged | superseded),
  reviewer_verdict_at, reviewer_tool_results_json, executed_at, executor_result_json,
  user_visible_state (autonomous | drafted_for_approval | needs_human | reverted),
  reverted_at, reverted_reason

audit_log
  id, family_id, actor (system | agent_run_id | user_id), action_taken,
  target_table, target_id, before_json, after_json, occurred_at,
  ip, ua, agent_run_id

agent_runs
  id, family_id, event_id, action_id, agent_name, model_used,
  prompt_tokens, completion_tokens, cost_usd, latency_ms,
  prompt_cache_hit, started_at, completed_at, status, parent_run_id
```

### 2.4 Job queues (pg-boss)

```
events.ingested            -- new event waiting for classification
events.classified          -- ready for drafting
actions.drafted            -- ready for review
actions.approved           -- ready for execution
memory.inference.due       -- nightly memory inference pass
digest.daily.due           -- daily digest generation
integration.sync           -- periodic sync for non-webhook sources
```

### 2.5 Indexes

```sql
CREATE INDEX idx_events_family_status ON events (family_id, status, classified_at);
CREATE INDEX idx_actions_family_state ON actions (family_id, user_visible_state, drafted_at DESC);
CREATE INDEX idx_memory_facts_lookup ON family_memory_facts (family_id, fact_type, fact_key) WHERE valid_until IS NULL;
CREATE INDEX idx_agent_runs_cost ON agent_runs (family_id, started_at, cost_usd);
CREATE UNIQUE INDEX idx_events_dedup ON events (family_id, dedup_hash);
```

### 2.6 Encryption posture

- **At rest:** Postgres pgcrypto for `oauth_tokens_encrypted`, `family_memory_facts.fact_value_json` when fact_type='medical', and any column containing PII at column level
- **In transit:** TLS everywhere
- **Key management:** Supabase Vault or self-hosted KMS envelope encryption — keys never on app servers
- **App-layer:** Sensitive fields use envelope encryption via helper that handles encryption boundary

### 2.7 Migrations and schema evolution

- **Tool:** Drizzle ORM with Drizzle Kit for migrations
- **Policy:** Additive in production. No destructive changes without explicit feature flag. Renames go through deprecation cycle.
- **Memory graph schema:** JSONB structure evolves via migration scripts that re-shape existing rows when adding new fact types.

---

## Section 3 — Agent + Service Contracts

For each component: purpose, input contract, output contract, tools, system-prompt shape (skeleton — actual prompts in Langfuse, not in code).

### 3.1 Classifier (LLM, Haiku 4.5)

```typescript
interface ClassifierInput {
  signal: {
    source: 'gmail' | 'gcal' | 'photos' | 'webhook' | 'manual';
    raw_content: string;
    metadata: Record<string, unknown>;
  };
  family_context_slice: {
    children_ages_months: number[];
    province: string;
    timezone: string;
    known_clinics: string[];
    known_daycares: string[];
  };
}

interface ClassifierOutput {
  event_type: EventType;
  confidence: number;
  payload: Record<string, unknown>;
  suggested_action: ActionType | 'ignore' | 'surface_only';
  rationale: string;
  dedup_hash: string;
}
```

**Tools:** none. **Prompt:** Langfuse, versioned.

### 3.2 Drafter (LLM, Sonnet 4.6)

```typescript
interface DrafterInput {
  event: Event;
  family_voice: VoiceProfile;
  memory_slice: {
    relevant_facts: FamilyMemoryFact[];
    relevant_episodes: FamilyMemoryEpisode[];
  };
  action_template_hint?: string;
}

interface DrafterOutput {
  action_type: ActionType;
  payload: ActionPayload;
  confidence: number;
  recipient_visibility: 'public' | 'internal_only';
  rationale: string;
}
```

**Tools:** `read_memory_fact(key)`, `read_voice_sample(scenario)`, `lookup_template(type)` — all read-only.

### 3.3 Coach (LLM, Sonnet 4.6)

```typescript
interface CoachInput {
  trigger:
    | { kind: 'user_question'; question: string }
    | { kind: 'proactive'; context: ProactiveContext };
  child: ChildProfile;
  parenting_style: ParentingStyle;
  memory_slice: {
    relevant_episodes: FamilyMemoryEpisode[];
    relevant_facts: FamilyMemoryFact[];
  };
}

interface CoachOutput {
  advice_text: string;
  framework_citations: FrameworkCitation[];
  confidence: number;
  follow_up_questions: string[];
  flag_for_pediatrician: boolean;
}
```

**Tools:** `search_knowledge_base(query)` — RAG over curated coaching content.

**Critical rule:** Coach never sees email contents, calendar events, or any data outside its scoped slice. PIPEDA-defensible isolation.

### 3.4 Reviewer (LLM, Sonnet 4.6, REQUIRED tool use)

```typescript
interface ReviewerInput {
  draft_action: DraftedAction;
  family_safety_policy: SafetyPolicy;
  context_summary: string;
}

interface ReviewerOutput {
  verdict: 'approve' | 'reject' | 'flag_for_human';
  tool_results: ToolResult[];
  rationale: string;
  if_rejected_remediation_suggestion?: string;
}
```

**Tools (MUST CALL relevant ones):**
- `check_calendar_conflict(time, duration)`
- `check_vaccine_schedule(child_id, vaccine_type)` — against CDC/Health Canada
- `check_spending_cap(amount, category)` — against family budget
- `check_recipient_allowlist(recipient)`
- `check_sender_allowlist(sender)`
- `check_action_time_window(time)`
- `check_action_idempotency(action_hash)`
- `check_pii_leak(content, allowed_pii_recipients)`
- `check_user_override(user_id, action_type)`

**System prompt principle:** "you are a safety reviewer. Your job is to FIND PROBLEMS. Invoke verification tools for every claim. Default to flag_for_human under ambiguity. Reject if any tool returns red. Never approve based on prose alone."

### 3.5 Memory Inferencer (LLM, Sonnet 4.6, batched)

```typescript
interface InferencerInput {
  family_id: string;
  recent_events: Event[];
  recent_actions: Action[];
  current_memory_snapshot: MemorySnapshot;
}

interface InferencerOutput {
  fact_updates: FactUpdate[];
  episode_summaries: EpisodeSummary[];
  pattern_detections: PatternDetection[];
  retire_facts: string[];
}
```

**Schedule:** nightly batch + on-demand after major life events.

### 3.6 Orchestrator (deterministic service)

State-machine workflow runner. Picks jobs off pg-boss queue, dispatches them through Classifier → (Drafter | Coach) → Reviewer → Executor sequence based on event type. Owns retries (3 max, exponential backoff), timeouts (60s per agent call), and parallel dispatch for independent events. No LLM calls.

### 3.7 Memory Writer (deterministic service)

```typescript
interface MemoryWriter {
  recordEvent(event: Event): Promise<void>;
  recordAction(action: Action): Promise<void>;
  applyFactUpdates(updates: FactUpdate[]): Promise<void>;
  applyEpisodeSummaries(summaries: EpisodeSummary[]): Promise<void>;
  readFamilyContextSlice(family_id: string, scope: ContextScope): Promise<MemorySlice>;
}
```

Pure DB writes. The single source of truth for what agents can see.

### 3.8 Executor (mostly deterministic + Computer Use)

```typescript
interface Executor {
  execute(approved: ApprovedAction): Promise<ExecutionResult>;
}
```

Routing by action_type:

| Action type | Mechanism |
|---|---|
| `send_email` | Gmail/Postmark API (deterministic) |
| `create_calendar_event` | Google/Apple Calendar API (deterministic) |
| `place_supply_order` | Stripe + merchant integration (deterministic) |
| `fill_pdf_form` | PDF service (deterministic) |
| `book_clinic_portal` | Claude Agent SDK Computer Use (LLM-powered) |
| `submit_government_form` | Computer Use OR API where available |

Computer Use is the only LLM-touching part of the Executor.

---

## Section 4 — Data Ingestion & Trigger Patterns

### 4.1 Source-by-source strategy

| Source | Mechanism | Latency | Reliability |
|---|---|---|---|
| Gmail | Watch API (push via Cloud Pub/Sub) | Seconds | High |
| Outlook | Microsoft Graph webhook subscriptions | Seconds | High |
| Google Calendar | Watch API (push) | Seconds | High |
| Apple Calendar (iCloud) | CalDAV polling — no push available | 5-15 min poll | Medium |
| Photos (Google Photos) | Library API + scheduled poll | 1 hour poll | Medium |
| Photos (iCloud) | No direct API — user-driven uploads via PWA | User-driven | User-dependent |
| Stripe | Webhooks (HMAC-signed) | Seconds | High |
| Twilio (SMS) | Webhooks | Seconds | High |
| CRA / ESDC | No public webhooks. Browser automation + user uploads | Hours | User+automation |
| Pediatric clinic portals | No APIs in ~95% of CA clinics. Browser automation per-portal | Hours | Per-portal |

### 4.2 Webhook receiver pattern

```typescript
// Next.js: app/api/webhooks/[provider]/route.ts
export async function POST(req: Request, { params }) {
  const provider = params.provider;

  // 1. Verify signature (provider-specific)
  const signature = req.headers.get('x-webhook-signature');
  await verifyWebhookSignature(provider, signature, await req.text());

  // 2. Extract family_id (provider-specific lookup)
  const familyId = await resolveFamilyFromWebhook(provider, payload);

  // 3. Enqueue immediately, no inline processing
  await pgBoss.send('events.ingested', {
    family_id: familyId,
    source: provider,
    payload,
    received_at: new Date(),
  });

  // 4. Return 200 fast - workers handle the rest
  return new Response('ok', { status: 200 });
}
```

**Critical:** Webhook receivers MUST be fast (< 200ms) and idempotent. Provider-side timeouts cause retries; dedup_hash prevents double-processing.

### 4.3 OAuth connection flow

Per integration: OAuth 2.0 standard flow → encrypted token storage in `integrations` table → register webhook subscriptions where applicable → schedule periodic refresh. Each integration implements an `IntegrationProvider` interface (`connect`, `refresh`, `sync`, `disconnect`).

---

## Section 5 — Trust Escalation UX (L1 → L4 progression)

This is the product, not just a UX detail. The curve from L1 → L3 is what users pay for.

### 5.1 Onboarding (Day 1 to Week 1) — L1: Observe Only

- Connect Gmail + Calendar + Photos (progressive — one at a time, tied to value)
- Agent observes for 7 days, **takes no actions**
- Daily digest: "Here's what I noticed today" — shows classified events, NOT drafted actions
- Goal: build trust that the agent sees what it claims to see

### 5.2 Weeks 2-4 — L2: Draft for Approval

- After 7 days of observation, agent transitions to drafting
- Every proposed action appears in a "Draft" tab with the underlying event
- Parent approves/rejects each draft → agent learns from feedback
- Approval streaks count: 5 consecutive approvals for an action_type unlocks L3 for that type

### 5.3 Month 2+ — L3: Autonomous on Routine

- For action types with 5+ consecutive approvals, agent acts autonomously
- Result appears in evening digest with "I did this, here's why, want me to undo?"
- Every autonomous action has a 24-hour undo window (where reversible)
- Novel action types still go to Draft tab

### 5.4 Month 6+ — L4: Scope-Delegated

- User can grant "always handle [domain]" — e.g., "always handle pediatric clinic communications"
- Reviewer's policies remain in force; just the approval gating shifts to post-hoc audit
- High-stakes actions (spending > $X, communications to legal/medical) remain at L3 with explicit approval

### 5.5 UI patterns (key screens)

```
┌──────────────────────────────────────────────────┐
│  Today's Digest                       👶 [Avatar]│
├──────────────────────────────────────────────────┤
│  ✓ Confirmed vaccine appt for Thursday 10am      │  ← L3 action
│    → Pre-visit form attached. Undo                │
│                                                  │
│  ✓ Reordered diapers (size 2, 1 case)            │  ← L3 action
│    → Arriving Wed. $42.99. Undo                  │
│                                                  │
│  💭 The Toronto Public Library emailed about     │  ← L2 draft
│     baby story-time. I drafted an RSVP.           │
│    [Approve] [Skip] [Always handle these]         │
│                                                  │
│  🤔 Your kid had 6h continuous sleep last night   │  ← Coach insight
│     — first 6h block. Want sleep-training tips?  │
│    [Yes, brief me]                                │
│                                                  │
│  ⚠ Pediatric office sent a "please call us       │  ← Human queue
│     about lab results" email. I can't act on this │
│     — it needs you.                              │
│    [Open email] [Mark handled]                    │
└──────────────────────────────────────────────────┘
```

### 5.6 The Undo Promise

Every autonomous action has an explicit reversal path. If not reversible (e.g., email already sent), the digest says so up front and provides a "send correction" flow. **Undo is the product's safety net. Without it, L3 trust collapses on the first mistake.**

---

## Section 6 — Failure Modes & Safety

### 6.1 Classified failure modes

| Failure | Detection | Response |
|---|---|---|
| Classifier confidence < 0.7 | Built-in confidence score | Route to human_queue with raw signal |
| Drafter produces invalid action schema | Zod schema validation at output | Retry once with feedback; on 2nd fail, log + skip |
| Reviewer tool returns red flag | Tool result inspection | Reject action; surface to parent if expected to be aware |
| Executor API failure | Try/catch with typed errors | Retry with exponential backoff (3 attempts), then human_queue |
| Computer Use stuck on portal | 5-min timeout | Mark portal automation failed; surface with screenshot + manual link |
| Hallucinated tool argument | Tool input schema enforcement | Reject at tool boundary, retry with corrected args |
| Agent infinite loop | Max 10 subagent dispatches per top-level event | Kill, log, alert |
| Cost spike (single event > $1) | Per-event cost monitor | Kill mid-run, alert, audit |
| Memory write conflict (race) | Postgres advisory locks per family | Retry; second writer waits |

### 6.2 Safety policies (per family, configurable)

```typescript
interface SafetyPolicy {
  spending_caps: {
    per_action_max_usd: number;
    per_day_max_usd: number;
    per_month_max_usd: number;
    categories_requiring_approval: string[];
  };
  recipient_rules: {
    allowlist: string[];
    blocklist: string[];
    auto_add_if_replied_to: boolean;
    medical_recipients_require_approval: boolean;
    legal_recipients_require_approval: boolean;
  };
  time_window: {
    allow_actions_between: [string, string];
    timezone: string;
    blackout_dates: string[];
  };
  action_type_overrides: {
    [actionType: string]: 'always_ask' | 'autonomous_allowed' | 'never';
  };
  pii_protection: {
    redact_in_outgoing: boolean;
  };
}
```

### 6.3 The audit log promise

Every action — autonomous, drafted, or rejected — produces an immutable `audit_log` row. Family can request "show me everything you've done" and get the full chronological log: trigger event, classifier output, drafter output, reviewer tool results, execution result, who approved, undo state.

This is also the PIPEDA "right to access" mechanism.

### 6.4 The kill switch

Family-level setting: **"Pause all autonomous actions for 24 hours"**. One click. Reviewer rejects everything, agent only drafts. Useful when family is on vacation, dealing with crisis, or wants to take back control.

---

## Section 7 — Compliance & Trust

### 7.1 Canadian regulatory posture (launch market)

| Regulation | Scope | Our posture |
|---|---|---|
| **PIPEDA** (federal) | Private-sector personal info handling | Full compliance: consent, access, correction, deletion, breach notification, Privacy Officer |
| **Quebec Law 25** | Strictest privacy law in Canada — applies if any Quebec resident | Privacy by design, PIAs for new features, explicit consent for cross-border data, data portability |
| **CASL** (anti-spam) | Outbound electronic communications | Express consent for any agent-sent emails to non-family-approved recipients; clear sender ID |
| **Provincial health acts** | Health-related data | We do NOT diagnose. Coach flags-for-pediatrician on symptom queries. Medical data stored separately |

### 7.2 Data residency

- Postgres primary in Canadian region (Supabase Toronto or AWS ca-central-1)
- No cross-border data movement without explicit consent (Law 25)
- LLM API calls: Anthropic processes in US/EU. Consent flow discloses; family must accept. Anthropic does not retain customer data per ToS.
- Backups in Canadian region only

### 7.3 Consent design

- **Two-parent consent:** Both parents must consent before actions affecting either parent's data
- **Granular consent:** Per integration, per data type, per autonomous action class. Default most restrictive.
- **Time-limited consent:** Re-confirmed annually. Material policy changes trigger re-consent.

### 7.4 Future US expansion

- **COPPA:** applies to under-13 — parental consent fully covers newborn phase
- **CCPA / CPRA, VCDPA, CDPA:** state patchwork. Build for strictest (California) and degrade gracefully.

---

## Section 8 — Tech Stack & Repo Layout

### 8.1 Dependency choices

```
Language:       TypeScript 5.x (strict mode)
Runtime:        Node.js 22 LTS
Web framework:  Next.js 15 (App Router)
UI:             React 19 + Tailwind CSS 4 + shadcn/ui
Forms:          react-hook-form + zod
Auth:           Clerk (multi-tenant family handling)
Database:       Postgres 16 (Supabase Toronto region)
ORM:            Drizzle ORM + Drizzle Kit migrations
Queue:          pg-boss (Postgres-backed)
Agent SDK:      @anthropic-ai/claude-agent-sdk (TypeScript)
Anthropic SDK:  @anthropic-ai/sdk
Prompts:        Langfuse (hosted) — prompt versioning + tracing
Browser auto:   Claude Computer Use via Agent SDK
Observability:  Sentry (errors) + Langfuse (LLM traces) + Vercel Analytics
Email send:     Postmark
Payments:       Stripe
Deployments:    Vercel (Next.js) + Fly.io YYZ Toronto (Agent Worker)
Storage:        Supabase Storage OR Cloudflare R2
Secrets:        Doppler
Testing:        Vitest (unit) + Playwright (E2E) + Anthropic eval framework
Linting:        Biome
Type checking:  tsc --strict, runs in CI
Monorepo tool:  Turborepo with pnpm workspaces
```

### 8.2 Repository layout (Turborepo monorepo)

```
hale/
├── apps/
│   ├── web/                      # Next.js app (UI + thin API + webhooks)
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   └── package.json
│   │
│   └── worker/                   # Agent Worker service
│       ├── src/
│       │   ├── agents/           # Classifier, Drafter, Coach, Reviewer, Inferencer
│       │   ├── services/         # Orchestrator, MemoryWriter, Executor
│       │   ├── tools/            # Reviewer verification tools + Executor adapters
│       │   ├── queue/            # pg-boss consumers
│       │   └── index.ts
│       └── package.json
│
├── packages/
│   ├── db/                       # Drizzle schema + migrations (shared)
│   ├── types/                    # Shared TypeScript types
│   ├── memory/                   # Family memory graph helpers
│   ├── compliance/               # PIPEDA / Law 25 audit helpers
│   └── tools-contracts/          # Tool input/output schemas
│
├── docs/
│   ├── superpowers/specs/        # Design docs + plans
│   ├── architecture/             # ADRs
│   └── compliance/               # PIA documents, consent flow specs
│
├── infra/                        # Deployment configs
│   ├── vercel.json
│   ├── fly.toml
│   └── supabase/
│
├── .github/
│   └── workflows/                # CI: lint, typecheck, test, deploy
│
├── turbo.json
├── package.json
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
└── CLAUDE.md
```

### 8.3 Environment variable inventory

```
# Auth (Clerk)
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=

# Database
DATABASE_URL=
DATABASE_DIRECT_URL=

# Anthropic
ANTHROPIC_API_KEY=

# Langfuse
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=

# Integrations (OAuth client secrets)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Email
POSTMARK_API_KEY=

# Encryption
APP_ENCRYPTION_KEY=

# Observability
SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# Worker → web app communication (signed)
INTERNAL_API_SHARED_SECRET=

# Misc
NODE_ENV=
APP_URL=
WORKER_URL=
```

### 8.4 Deployment targets

| Service | Host | Why |
|---|---|---|
| Next.js web app | Vercel | Native Next.js, zero ops, global edge |
| Agent Worker | Fly.io (YYZ Toronto) | Long-running Node process, Canadian region for data residency |
| Postgres | Supabase (Toronto region) | Managed Postgres + auth + storage + vector ext, ca-central-1 |
| Object storage | Supabase Storage or Cloudflare R2 | User photos, PDFs, voice samples |
| Secrets | Doppler | Cross-env secrets sync, audit log |
| Observability | Sentry + Langfuse + Vercel Analytics | Errors / LLM / UI |
| DNS + CDN | Cloudflare | Standard |

---

## Section 9 — Phased Rollout (Platform-First with Design-Partner Discipline)

### Month 1-2 — Foundation

- Turborepo monorepo set up
- Auth + family/user model live
- Postgres schema + migrations
- Integrations: Gmail + Google Calendar OAuth working
- Webhook receivers operational
- pg-boss queue running, basic Orchestrator state machine
- Empty agents (stubs returning canned data) end-to-end through pipeline
- Sentry + Langfuse observability wired
- **Milestone:** End-to-end pipeline runs with stub agents; webhook → queue → stub agent → DB → digest. No real Claude calls yet.

### Month 3 — First Real Agent + Design Partner Cohort

- Classifier (real) + Drafter (real) for ONE event type — pediatric appointment reminder confirmations
- Reviewer with 4 verification tools — minimum viable safety
- Executor: Gmail send + Calendar create only
- L2-only: all actions surface as drafts; no autonomy yet
- Recruit 5-10 design-partner newborn families
- **Milestone:** 5+ families using product weekly; 10+ pediatric confirmations drafted/week; zero hallucinated actions reach users (L2 gate); NPS gathered

### Month 4-5 — Second + Third Features, L3 Unlocks

- Add: supply reorder autopilot (diapers, formula, wipes)
- Add: postpartum paperwork autopilot (EI, provincial leave forms)
- L3 enables per-action-type with 5-approval streak
- Add: undo flow + 24h reversibility window
- Add: Coach agent (read-only, no autonomous actions) — sleep, feeding, milestones
- **Milestone:** 10+ design partners; 60%+ of actions L3 autonomous; first viral "AI saved me 12 hours" testimonial

### Month 6-8 — Memory Inference + Coaching Expansion

- Memory Inferencer agent live (nightly batch)
- Coach: proactive prompts based on child age + milestones
- Add: photo curation + family sharing
- Add: pediatric clinic portal automation (Computer Use, one clinic at a time)
- Expand cohort to 50 families (invite-only)
- Pricing live: Free (L1+L2) / Plus $19/mo (L2+L3) / Family $49/mo (L3+L4 + commerce)
- **Milestone:** First paying customers. Per-family LLM cost validated against $5/mo target.

### Month 9-12 — Public Launch + US Expansion Prep

- Open signups (waitlist throttled)
- Marketing site + organic SEO content
- Add: thank-you note autopilot, RESP setup, baby SIN registration
- US market research + COPPA prep
- **Milestone:** 1,000 active Canadian families; clear unit economics; ready to expand

### Month 13-18 — US Launch + Preschool Phase

- US launch (CDC schedule, US insurance/HSA integration)
- Original cohort ages into preschool — agent capabilities expand
- Preschool features: Brightwheel integration, daycare admin, milestone tracking
- **Milestone:** 5,000 active families across CA+US; second age cohort live; sustained MRR

---

## Open Questions (deferred, not blocking implementation start)

1. **Specific Canadian pediatric clinic portals to prioritize for Computer Use automation.** Need to research which portal vendors dominate the Toronto/Vancouver/Montreal markets.
2. **CRA/ESDC API availability for parental benefits.** Some flows have APIs (limited); most don't. Mix of API + browser automation + user-uploaded confirmation.
3. **Auth provider final choice.** Clerk vs Supabase Auth. Clerk easier multi-tenant; Supabase Auth keeps stack uniform.
4. **Storage final choice.** Supabase Storage (uniform) vs Cloudflare R2 (cheaper at scale).
5. **Worker host final choice.** Fly.io YYZ Toronto preferred; Render Toronto-adjacent fallback.
6. **Project name domain availability.** hearth.ai, tryhearth.com, gethearth.com, hearth.family — to be verified.
7. **Pricing for paid tiers.** $19 / $49 are placeholders; real numbers come from design-partner WTP signal.
8. **Co-parenting (separated/divorced) support.** Deferred to v2 per scope decisions.
9. **Native mobile app.** Deferred — PWA-first; consider RN once retention validates.

---

## Next Steps After User Approval

1. User reviews this spec doc, requests changes if any
2. Invoke `superpowers:writing-plans` to create detailed implementation plan
3. Scaffold the Turborepo monorepo
4. Configure deployments (Vercel + Fly.io + Supabase)
5. Begin Month 1-2 foundation work
