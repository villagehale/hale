import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane, pickModel } from '@hale/agent';
import type { MedicalReplySourceValue } from '@hale/db';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { createMomentReply } from './moment-reply';

/**
 * The medical-symptom answer lane (founder-locked 2026-08-17).
 *
 * Every OTHER `safety_critical` category stops the ordinary answer and the moment
 * writer sends the reply (moment-reply.ts), in the parent's language. A
 * `medical-symptom` is the one the founder decided Hale should ANSWER: a parent who
 * texts "she's had a fever for three days" gets a real answer — every word
 * model-generated, grounded in a FRESH web search, coarse-age-aware, with the triage
 * written into it. When no grounded answer can be produced, the last resort is the
 * same moment writer, for a child-health reply. There is no preset sentence.
 *
 * Three phases, because none of them can be skipped safely:
 *
 *   0. SANITIZE. The one and only stage that sees the parent's raw words. It strips the
 *      child's name and any exact age/DOB and returns a de-identified clinical query plus
 *      a COARSE age band (pediatric triage is age-critical; a band is not identifying,
 *      rule #1). A deterministic {@link scrubResidualPii} backstop then strips any residual
 *      email/phone/postal/long-digit the model missed before the query crosses the border.
 *      Only that de-identified, scrubbed query travels onward. Because it is also the only
 *      stage that can see WHICH LANGUAGE the parent wrote in, it reports that too — see
 *      {@link ReplyLanguage}.
 *
 *   1. GROUND. A `web_search` server-tool turn on the clinical query. `tool_choice`
 *      cannot FORCE a server tool, so "always grounded" is made a code invariant rather
 *      than a prompt hope: we count the `web_search_tool_result` items the model actually
 *      produced, and ZERO is a failure. An ungrounded medical answer never ships.
 *
 *   2. COMPOSE. `forceToolJson` against the BLIND medical skill (it sees only the
 *      de-identified query + the research notes + the parent's language) → `{ answer,
 *      triage }`. The body is assembled with `plainText` and gated: within the segment
 *      ceiling, and — the positive requirement — carrying real triage. Missing either is
 *      a failure.
 *
 * IN THE PARENT'S LANGUAGE. A parent who texts a symptom in any language is answered in
 * it. Three things make that safe rather than merely nice: whether it is an EMERGENCY is
 * judged by the sanitize stage from the parent's own words, in whatever language they wrote
 * (see {@link isRedFlag}), not matched against an English word list; the clinical query
 * stays ENGLISH whatever the parent wrote (the pediatric search is English-keyed, and
 * {@link NON_ENGLISH_LETTERS} REFUSES a query that ignored it rather than trusting the
 * prompt); and whether the composed answer ESCALATES is judged by a model reading that
 * answer in its own language ({@link judgeEscalation}), so a correct "llévela a urgencias"
 * is not mistaken for an under-escalation and "no hace falta llamar al 911" is not
 * mistaken for a directive because it carries the digits.
 *
 * FAIL CLOSED, THROUGH ONE DOOR. Every degradation — no client, a skill that would not
 * load, zero searches, an empty/oversized body, missing triage — is a thrown
 * {@link MedicalUnresolvable} with a NAMED reason (rule #11). The turn is attempted, and
 * on any failure RETRIED ONCE; only if the retry also fails does {@link onMedicalTurnUnresolvable}
 * ask the moment writer for a child-health reply. Never silence, never a preset line.
 * If that reply cannot be written, the miss is named and nothing goes out. That fallback
 * is deliberately ONE function so the founder can later swap it for defer without
 * touching the pipeline.
 *
 * This lane does not run its output through a health-line swap. The router sends a
 * deflect `reply` verbatim (route.ts sendReply), and this composer does its own
 * assembly, never `toSmsReply`/`sendable`.
 *
 * PRIVACY. The raw message reaches ONLY the sanitize call; the search and the compose see
 * the de-identified query alone. Nothing here logs the raw body or any provider text —
 * only a coarse reason, the attempt number and a named detail (rule #1).
 */

