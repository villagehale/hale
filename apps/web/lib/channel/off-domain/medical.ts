import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { SAFETY_REPLY } from './copy';

/**
 * The medical-symptom answer lane (founder-locked 2026-08-17).
 *
 * Every OTHER `safety_critical` category still gets the fixed 811/911 line in copy.ts —
 * a model must never be what tells a parent what to do about their child's head injury.
 * A `medical-symptom` is the one the founder decided Hale should ANSWER instead of
 * deflect: a parent who texts "she's had a fever for three days" was getting two phone
 * numbers and a closed door, which reads as a product that cannot rather than one being
 * careful. So this lane composes a real answer — every word model-generated, grounded in
 * a FRESH web search, coarse-age-aware, with the triage written into it — and the fixed
 * line survives only as the LAST RESORT when no grounded answer can be produced.
 *
 * Three phases, because none of them can be skipped safely:
 *
 *   0. SANITIZE. The one and only stage that sees the parent's raw words. It strips the
 *      child's name and any exact age/DOB and returns a de-identified clinical query plus
 *      a COARSE age band (pediatric triage is age-critical; a band is not identifying,
 *      rule #1). Only that de-identified query travels onward.
 *
 *   1. GROUND. A `web_search` server-tool turn on the clinical query. `tool_choice`
 *      cannot FORCE a server tool, so "always grounded" is made a code invariant rather
 *      than a prompt hope: we count the `web_search_tool_result` items the model actually
 *      produced, and ZERO is a failure. An ungrounded medical answer never ships.
 *
 *   2. COMPOSE. `forceToolJson` against the BLIND medical skill (it sees only the
 *      de-identified query + the research notes) → `{ answer, triage }`. The body is
 *      assembled with `plainText` and gated: GSM-7, within the segment ceiling, and — the
 *      positive requirement — carrying real triage. Missing any of that is a failure.
 *
 * FAIL CLOSED, THROUGH ONE DOOR. Every degradation — no client, a skill that would not
 * load, zero searches, an empty/oversized/non-GSM-7 body, missing triage — is a thrown
 * {@link MedicalUnresolvable} with a NAMED reason (rule #11). The turn is attempted, and
 * on any failure RETRIED ONCE; only if the retry also fails does {@link onMedicalTurnUnresolvable}
 * hand back the fixed {@link SAFETY_REPLY}. Never silence, never a generic "can't help"
 * line. That fallback is deliberately ONE function so the founder can later swap it for
 * defer/retry-until-generatable without touching the pipeline.
 *
 * WHY THIS BODY IS EXEMPT FROM THE HEALTH-LINE TRIPWIRE. `reachesForTheHealthLine`
 * (copy.ts) substitutes SAFETY_REPLY for any MODEL body that names 811/911, because on
 * the coach and general-answer paths a model reaching for those numbers means the screen
 * failed open. Here naming them is the whole point, so this lane never runs its output
 * through that tripwire — and it does not have to: the router sends a deflect `reply`
 * verbatim (route.ts sendReply), and this composer does its own assembly, never
 * `toSmsReply`/`sendable`.
 *
 * PRIVACY. The raw message reaches ONLY the sanitize call; the search and the compose see
 * the de-identified query alone. Nothing here logs the raw body — only a coarse reason,
 * the attempt number, and a provider error's message string (rule #1).
 */

/** The most a medical answer may run to. The founder's brief sets "~4 segments for this
 * lane only" (the coach and general answer stay at two); the SKILL targets ~4 (under ~600
 * GSM-7 chars). This HARD cap is one higher, at five, on purpose: the triage is never
 * trimmed to fit (a body over the cap FAILS to the fixed line rather than being cut), so
 * the margin is what stops a complete, correct emergency answer that lands at ~620 chars
 * from being destroyed down to the generic 811/911 line. JUDGMENT CALL (flagged for the
 * founder): tighten to 4 if the extra segment is unwanted. */
export const MAX_MEDICAL_SEGMENTS = 5;

const MAX_SEARCHES = 4;
const SANITIZE_MAX_TOKENS = 512;
const GROUND_MAX_TOKENS = 4096;
/** Generous on purpose: forceToolJson throws on a max_tokens cutoff, and a triage cut
 * mid-sentence is exactly what must never ship. */
const COMPOSE_MAX_TOKENS = 1024;

