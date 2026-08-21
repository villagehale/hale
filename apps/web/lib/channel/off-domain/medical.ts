import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel } from '@hale/agent';
import type { MedicalReplySourceValue } from '@hale/db';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { replyLanguage } from '~/lib/channel/language';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { SAFETY_REPLY_BY_LANGUAGE } from './copy';

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
 * IN THE PARENT'S LANGUAGE. A parent who texts a symptom in French or Chinese is answered
 * in it. Two things make that safe rather than merely nice: the clinical query stays
 * ENGLISH whatever the parent wrote (the red-flag lexicon and the pediatric search are
 * English-keyed — medical-sanitize.md is emphatic about it, and {@link NON_ENGLISH_LETTERS}
 * REFUSES a query that ignored it rather than trusting the prompt), and the escalation gate
 * below reads all three languages, so a correct "allez aux urgences" is not mistaken for
 * an under-escalation and a French under-escalation is not mistaken for a directive.
 *
 * FAIL CLOSED, THROUGH ONE DOOR. Every degradation — no client, a skill that would not
 * load, zero searches, an empty/oversized body, missing triage — is a thrown
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
const COMPOSE_MAX_TOKENS = 1024;

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
 * only call that sees their words).
 *
 * Three and no more, deliberately: each one needs an emergency-directive matcher written
 * for it ({@link hasEmergencyDirective}) before an answer in it may ship, so the list is
 * bounded by what the safety gate can actually read, not by what the model can write.
 * An unrecognised value normalizes to `en` rather than throwing — the same "if you
 * genuinely cannot tell, English is the safe default" the general-answer skill takes.
 */
export const REPLY_LANGUAGES = ['en', 'fr', 'zh'] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

/** Where the words that go out came from. `web_grounded` is the composed, searched
 * answer; `fixed` is the last-resort {@link SAFETY_REPLY} after a live attempt and a
 * retry both failed. The two values are @hale/db's, because this outcome is STAMPED on
 * the reply's channel_messages row and read back by the founder scorecard — one
 * vocabulary, checked in SQL, not a second copy that can drift out of what is writable. */
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
 * actually search is not a medical answer. `under_escalated` is its safety twin: a detected
 * red flag whose composed body never said "seek emergency care" (see {@link detectRedFlag}).
 * `sanitize_failed` carries one more than its name suggests: a query the sanitizer left in
 * the parent's language (detail `query_not_english`), which would blind that detector.
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
  // the same reason; it also stays OPTIONAL, so a sanitizer that returns no language
  // answers in English rather than costing the parent their answer.
  age_band: z.string().nullish(),
  duration: z.string().nullish(),
  language: z.string().nullish(),
});

const sanitizeJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    clinical_query: { type: 'string' },
    age_band: { type: 'string', enum: [...AGE_BANDS] },
    duration: { type: 'string' },
    language: { type: 'string', enum: [...REPLY_LANGUAGES] },
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

/** English for anything the sanitizer did not report as one of the three. Not null: every
 * answer is written in SOME language, and a nullable one would only push the same default
 * out to the caller. */
function normalizeLanguage(raw: unknown): ReplyLanguage {
  return typeof raw === 'string' && (REPLY_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as ReplyLanguage)
    : 'en';
}

/**
 * The ENGLISH-QUERY CONTRACT, held in code rather than asked for in a prompt.
 *
 * medical-sanitize.md instructs the sanitizer to write `clinical_query` and `duration` in
 * English whatever language the parent wrote in, and it explains why at length. That
 * instruction is load-bearing in a way no other prompt line here is: everything downstream
 * is English-keyed, and {@link detectRedFlag}'s lexicon is English ENTIRELY. A French or
 * Chinese query does not fail loudly — it BLINDS the detector, which turns the whole
 * escalation invariant below into a check that cannot fire. A safety property that depends
 * on a model following an instruction is not a safety property, so the query is CHECKED.
 *
 * The pattern is the eval's (run-medical-symptom-eval.mjs), which calibrates it over the
 * FR/ZH corpus: any CJK/Kana/Hangul character, or one of the Latin accents French carries.
 * It is deliberately blind to the things a real English clinical query contains — a degree
 * sign, a decimal temperature, a plain ASCII word — and every English query the live corpus
 * produced passes it untouched.
 */