/** The most a medical answer may run to. The founder's brief sets "~4 segments for this
 * lane only" (the coach and general answer stay at two); the SKILL targets ~4 (under ~600
 * GSM-7 chars). This HARD cap is one higher, at five, on purpose: the triage is never
 * trimmed to fit (a body over the cap FAILS to the fixed line rather than being cut), so
 * the margin is what stops a complete, correct emergency answer that lands at ~620 chars
 * from being destroyed down to the generic 811/911 line. JUDGMENT CALL (flagged for the
 * founder): tighten to 4 if the extra segment is unwanted.
 *
 * A SEGMENT count, not a character count, and that is what makes the one number correct
 * in three languages. Five segments is ~765 characters of GSM-7 and ~335 of UCS-2, because
 * UCS-2 bills 67 units a part where GSM-7 bills 153. CHINESE is always the UCS-2 case: a
 * CJK character is never in the GSM-7 alphabet, so a Chinese answer has ~335 characters to
 * work in — which is a lot of Chinese. FRENCH usually is NOT: e, e-grave, a-grave and
 * u-grave are all IN the GSM-7 alphabet, so most French answers bill as GSM-7 like English
 * — but c-cedilla, a-circumflex, o-circumflex and their kin are not, and one of them
 * anywhere in the body drops the whole thing to ~335. Which side of that line a French
 * answer lands on is not something the composer can plan around, so medical-symptom.md
 * asks FR and ZH alike to write to the tighter budget; the cap is the same either way. */
export const MAX_MEDICAL_SEGMENTS = 5;

const MAX_SEARCHES = 4;
const SANITIZE_MAX_TOKENS = 512;
const GROUND_MAX_TOKENS = 4096;
/** Generous on purpose: forceToolJson throws on a max_tokens cutoff, and a triage cut
 * mid-sentence is exactly what must never ship. */
export const COMPOSE_MAX_TOKENS = 1024;
/** Thinking and the reason share this on an adaptive lane (max_tokens caps both). */
const ESCALATION_MAX_TOKENS = 1024;

export const AGE_BANDS = [
  'infant_under_3mo',
  'infant',
  'toddler',
  'preschooler',
  'school_age',
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * The language the answer goes back in — the PARENT's, as read by the sanitize stage (the
 * only call that sees their words), as a language code (`es`, `ar`, `zh-Hant`).
 *
 * No list of languages: Hale answers in whatever language the parent wrote. The escalation
 * gate does not need one either — it is a judgment of the composed answer in that language
 * ({@link judgeEscalation}). A value that is not shaped like a language code normalizes to
 * `en` rather than throwing.
 *
 * A code is a language and at most ONE more subtag. The value is model output read off the
 * parent's own words and it is written into the compose and escalation requests, so an
 * open-ended run of subtags is room for a sentence; with one, there is none.
 */
export type ReplyLanguage = string;

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

/**
 * The sanitizer's reading of whether the parent described a pediatric emergency — judged
 * from the MEANING of their words, in any language, by the one stage that sees them. There
 * is no word list behind it: a parent describes a non-blanching rash or a stiff neck in
 * words no list holds, and in languages none was written for.
 */
export const RED_FLAG_READINGS = ['emergency', 'not_emergency', 'unsure'] as const;
export type RedFlagReading = (typeof RED_FLAG_READINGS)[number];

/** Where the words that go out came from. `web_grounded` is the composed, searched
 * answer; `fixed` is the last-resort moment reply after a live attempt and a retry both
 * failed. The two values are @hale/db's, because this outcome is STAMPED on the reply's
 * channel_messages row and read back by the founder scorecard — one vocabulary, checked
 * in SQL, not a second copy that can drift out of what is writable. `fixed` names the
 * fallback slot, not a preset sentence. */
export type MedicalReplySource = MedicalReplySourceValue;