export const AGE_BANDS = [
  'infant_under_3mo',
  'infant',
  'toddler',
  'preschooler',
  'school_age',
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** Where the words that go out came from. `web_grounded` is the composed, searched
 * answer; `fixed` is the last-resort {@link SAFETY_REPLY} after a live attempt and a
 * retry both failed. */
export type MedicalReplySource = 'web_grounded' | 'fixed';

export interface MedicalReply {
  reply: string;
  replySource: MedicalReplySource;
}

export interface MedicalComposer {
  answer(text: string): Promise<MedicalReply>;
}

/**
 * Why a medical turn could not be answered — four different operational stories plus the
 * three ways the model's own output is unusable, deliberately not folded into one.
 * `not_grounded` is the invariant this lane exists to hold: a medical answer that did not
 * actually search is not a medical answer.
 */
export type MedicalFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'sanitize_failed'
  | 'ground_failed'
  | 'not_grounded'
  | 'compose_failed'
  | 'missing_triage'
  | 'unsendable';

class MedicalUnresolvable extends Error {
  constructor(
    readonly reason: MedicalFallback,
    readonly detail?: string,
  ) {
    super(reason);
    this.name = 'MedicalUnresolvable';
  }
}

const sanitizeSchema = z.object({
  clinical_query: z.string(),
  // Parsed LOOSELY, then normalized in code — a strict z.enum would turn an
  // off-list band into a thrown ZodError whose message could echo the request (rule #1),
  // and screen.ts/answer.ts hold the same line.
  age_band: z.string().nullish(),
  duration: z.string().nullish(),
});

const sanitizeJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    clinical_query: { type: 'string' },
    age_band: { type: 'string', enum: [...AGE_BANDS] },
    duration: { type: 'string' },
  },
  required: ['clinical_query'],
};

const composeSchema = z.object({
  answer: z.string(),
  triage: z.string(),
  sources: z.array(z.string()).nullish(),
});

const composeJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    triage: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'triage'],
};

interface ClinicalQuery {
  clinicalQuery: string;
  ageBand: AgeBand | null;
  duration?: string;
}

/** The sanitize turn's payload — the ONLY call the raw message reaches. */
export function sanitizeUserMessage(text: string): string {
  return JSON.stringify({ text });
}

/** The search + compose payloads: the de-identified query and nothing that could
 * identify the child. Shared with the eval, which replicates this shape. */
export function groundUserMessage(q: ClinicalQuery): string {
  return JSON.stringify({
    clinical_query: q.clinicalQuery,
    ...(q.ageBand ? { age_band: q.ageBand } : {}),
    ...(q.duration ? { duration: q.duration } : {}),
  });
}

export function composeUserMessage(q: ClinicalQuery & { researchNotes: string }): string {
  return JSON.stringify({
    clinical_query: q.clinicalQuery,
    ...(q.ageBand ? { age_band: q.ageBand } : {}),
    ...(q.duration ? { duration: q.duration } : {}),
    research_notes: q.researchNotes,
  });
}

/** The one thing any catch may keep: the message string. A provider error can echo the
 * request, so the object never survives (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function normalizeAgeBand(raw: unknown): AgeBand | null {
  return typeof raw === 'string' && (AGE_BANDS as readonly string[]).includes(raw)
    ? (raw as AgeBand)
    : null;
}

/** Whether a body carries the triage numbers. The positive requirement that makes
 * "always triaged" checkable: a composed answer that names neither 811 nor 911 has no
 * triage in it, whatever the model intended. This is NOT reachesForTheHealthLine — that
 * one SUBSTITUTES the fixed line; this one REQUIRES the numbers be present. */
function namesUrgentCare(body: string): boolean {
  return /\b(?:811|911)\b/.test(body);
}

/** How many real web-search results the model produced. An error result is not a result,
 * so a search that ran but failed counts as zero — which is the point (rule #11:
 * "did the work, found nothing" is not "was grounded"). Mirrors web-grounded.ts. */
function countSearchResults(content: Anthropic.ContentBlock[]): number {
  let total = 0;
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    total += block.content.length;
  }
  return total;
}

function researchText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * One full attempt: sanitize, ground, compose, assemble. Returns the sendable body, or
 * throws a {@link MedicalUnresolvable} naming the phase that failed. Never returns an
 * ungrounded, untriaged, or unsendable body — those are throws.
 */