const NON_ENGLISH_LETTERS =
  /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]|[\u00e0\u00e2\u00e4\u00e3\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc\u00fd\u00ff\u00e7\u00f1\u0153\u00e6]/iu;

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

/** Fever mentioned and not explicitly negated. Used ONLY inside the age-aware
 * under-3-months rule below — everywhere else a fever is not itself a red flag, so this
 * stays private to {@link detectRedFlag}. The negation guard stops "no fever"/"afebrile"
 * from firing the infant rule on a well baby. */
const FEVER_TERMS = /\bfever\b|\bfebrile\b|\btemperature\b|\btemp\b|\b\d{2,3}(?:\.\d)?\s?°?[cf]\b/i;
const FEVER_NEGATED = /\bno fever\b|\bwithout fever\b|\bafebrile\b|\bno temperature\b/i;
function mentionsFever(t: string): boolean {
  return FEVER_TERMS.test(t) && !FEVER_NEGATED.test(t);
}

/** A young infant, from the coarse band OR an explicit "under 3 months" left in the query
 * (a coarse band, not an exact age, so it survives the sanitizer). */
const YOUNG_INFANT_TEXT = /under (?:3|three) months|younger than (?:3|three) months|\bnewborn\b/i;

/** Neck stiffness — a meningitis red flag only ALONGSIDE fever, never on its own (a stiff
 * neck from sleeping awkwardly is benign). */
const STIFF_NECK = /\bstiff neck\b|\bneck (?:is )?stiff\b|neck stiffness/i;

/**
 * The unambiguous pediatric emergencies — each a red flag on its own, at any age.
 * Deliberately CONSERVATIVE: every term here is one that does not turn up describing a well
 * child (a mild cold, teething), because a detector that over-fires would replace a good
 * grounded answer with the fixed line — its own harm (alarm fatigue, a product that "can't
 * help"). Fever, sore throat and an ordinary rash are absent on purpose; they are red flags
 * only in the compound rules ({@link STIFF_NECK} + fever; fever in a young infant) below.
 */