export interface MedicalReply {
  reply: string;
  replySource: MedicalReplySource;
}

export interface MedicalComposer {
  answer(text: string): Promise<MedicalReply>;
}

/**
 * Why a medical turn could not be answered — four different operational stories plus the
 * ways the model's own output is unusable, deliberately not folded into one.
 * `not_grounded` is the invariant this lane exists to hold: a medical answer that did not
 * actually search is not a medical answer. `under_escalated` is its safety twin: a judged
 * red flag whose composed body was not judged an order to seek emergency care now (see
 * {@link judgeEscalation}); its detail names the reading and the verdict.
 * `escalation_unjudged` is that judgment not coming back at all — not the same story, so
 * not the same name. `sanitize_failed` carries one more
 * than its name suggests: a query the sanitizer left in the parent's language (detail
 * `query_not_english`), which the English-keyed search cannot use.
 */
export type MedicalFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'sanitize_failed'
  | 'ground_failed'
  | 'not_grounded'
  | 'compose_failed'
  | 'missing_triage'
  | 'under_escalated'
  | 'escalation_unjudged'
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
  // and screen.ts/answer.ts hold the same line. `language` is parsed the same way and for
  // the same reason; a sanitizer that returns none answers in English rather than costing
  // the parent their answer.
  language: z.string().nullish(),
  age_band: z.string().nullish(),
  duration: z.string().nullish(),
  red_flag_sign: z.string().nullish(),
  red_flag: z.string().nullish(),
});

const sanitizeJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  // The language first: it is read off the parent's words before they are rewritten into
  // the English query, which is what had a Chinese message reported as `en`.
  properties: {
    language: { type: 'string' },
    clinical_query: { type: 'string' },
    age_band: { type: 'string', enum: [...AGE_BANDS] },
    duration: { type: 'string' },
    red_flag_sign: { type: 'string' },
    red_flag: { type: 'string', enum: [...RED_FLAG_READINGS] },
  },
  // The sign before the verdict: a reading that names what it is judging on first.
  required: ['language', 'clinical_query', 'red_flag_sign', 'red_flag'],
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

/** What the escalation judgment may answer. Only `yes` ships a red-flag answer. */
const ESCALATION_VERDICTS = ['yes', 'no', 'unsure'] as const;

const escalationSchema = z.object({
  reason: z.string(),
  // Parsed loosely like `red_flag`: anything but `yes` falls closed, so an off-list value
  // needs no throw of its own.
  escalates: z.string(),
});

const escalationJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  // The reason before the verdict: the judgment says what the answer tells the parent
  // before it decides whether that is an order.
  properties: {
    reason: { type: 'string' },
    escalates: { type: 'string', enum: [...ESCALATION_VERDICTS] },
  },
  required: ['reason', 'escalates'],
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

/** The compose payload. It carries the one field the search deliberately does NOT get:
 * the parent's language. The search runs on English pediatric guidance whoever is asking,
 * and the query it runs is English by contract; the language matters only where words are
 * written FOR the parent, which is here. */
export function composeUserMessage(
  q: ClinicalQuery & { language: ReplyLanguage; researchNotes: string },
): string {
  return JSON.stringify({
    clinical_query: q.clinicalQuery,
    ...(q.ageBand ? { age_band: q.ageBand } : {}),
    ...(q.duration ? { duration: q.duration } : {}),
    language: q.language,
    research_notes: q.researchNotes,
  });
}

/** The escalation payload: the composed body the parent would receive and the language
 * they read — never their message. Shared with the eval, which replicates this shape. */
export function escalationUserMessage(body: string, language: ReplyLanguage): string {
  return JSON.stringify({ language, answer: body });
}

function normalizeAgeBand(raw: unknown): AgeBand | null {
  return typeof raw === 'string' && (AGE_BANDS as readonly string[]).includes(raw)
    ? (raw as AgeBand)
    : null;
}