async function runMedicalOnce(client: () => AgentClient, text: string): Promise<string> {
  let resolved: AgentClient;
  try {
    resolved = client();
  } catch (err) {
    throw new MedicalUnresolvable('client_unavailable', message(err));
  }

  let sanitizeSkill: Awaited<ReturnType<typeof loadCronSkill>>;
  let medicalSkill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    sanitizeSkill = await loadCronSkill('medical-sanitize');
    medicalSkill = await loadCronSkill('medical-symptom');
  } catch (err) {
    throw new MedicalUnresolvable('skill_unavailable', message(err));
  }

  // Phase 0 — SANITIZE (drop name + exact age; keep a coarse band).
  let sanitized: z.infer<typeof sanitizeSchema>;
  try {
    ({ value: sanitized } = await forceToolJson({
      client: resolved,
      model: pickModel(sanitizeSkill.meta.task),
      system: sanitizeSkill.instructions,
      userMessage: sanitizeUserMessage(text),
      toolName: 'sanitize',
      toolDescription: 'Return the de-identified clinical query.',
      inputJsonSchema: sanitizeJsonSchema,
      schema: sanitizeSchema,
      maxTokens: SANITIZE_MAX_TOKENS,
    }));
  } catch {
    // No detail captured on purpose: this is the one call whose request holds the raw
    // message, so its error string is the one that could echo it back (rule #1).
    throw new MedicalUnresolvable('sanitize_failed');
  }

  const clinicalQuery = sanitized.clinical_query.trim();
  if (clinicalQuery === '') throw new MedicalUnresolvable('sanitize_failed', 'empty query');
  const duration = sanitized.duration?.trim();
  const query: ClinicalQuery = {
    clinicalQuery,
    ageBand: normalizeAgeBand(sanitized.age_band),
    ...(duration ? { duration } : {}),
  };

  // Phase 1 — GROUND (web_search on the de-identified query only).
  let research: Anthropic.Message;
  try {
    research = await resolved.messages.create({
      model: pickModel(medicalSkill.meta.task),
      max_tokens: GROUND_MAX_TOKENS,
      system: medicalSkill.instructions,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
      messages: [{ role: 'user', content: groundUserMessage(query) }],
    });
  } catch (err) {
    throw new MedicalUnresolvable('ground_failed', message(err));
  }
  if (countSearchResults(research.content) === 0) throw new MedicalUnresolvable('not_grounded');

  // Phase 2 — COMPOSE (blind: the query + the research, never the raw message).
  let composed: z.infer<typeof composeSchema>;
  try {
    ({ value: composed } = await forceToolJson({
      client: resolved,
      model: pickModel(medicalSkill.meta.task),
      system: medicalSkill.instructions,
      userMessage: composeUserMessage({ ...query, researchNotes: researchText(research.content) }),
      toolName: 'medical_answer',
      toolDescription: 'Return the plain-language answer and the explicit triage guidance.',
      inputJsonSchema: composeJsonSchema,
      schema: composeSchema,
      maxTokens: COMPOSE_MAX_TOKENS,
    }));
  } catch (err) {
    throw new MedicalUnresolvable('compose_failed', message(err));
  }

  // Triage is required BEFORE assembly and confirmed AFTER it, so neither a model that
  // returned an empty triage field nor an assembly that dropped the numbers can ship.
  if (!namesUrgentCare(plainText(composed.triage))) throw new MedicalUnresolvable('missing_triage');
  const body = plainText(`${composed.answer} ${composed.triage}`);
  if (body === '') throw new MedicalUnresolvable('unsendable', 'empty');
  if (smsEncoding(body) !== 'gsm7') throw new MedicalUnresolvable('unsendable', 'not_gsm7');
  if (smsSegments(body) > MAX_MEDICAL_SEGMENTS) {
    throw new MedicalUnresolvable('unsendable', 'over_segment_cap');
  }
  if (!namesUrgentCare(body)) throw new MedicalUnresolvable('missing_triage', 'lost in assembly');
  return body;
}

/**
 * THE SINGLE SWAP POINT (founder-locked 2026-08-17: "safe line as last resort"). Reached
 * only after a live attempt AND one retry both failed to produce a real, grounded answer.
 * For now it is the fixed {@link SAFETY_REPLY}; if the founder moves to defer/
 * retry-until-generatable, this is the one function to change — the pipeline above stays.
 * Do NOT fold in the outage smoke-alarm path (route.ts / copy.ts EMERGENCY_TOKENS): that
 * is the model-UNREACHABLE case, and it is a separate, still-pending decision.
 */
function onMedicalTurnUnresolvable(): MedicalReply {
  return { reply: SAFETY_REPLY, replySource: 'fixed' };
}

function logMedicalFailure(err: unknown, attempt: number): void {
  const reason: MedicalFallback | 'unknown' =
    err instanceof MedicalUnresolvable ? err.reason : 'unknown';
  const detail = err instanceof MedicalUnresolvable ? err.detail : message(err);
  console.error({ reason, attempt, detail }, 'off-domain medical: turn could not be answered');
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER for the same reason the screen's and the general answer's are:
 * the router builds its dependencies for every inbound text, so a missing key must be an
 * honest `client_unavailable` failure rather than a throw at wiring time.
 */
export function createMedicalComposer(client: () => AgentClient): MedicalComposer {
  return {
    async answer(text) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return { reply: await runMedicalOnce(client, text), replySource: 'web_grounded' };
        } catch (err) {
          logMedicalFailure(err, attempt);
        }
      }
      return onMedicalTurnUnresolvable();
    },
  };
}