const RED_FLAG_TERMS: RegExp[] = [
  /trouble breathing|difficulty breathing|labou?red breathing|struggling to breathe|working (?:really |very )?hard to breathe|can'?t breathe|cannot breathe|not breathing|gasping for (?:air|breath)|\bgrunting\b/i,
  /ribs? (?:are )?pulling in|pulling in (?:with|under|between)[^.]{0,20}(?:breath|rib)|\bretractions?\b|chest (?:is )?(?:sucking|caving) in/i,
  /blue lips|dusky lips|lips (?:look|turning|are|went|are turning) (?:a bit )?(?:blue|dusky|grey|gray)|blue (?:around|round) the (?:lips|mouth)|turning blue|going blue/i,
  /\bseizure\b|\bseizing\b|\bconvulsion\b|\bconvulsing\b/i,
  /\bunresponsive\b|won'?t wake|will not wake|can'?t wake|cannot wake|hard to wake|difficult to wake|not waking|won'?t respond|not responding|\blimp\b|\bfloppy\b|\blethargic\b|\blethargy\b|\bunconscious\b|passed out/i,
  /non-?blanching|\bpetechiae?\b|petechial|\bpurpura\b|does ?n[o']?t fade|do not fade|don'?t fade|will not fade|won'?t fade/i,
  /anaphyla|face (?:is )?swelling|swelling of (?:the |her |his )?face|swollen face|lips (?:are )?swelling|swollen lips|tongue (?:is )?swelling|swollen tongue|throat (?:is )?(?:swelling|closing|tightening)/i,
  /sunken eyes|sunken fontanelle|no wet (?:diaper|nappy)|not urinating|no urine|no tears when (?:crying|she cries|he cries)|severe(?:ly)? dehydrat/i,
];

/**
 * Whether the de-identified clinical query describes a genuine pediatric emergency. Runs on
 * the SANITIZED (and scrubbed) query plus the coarse age band — the same inputs the search
 * saw. This is the conservative half of the escalation invariant: if this fires, the answer
 * that ships MUST carry an emergency directive ({@link hasEmergencyDirective}) or the lane
 * falls closed. Exported for direct unit testing and mirrored by the eval gate.
 */
export function detectRedFlag(clinicalQuery: string, ageBand: AgeBand | null): boolean {
  const t = clinicalQuery.toLowerCase();
  if (RED_FLAG_TERMS.some((re) => re.test(t))) return true;
  if (STIFF_NECK.test(t) && mentionsFever(t)) return true;
  if ((ageBand === 'infant_under_3mo' || YOUNG_INFANT_TEXT.test(t)) && mentionsFever(t)) return true;
  return false;
}

/**
 * Whether a body carries an explicit EMERGENCY instruction — the positive half of the
 * escalation invariant. Unlike {@link namesUrgentCare}, the presence of 811 (the non-urgent
 * nurse line) does NOT satisfy this: "watch and wait, call 811" names a number but escalates
 * nothing. Only a real "call 911 / go to the ER / seek emergency care now" counts. Exported
 * for direct unit testing and mirrored by the eval gate.
 *
 * It reads all three languages the lane answers in, because an English-only matcher over a
 * French or Chinese body is wrong in BOTH directions: it falls a correct "emmenez-la aux
 * urgences" closed to the fixed English line, and — the direction that hurts — it cannot
 * tell that body apart from "ce n'est pas une urgence, appelez le 811", so the gate stops
 * gating the moment the parent stops writing in English.
 *
 * Four properties of the lists below are load-bearing:
 *
 *   · 911 IS THE UNIVERSAL ANCHOR. The digits mean the same thing in every language, and
 *     the skill requires the triage to name them, so this is the pattern that fires on
 *     nearly every real escalation. The per-language phrases are the belt to that braces:
 *     they carry a body that says "go now" without printing a number.
 *   · THE FRENCH LIST IS DIRECTIVES, NOT THE NOUN "urgence". A bare `urgence` also matches
 *     "ce n'est pas une urgence" — the exact under-escalation this check exists to catch —
 *     so only the go-there forms count: `aux urgences`, `a l'urgence` (Quebec), `salle
 *     d'urgence`, `soins d'urgence`. `ambulance` is spelled the same in both languages and
 *     lives in the English list; it is not repeated here.
 *   · CHINESE IS THE IMPERATIVE FORMS. 急诊 (the ER), 急救 / 救护车 (emergency aid, an
 *     ambulance) and 立即/马上/立刻 + 就医/就诊/送医 ("get seen NOW"). Deliberately absent:
 *     尽快就医 ("get seen soon"), which is the 811 register wearing an urgent coat. 急救 is
 *     the noun a first-aid KIT is named after, so 急救箱/急救包 in a cupboard is excluded.
 *   · A MATCH IS ONLY A DIRECTIVE WHEN NOTHING NEGATED IT — see {@link DIRECTIVE_NEGATION}.
 */
const EMERGENCY_NUMBER = /\b911\b/;
const EMERGENCY_DIRECTIVE_EN =
  /\bER\b|\bA&E\b|emergency (?:room|department|care|services|help)|\bambulance\b|seek (?:emergency|immediate|urgent) (?:medical )?care|urgent medical care/i;
const EMERGENCY_DIRECTIVE_FR =
  /aux urgences|[àa] l['’ ]urgence|salle d['’ ]urgence|service des urgences|soins (?:m[ée]dicaux )?d['’ ]urgence/i;
const EMERGENCY_DIRECTIVE_ZH = /急诊|急救(?![箱包])|救护车|(?:立即|马上|立刻)(?:就医|就诊|送医|去医院)/;

/**
 * The negation guard, built the way {@link FEVER_NEGATED} is: a term the detector matches
 * counts only when nothing NEGATED it. Every phrase above names the emergency, and naming
 * it is exactly how a body rules it OUT — "no need for the ER, call 811", "pas besoin
 * d'aller aux urgences", "不需要去急诊" all matched, all named 811 and no 911, and all
 * shipped as escalations of a detected red flag.
 *
 * A NEGATED CLAUSE IS NOT READ AT ALL — not the text after the negator, the whole clause.
 * All three languages rule a thing out by naming it first as readily as last ("a trip to
 * the ER is not necessary", "aller aux urgences n'est pas nécessaire", "去急诊不必要"), so a
 * guard that only looked backward from the match would take the ruling-out for the order.
 * The CLAUSE is what keeps that from swallowing the rest of the body: "no need to panic,
 * but take her to the ER now" escalates, because the second clause carries no negator.
 *
 * The negators are the "you don't have to" register, NOT bare `not`/`don't`: a real
 * directive is routinely written "don't wait, go to the ER" / "ne tardez pas" / "不要等",
 * so a bare-negator list would fall real emergencies closed. Bodies here have already been
 * through {@link plainText}, which folds en/em dashes to a spaced hyphen and curly quotes
 * to straight ones — the boundary set reads what actually arrives.
 */
const CLAUSE_BOUNDARY = /[.!?;:,\n。！？；：、，]|\s-\s/;
const DIRECTIVE_NEGATION =
  /\bno (?:need|reason)\b|(?:\bnot|n['’]t)\s+(?:need|necessary|have to)|\bpas besoin\b|\bpas n[ée]cessaire\b|\bn['’]est pas\b|\binutile\b|不需要|不用|无需|不必/i;

export function hasEmergencyDirective(body: string): boolean {
  return body.split(CLAUSE_BOUNDARY).some(
    (clause) =>
      !DIRECTIVE_NEGATION.test(clause) &&
      (EMERGENCY_NUMBER.test(clause) ||
        EMERGENCY_DIRECTIVE_EN.test(clause) ||
        EMERGENCY_DIRECTIVE_FR.test(clause) ||
        EMERGENCY_DIRECTIVE_ZH.test(clause)),
  );
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
  // blind detectRedFlag rather than fail, so it is refused here. The detail names the
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
  } catch (err) {
    throw new MedicalUnresolvable('compose_failed', message(err));
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
  // passes it, so a mis-triaged emergency ("probably viral, watch and wait, call 811") ships
  // through every gate above. This is the one that catches it: a detected red flag whose body
  // never says "seek emergency care" fails CLOSED to the fixed line, which itself names 911 —
  // strictly safer than shipping an under-escalation.
  if (detectRedFlag(query.clinicalQuery, query.ageBand) && !hasEmergencyDirective(body)) {
    throw new MedicalUnresolvable('under_escalated');
  }
  return body;
}

/**
 * THE SINGLE SWAP POINT (founder-locked 2026-08-17: "safe line as last resort"). Reached
 * only after a live attempt AND one retry both failed to produce a real, grounded answer.
 * For now it is the fixed safety line; if the founder moves to defer/
 * retry-until-generatable, this is the one function to change — the pipeline above stays.
 * Do NOT fold in the outage smoke-alarm path (route.ts / copy.ts EMERGENCY_TOKENS): that
 * is the model-UNREACHABLE case, and it is a separate, still-pending decision.
 *
 * IT TAKES THE PARENT'S WORDS, and this is the seam where the French twin earns its
 * place rather than being a nicety. The `not_gsm7` gate above rejects any composed body
 * outside the 1985 alphabet, and a real French answer about a sick child carries accents
 * it does not always have — so a francophone parent is MORE likely to land here than an
 * anglophone one, on the one message where being understood is the whole point.
 */
function onMedicalTurnUnresolvable(text: string): MedicalReply {
  return { reply: SAFETY_REPLY_BY_LANGUAGE[replyLanguage(text)], replySource: 'fixed' };
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
      return onMedicalTurnUnresolvable(text);
    },
  };
}