/**
 * FAIL CLOSED: only an explicit `not_emergency` is not a red flag. `unsure`, a missing
 * reading and anything off the list all are, so the answer must then be judged an
 * emergency order or the turn falls to the fixed line, which names 911 itself.
 */
function isRedFlag(raw: unknown): boolean {
  return raw !== 'not_emergency';
}

function redFlagReading(raw: unknown): RedFlagReading {
  return typeof raw === 'string' && (RED_FLAG_READINGS as readonly string[]).includes(raw)
    ? (raw as RedFlagReading)
    : 'unsure';
}

/** The verdict as it may be logged: the schema parses it loosely, so off-list text from
 * the model is named, never echoed (rule #1). */
function escalationReading(raw: string): (typeof ESCALATION_VERDICTS)[number] | 'off_list' {
  return (ESCALATION_VERDICTS as readonly string[]).includes(raw)
    ? (raw as (typeof ESCALATION_VERDICTS)[number])
    : 'off_list';
}

/** English for anything the sanitizer did not report as a language code. Not null: every
 * answer is written in SOME language, and a nullable one would only push the same default
 * out to the caller. */
export function normalizeLanguage(raw: unknown): ReplyLanguage {
  const code = typeof raw === 'string' ? raw.trim() : '';
  return LANGUAGE_CODE.test(code) ? code : 'en';
}

/**
 * The ENGLISH-QUERY CONTRACT, held in code rather than asked for in a prompt.
 *
 * medical-sanitize.md instructs the sanitizer to write `clinical_query` and `duration` in
 * English whatever language the parent wrote in: the pediatric search downstream is
 * English-keyed, and a French or Chinese query does not fail loudly — it searches for the
 * wrong thing. A property that depends on a model following an instruction is not a
 * property, so the query is CHECKED.
 *
 * The pattern is the eval's (run-medical-symptom-eval.mjs): any LETTER outside plain
 * ASCII — an accent, CJK, Arabic, Hebrew, Cyrillic, any script a parent writes in. It is
 * deliberately blind to the things a real English clinical query contains — a degree sign,
 * a decimal temperature, a plain ASCII word — and every English query the live corpus
 * produced passes it untouched.
 */
const NON_ENGLISH_LETTERS = /[^\P{L}a-z]/iu;

function isEnglish(text: string): boolean {
  return !NON_ENGLISH_LETTERS.test(text);
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
 * The deterministic PII backstop — defense-in-depth UNDER the blind LLM sanitizer, never a
 * replacement for it. Phase 0 is a single model call, and the fields it returns ride to
 * Anthropic's US `web_search`: a cross-border disclosure of child health data (rule #1 /
 * PIPEDA / Law 25). So before anything crosses the border we mechanically strip the residual
 * identifier classes a regex CAN catch with near-zero false positives. A NAME is free-form
 * and stays the sanitizer's job; a street address and a named school are not free-form
 * enough to leave there, so both have a floor here (see the patterns for where each one's
 * precision line is drawn). This is the machine-checkable floor beneath the sanitizer, not
 * the whole de-id.
 *
 * Deliberately tuned NOT to touch the clinical values that make a search useful: a
 * temperature (39.5), a small count (vomited 4 times), a duration (3 days) have too few
 * consecutive digits to hit any pattern here. The age/DOB patterns hold the same line: an
 * age is only redacted when it is unambiguously an age — with an "old" anchor ("6 weeks
 * old"), the compound "N years N months" form, a bare year, or a bare month-count of 12+
 * (a toddler age, never a symptom duration). A bare "3 months" or "2 weeks" reads as a
 * duration and survives. The unit test's positive controls hold that line. Long runs are
 * stripped BEFORE the phone pattern so a >10-digit run is redacted whole rather than leaving
 * a trailing fragment.
 */
const RESIDUAL_PII_PATTERNS: RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, // email
  /\d{7,}/g, // long digit runs (health-card / account numbers)
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // NANP phone
  /\b[a-z]\d[a-z]\s?\d[a-z]\d\b/gi, // Canadian postal code
  // WHERE THEY LIVE, in the two forms a regex can hold with near-zero false positives.
  // A postal code was already here and a street was not, which is backwards: "L7G 4S6"
  // names a block and "42 Wallace St" names a door.
  /(?<![\p{L}\p{N}])\d{1,5}[a-z]?\s+(?:[\p{L}\p{N}'’.-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|cres|crescent|hwy|highway|pkwy|parkway|sideroad|concession)\b\.?/giu, // street address, unambiguous suffix
  // The same shape with suffixes that are also ORDINARY WORDS ("a 3 hour drive", "on the
  // court 3 days a week"), so here the street name must be capitalized. Narrower on
  // purpose: over-redaction costs the search a useful word, and this tier is the one that
  // would do it on a sentence that holds no address at all.
  /(?<![\p{L}\p{N}])\d{1,5}[a-z]?\s+(?:\p{Lu}[\p{L}'’.-]*\s+){0,2}\p{Lu}[\p{L}'’.-]*\s+(?:Dr|Drive|Ct|Court|Ln|Lane|Way|Pl|Place|Terrace|Trail|Cir|Circle|Sq|Square)\b\.?/gu, // street address, ambiguous suffix
  // A NAMED SCHOOL - where a child is five days a week. What has to be present is a
  // proper NAME in front of the institution word, because "school" on its own is an
  // activity word before it is a place ("after school program", "preschool swim",
  // "school year", "old school"). The name is what those all lack, and it is a cheaper
  // discriminator than the formal register: nobody texts "Separate School", and the four
  // formal suffixes let "St. Catherine of Alexandria school", "Holy Cross Elementary",
  // "Pineview Montessori" and "Georgetown Christian Academy" cross intact.
  /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}'’.-]*\s+(?:(?:of|de|du|des|la|le|the|and|et)\s+)?){1,4}(?:P\.S\.|(?:Public|Catholic|Separate|Elementary|Middle|Secondary|Junior High)\s+[Ss]chool|Junior High|High [Ss]chool)\b/gu, // named school, formal suffix (EN)
  // The institution word standing alone, which is how a school is named far more often
  // than with a suffix. Costs a venue that ends in one of these words ("Cartwheel
  // Academy") - the deliberate direction to err in, since over-redaction loses a search
  // term and under-redaction ships the building a child is in five days a week.
  /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}'’.-]*\s+(?:(?:of|de|du|des|la|le|the|and|et)\s+)?){1,4}(?:Elementary|Montessori|Academy|Prep|Preparatory|Collegiate)\b/gu, // named school, institution word as the tail (EN)
  // A bare "<Name> school". TWO capitalized name-words are required, and that minimum is
  // what holds the line: one word is a phrase ("Swim school"), and it is also what stops
  // a sentence boundary reading as a name ("We tried Milton. School registration opens").
  /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}'’.-]*\s+(?:(?:of|de|du|des|la|le|the|and|et)\s+)?){1,4}\p{Lu}[\p{L}'’.-]*\s+[Ss]chool\b/gu, // named school, bare head-noun (EN)
  // FR. A qualifier OR a capitalized name may follow "école"; "école de danse" is a venue
  // and survives, because "de" is neither.
  /(?<![\p{L}\p{N}])[ÉéEe]cole\s+(?:[ÉéEe]l[ée]mentaire|[Pp]rimaire|[Ss]econdaire|[Ii]nterm[ée]diaire|\p{Lu}[\p{L}'’.-]*)(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}/gu, // named school (FR)
  /\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, // DOB YYYY-MM-DD / YYYY/MM/DD
  /\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/g, // DOB M/D/YYYY or D/M/YYYY
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2}\b/gi, // DOB "Month D, YYYY"
  /\b\d{1,2}\s?(?:years?|yrs?)\s?(?:and\s)?\d{1,2}\s?(?:months?|mos?)(?:[\s-]?old)?\b/gi, // exact age "2 years 3 months (old)"
  /\b\d{1,3}[\s-]?(?:year|yr|month|mo|week|wk|day)s?[\s-]?old\b/gi, // exact age "6 weeks old", "18-month-old"
  /\b(?:1[2-9]|[2-9]\d)\s?months?\b/gi, // exact age "18 months", "27 months" (12+ = toddler age, not a duration)
  /\b\d{1,2}\s?years?\b/gi, // exact age "2 years", "3 years"
];
const REDACTED = '[redacted]';

export function scrubResidualPii(text: string): string {
  return RESIDUAL_PII_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, REDACTED), text);
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
  } catch {
    throw new MedicalUnresolvable('client_unavailable');
  }

  let sanitizeSkill: Awaited<ReturnType<typeof loadCronSkill>>;
  let medicalSkill: Awaited<ReturnType<typeof loadCronSkill>>;
  let escalationSkill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    sanitizeSkill = await loadCronSkill('medical-sanitize');
    medicalSkill = await loadCronSkill('medical-symptom');
    escalationSkill = await loadCronSkill('medical-escalation');
  } catch {
    throw new MedicalUnresolvable('skill_unavailable');
  }

  // Phase 0 — SANITIZE (drop name + exact age; keep a coarse band).
  let sanitized: z.infer<typeof sanitizeSchema>;
  try {
    ({ value: sanitized } = await forceToolJson({
      client: resolved,
      lane: pickLane(sanitizeSkill.meta.task),
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
  const language = normalizeLanguage(sanitized.language);
  // Deterministic backstop UNDER the blind sanitizer: strip any residual identifier the model
  // missed from the two fields that cross the border (the query AND the duration) before they
  // reach web_search. See scrubResidualPii.
  const query: ClinicalQuery = {
    clinicalQuery: scrubResidualPii(clinicalQuery),
    ageBand: normalizeAgeBand(sanitized.age_band),
    ...(duration ? { duration: scrubResidualPii(duration) } : {}),
  };
  // The English-query contract (see NON_ENGLISH_LETTERS): an untranslated query would
  // search for the wrong thing rather than fail, so it is refused here. The detail names the
  // reason and carries none of the text (rule #1). A sanitize_failed is retried once,
  // which gives the model a second chance to translate before the fixed line.
  if (!isEnglish(query.clinicalQuery) || (query.duration && !isEnglish(query.duration))) {
    throw new MedicalUnresolvable('sanitize_failed', 'query_not_english');
  }

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
  } catch {
    throw new MedicalUnresolvable('ground_failed');
  }
  if (countSearchResults(research.content) === 0) throw new MedicalUnresolvable('not_grounded');

  // Phase 2 — COMPOSE (blind: the query + the research, never the raw message).
  let composed: z.infer<typeof composeSchema>;
  try {
    ({ value: composed } = await forceToolJson({
      client: resolved,
      lane: pickLane(medicalSkill.meta.task),
      system: medicalSkill.instructions,
      userMessage: composeUserMessage({
        ...query,
        language,
        researchNotes: researchText(research.content),
      }),
      toolName: 'medical_answer',
      toolDescription: 'Return the plain-language answer and the explicit triage guidance.',
      inputJsonSchema: composeJsonSchema,
      schema: composeSchema,
      maxTokens: COMPOSE_MAX_TOKENS,
    }));
  } catch {
    throw new MedicalUnresolvable('compose_failed');
  }

  // Triage is required BEFORE assembly and confirmed AFTER it, so neither a model that
  // returned an empty triage field nor an assembly that dropped the numbers can ship.
  if (!namesUrgentCare(plainText(composed.triage))) throw new MedicalUnresolvable('missing_triage');
  const body = plainText(`${composed.answer} ${composed.triage}`);
  if (body === '') throw new MedicalUnresolvable('unsendable', 'empty');
  // ONE ceiling, counted in the currency the carrier bills: `smsSegments` measures a
  // French or Chinese body against UCS-2's 67 units a part rather than GSM-7's 153, so
  // this is the same limit in every language. The GSM-7 REJECT that used to sit here is
  // gone with the reason it existed: it fell every accented-French and every Chinese
  // answer closed to the English safety line (answer.ts made the same move first).
  if (smsSegments(body) > MAX_MEDICAL_SEGMENTS) {
    throw new MedicalUnresolvable('unsendable', 'over_segment_cap');
  }
  if (!namesUrgentCare(body)) throw new MedicalUnresolvable('missing_triage', 'lost in assembly');
  // The escalation invariant. namesUrgentCare only proves a number is PRESENT — 811 alone
  // passes it, and so does "no need to call 911" — so a mis-triaged emergency ships through
  // every gate above. This is the one that catches it: a judged red flag — `unsure`
  // included — whose body is not judged an order to get emergency care now fails CLOSED to
  // the fixed line, which itself names 911 — strictly safer than shipping an
  // under-escalation.
  if (isRedFlag(sanitized.red_flag)) {
    const verdict = await judgeEscalation(resolved, escalationSkill, body, language);
    if (verdict !== 'yes') {
      throw new MedicalUnresolvable(
        'under_escalated',
        `${redFlagReading(sanitized.red_flag)}:${escalationReading(verdict)}`,
      );
    }
  }
  return body;
}

/**
 * Whether the composed body tells the parent to get emergency care NOW, in the language
 * they read — judged by a model over the body itself, in whatever language it is written.
 *
 * Not a phrase list: a list knows the languages it was written for, and a negation in any
 * other ("no hace falta llamar al 911") carries the digits and no negator it holds, so it
 * reads as the very order it rules out. The judgment sees the body and the language code
 * only — never the parent's message — and anything but `yes` is the caller's to fail
 * closed; a judgment that does not come back at all is `escalation_unjudged`.
 */
async function judgeEscalation(
  client: AgentClient,
  skill: Awaited<ReturnType<typeof loadCronSkill>>,
  body: string,
  language: ReplyLanguage,
): Promise<string> {
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: escalationUserMessage(body, language),
      toolName: 'escalation',
      toolDescription: 'Return whether the answer orders emergency care now.',
      inputJsonSchema: escalationJsonSchema,
      schema: escalationSchema,
      maxTokens: ESCALATION_MAX_TOKENS,
    });
    return value.escalates;
  } catch {
    throw new MedicalUnresolvable('escalation_unjudged');
  }
}

/**
 * THE SINGLE SWAP POINT. Reached only after a live attempt AND one retry both failed
 * to produce a real, grounded answer. The moment writer writes the child-health reply
 * in the parent's language. If that cannot be written, the miss is thrown by name and
 * nothing preset goes out. Do NOT fold in the outage smoke-alarm path: that is the
 * model-UNREACHABLE case, and it defers rather than sending a preset body.
 */
async function onMedicalTurnUnresolvable(
  client: () => AgentClient,
  text: string,
): Promise<MedicalReply> {
  const written = await createMomentReply(client).write(text, 'child_health');
  if (written.status === 'unwritten') {
    console.error(
      { reason: written.reason, moment: 'child_health' },
      'off-domain medical: moment reply unwritten',
    );
    throw new MedicalUnresolvable('compose_failed', `moment_unwritten:${written.reason}`);
  }
  return { reply: written.reply, replySource: 'fixed' };
}

function logMedicalFailure(err: unknown, attempt: number): void {
  const reason: MedicalFallback | 'unknown' =
    err instanceof MedicalUnresolvable ? err.reason : 'unknown';
  // Named sub-reasons only: a provider's error text can carry the request back (rule #1).
  const detail = err instanceof MedicalUnresolvable ? err.detail : undefined;
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
      return onMedicalTurnUnresolvable(client, text);
    },
  };
}
