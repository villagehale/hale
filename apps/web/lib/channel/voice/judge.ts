import { findInventedFacts } from '../../loop/voice/facts-lint';
import type { ReplyLanguage } from '../language';

/**
 * VIL-413 / VIL-417. The red lines code holds on a model-written parent line.
 *
 * Pure on purpose, with relative imports only: the worker eval
 * (apps/worker/evals/run-group-voice-eval.mjs) loads THIS module through tsx
 * and judges the real model's words with the real judge, instead of a replica
 * that could drift. Nothing here reaches the database, the network, or `~/`.
 */

export const DEFAULT_MAX_CHARS = 420;

export interface SpokenTurn {
  role: 'parent' | 'hale';
  body: string;
}

export type SpokenScalar = string | number | boolean | null;

export type SpokenFact =
  | SpokenScalar
  | readonly string[]
  | readonly Readonly<Record<string, SpokenScalar>>[];

export interface SpokenLineInput {
  /** Skill file under packages/agent/skills, by name. */
  skill: string;
  /** The direction inside that skill. */
  kind: string;
  language: ReplyLanguage;
  /** 1:1 is tu. A group thread is vous. */
  address: 'tu' | 'vous';
  /**
   * The only specifics the model may use. Every string here is a fact slot the
   * judge accepts. Null means unknown and is never a gap to fill.
   */
  facts: Record<string, SpokenFact>;
  /** Exactly this many questions. One question is the last sentence. */
  questions: 0 | 1;
  /** Strings the line must carry verbatim, so it is provably about them. */
  mustMention?: readonly string[];
  /** What the parent just said, when this answers a message. */
  parentWords?: string | null;
  recentTurns?: readonly SpokenTurn[];
  /** The whole body must fit this. Default {@link DEFAULT_MAX_CHARS}. */
  maxChars?: number;
  /** Code appends a real URL after the prose. The model may say "this link". */
  linkFollows?: boolean;
  /** Per-kind red lines, named. A hit is `unusable` and is logged by name. */
  forbidden?: readonly { name: string; pattern: RegExp }[];
}

export type SpokenLineJudgeFailure =
  | 'empty'
  | 'long'
  | 'question'
  | 'banned'
  | 'compliance'
  | 'invented'
  | 'missing'
  | 'french'
  | 'link'
  | 'emoji'
  | 'close'
  | `forbidden:${string}`;

const COMPLIANCE =
  /unsubscribe|d[ée]sabonner|reply stop|r[ée]pondez arr[êe]t|r[ée]pondez stop|\bSTOP\b|\bSTART\b/;

const BANNED_PHRASE =
  /reply with the number you want|text me if that changes|i['’]ll note it|i['’]ll keep track|je le note|r[ée]ponds avec le num[ée]ro|reply yes|reply no|r[ée]ponds oui|r[ée]ponds non/i;

const WEEKDAY =
  /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi;

const PRICE = /\$\s?\d+(?:[.,]\d{2})?/g;

const URL_OR_PHONE = /https?:\/\/|www\.|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/i;

/** ASCII stand-ins for accented words. A following letter (é in adapté) is not a gap. */
const FRENCH_ASCII_GAP =
  /\b(?:pres|age|adapt|prenoms?|ecole|ca|numero|reponds|annee|connecte|ajoute|a cote|idee|creneau|libere|quitte|desole)(?![\p{L}])/iu;

const DANGLING_LINK = /\bthis link\b|\bce lien\b/i;

/**
 * The departure close. The words are the check; the sentence around them is the model's.
 * `\b` is ASCII-only, so it never sees a boundary after "là".
 */
const STILL_HERE_EN = /\bstill here\b/i;
const STILL_HERE_FR = /toujours\s+l[àa](?![\p{L}])/iu;

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Letter-aware boundaries: ASCII \b would split "êtes" into "ê" + "tes". The tu family
 * includes the object pronoun ("je te propose", "ça t'intéresse"): a vous line that
 * slips into it is the same mixed register as a tu line that says "chez vous".
 */
const VOUS_REGISTER = /(?<![\p{L}])(?:vous|votre|vos)(?![\p{L}])/iu;
const TU_REGISTER = /(?<![\p{L}])(?:tu|te|toi|ton|ta|tes)(?![\p{L}])|(?<![\p{L}])t['’](?=\p{L})/iu;

function scalarStrings(value: SpokenScalar): string[] {
  if (value === null || typeof value === 'boolean') return [];
  if (typeof value === 'number') return [String(value)];
  return value.length > 0 ? [value] : [];
}

function factStrings(value: SpokenFact): string[] {
  if (!Array.isArray(value)) return scalarStrings(value as SpokenScalar);
  const out: string[] = [];
  for (const item of value as readonly (string | Readonly<Record<string, SpokenScalar>>)[]) {
    if (typeof item === 'string') out.push(...scalarStrings(item));
    else for (const inner of Object.values(item)) out.push(...scalarStrings(inner));
  }
  return out;
}

/** Every string the model was handed. Anything time-, price-, or day-shaped outside these is invented. */
export function spokenFactSlots(input: SpokenLineInput): string[] {
  const slots: string[] = [];
  for (const value of Object.values(input.facts)) slots.push(...factStrings(value));
  for (const item of input.mustMention ?? []) slots.push(item);
  if (input.parentWords) slots.push(input.parentWords);
  for (const turn of input.recentTurns ?? []) slots.push(turn.body);
  return slots.filter((slot) => slot.length > 0);
}

/**
 * Why the previous attempt was refused. Handed back on the one retry so the
 * model is told the check it failed, not asked to guess.
 */
export interface SpokenLineRejection {
  reason: SpokenLineJudgeFailure;
  line: string;
}

/**
 * The tool the model fills. `questions: 0` stays the single `line` string the
 * statement evals already cache against. `questions: 1` splits the question
 * into its own field so a period where a question belongs is a shape error,
 * not a sentence the model hopes will pass.
 */
export function spokenLineToolSchema(questions: 0 | 1): {
  type: 'object';
  properties: Record<string, { type: 'string'; description?: string }>;
  required: readonly string[];
  additionalProperties?: false;
} {
  if (questions === 0) {
    return {
      type: 'object',
      properties: { line: { type: 'string' } },
      required: ['line'],
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      before: {
        type: 'string',
        description:
          'Non-question sentences before the one question. No question mark, and not the start of that question. Empty string when the message is only the question.',
      },
      question: {
        type: 'string',
        description:
          'Exactly one question, and it is the whole final sentence, first word through the last. Last character is ?. Do not leave its start in before. A period, a fragment, or a second question is invalid.',
      },
    },
    required: ['before', 'question'],
  };
}

/** Tool description paired with {@link spokenLineToolSchema}. Statement copy is the historical one. */
export function spokenLineToolDescription(questions: 0 | 1): string {
  return questions === 1
    ? 'Return before and question. question is the one full question, the final sentence, first word through last, and its last character is ?. before holds only non-question context and does not start that question. No second question. No space before ?.'
    : 'Return the one text message to send.';
}

/** . ! ? … : ; and a closing quote after them already end the sentence. */
const SENTENCE_END = /[.!?…:;]["'»”’)\]]*$/u;

/** French in this product has no space before ?. Also strip the no-break spaces models copy from typography. */
function tightQuestionMark(question: string): string {
  return question.replace(/[ \u00A0\u202F\u2009]+(?=\?)/gu, '');
}

/** The split schema invites the model to write the question twice. Keep one. */
function oneQuestion(question: string): string {
  const tight = tightQuestionMark(question.trim());
  const parts = tight.split(/(?<=\?)\s+/u).filter((part) => part.length > 0);
  const first = parts[0];
  if (
    first !== undefined &&
    parts.length >= 2 &&
    parts.every((part) => part.toLowerCase() === first.toLowerCase())
  ) {
    return first;
  }
  return tight;
}

function withoutRepeatedQuestion(before: string, question: string): string {
  const stem = question.replace(/[?？]+\s*$/u, '').trim();
  if (stem.length < 8) return before;
  const at = before.toLowerCase().lastIndexOf(stem.toLowerCase());
  if (at < 0) return before;
  const tail = before.slice(at + stem.length).trim();
  if (tail !== '' && !/^[?.!…]+$/u.test(tail)) return before;
  return before
    .slice(0, at)
    .replace(/[\s,;:.!?…-]+$/u, '')
    .trim();
}

function closeSentence(before: string): string {
  if (SENTENCE_END.test(before)) return before;
  return `${before.replace(/[,，]+$/u, '').trim()}.`;
}

/**
 * Interrogative openers. A period after one of these turns a question the model
 * wrote into a statement ("How was the day." / "Comment ça s'est passé.").
 */
const QUESTION_OPENER =
  /^(?:how|what|when|where|who|why|which|whose|do|does|did|can|could|would|will|shall|is|are|was|were|comment|pourquoi|quand|où|qui|quel|quelle|quels|quelles|est-ce|voulez|veux|peux)\b/iu;

/** A lowercase first letter means `question` continues the clause in `before`. */
function continuesSentence(question: string): boolean {
  const first = question[0];
  return first !== undefined && /\p{Ll}/u.test(first);
}

/**
 * True when inserting a full stop would close a question the model left
 * unpunctuated, including after a leading name ("Sam, how was today").
 */
function wouldBreakAQuestion(before: string): boolean {
  if (SENTENCE_END.test(before)) return false;
  const body = before.replace(/^[\p{L}][\p{L}'’.-]{0,40},\s+/u, '');
  return QUESTION_OPENER.test(body);
}

/**
 * The skills ask for a plain hyphen. An em dash or en dash still shows up, and
 * neither judge was catching it, so this post-check replaces one before the
 * line is judged or sent. No words are added.
 */
function plainDash(line: string): string {
  return line
    .replace(/[ \t]*[—–][ \t]*/gu, ' - ')
    .replace(/ {2,}/gu, ' ')
    .trim();
}

/**
 * Join the tool fields into the one bubble the parent would read.
 * A missing period is added only between a statement and a new sentence.
 * A question the model wrote is not closed with a full stop, and a question
 * written in both fields is kept once. No words are added.
 */
export function assembleSpokenLine(
  questions: 0 | 1,
  value: { line?: string; before?: string; question?: string },
): string {
  if (questions === 0) return plainDash((value.line ?? '').trim());
  const question = oneQuestion(value.question ?? '');
  const before = withoutRepeatedQuestion((value.before ?? '').trim(), question);
  if (before.length === 0) return plainDash(question);
  if (question.length === 0) return plainDash(before);
  const joined =
    continuesSentence(question) || wouldBreakAQuestion(before)
      ? `${before} ${question}`
      : `${closeSentence(before)} ${question}`;
  return plainDash(joined);
}

/** What to tell the model on the one retry. Not a parent-facing sentence. */
export function spokenLineRefusalFix(reason: SpokenLineJudgeFailure): string {
  if (reason === 'question') {
    return 'The last sentence must be exactly one question and its last character must be ?. Put that whole question in question, first word included. A period is a refusal, and so is a second question. When questions is 0 there is no question mark anywhere.';
  }
  if (reason === 'missing') {
    return 'Every string in mustMention must appear in the line, copied as given. A name in that list is said. you, you two, and vous do not stand in for it.';
  }
  if (reason === 'french') {
    return "address tu forbids vous, votre, vos, and pour vous (use toi, ton, ta). address vous forbids tu, te, toi, ton, ta, tes, and t'. One register for the whole line.";
  }
  if (reason === 'link') {
    return 'Say this link or ce lien only when linkFollows is true. Never write a URL.';
  }
  if (reason === 'close') {
    return 'A departure ends with the close that you are still here. English includes the words still here. French includes toujours là. Write that close in the line language and the address register. A line that stops after the continuity fact is refused.';
  }
  return 'Rewrite so this refusal is gone. Use only the facts you were given.';
}

/** What the model is handed. Facts and direction only: no ids, no phone, no link. */
export function spokenLineContext(input: SpokenLineInput, rejected?: SpokenLineRejection): unknown {
  const context = {
    kind: input.kind,
    language: input.language,
    address: input.address,
    questions: input.questions,
    mustMention: input.mustMention ?? [],
    linkFollows: input.linkFollows ?? false,
    parentWords: input.parentWords ?? null,
    recentTurns: input.recentTurns ?? [],
    facts: input.facts,
  };
  if (!rejected) return context;
  return {
    ...context,
    rejected: {
      reason: rejected.reason,
      line: rejected.line,
      fix: spokenLineRefusalFix(rejected.reason),
    },
  };
}

function questionMarks(text: string): number {
  return [...text].filter((char) => char === '?').length;
}

/** A question mark inside a quoted fact (an event titled "Who's in?") is not the model asking. */
function questionsBeyondFacts(body: string, slots: readonly string[]): number {
  let stripped = body;
  for (const slot of slots) {
    if (slot.includes('?')) stripped = stripped.split(slot).join(' ');
  }
  return questionMarks(stripped);
}

function questionIsLast(body: string): boolean {
  const trimmed = body.trim();
  const mark = trimmed.lastIndexOf('?');
  if (mark < 0) return false;
  return trimmed.slice(mark + 1).trim().length === 0;
}

function mentionsOutsideSlots(text: string, pattern: RegExp, slots: readonly string[]): string[] {
  const found = text.match(pattern) ?? [];
  const unique = [...new Set(found.map((token) => token.toLowerCase()))];
  return unique.filter((token) => !slots.some((slot) => slot.toLowerCase().includes(token)));
}

export function judgeSpokenLine(
  body: string,
  input: SpokenLineInput,
): { ok: true } | { ok: false; reason: SpokenLineJudgeFailure } {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > (input.maxChars ?? DEFAULT_MAX_CHARS)) return { ok: false, reason: 'long' };

  const slots = spokenFactSlots(input);
  if (questionsBeyondFacts(trimmed, slots) !== input.questions) {
    return { ok: false, reason: 'question' };
  }
  if (input.questions === 1 && !questionIsLast(trimmed)) return { ok: false, reason: 'question' };

  if (BANNED_PHRASE.test(trimmed)) return { ok: false, reason: 'banned' };
  if (COMPLIANCE.test(trimmed)) return { ok: false, reason: 'compliance' };
  if (EMOJI.test(trimmed)) return { ok: false, reason: 'emoji' };
  if (URL_OR_PHONE.test(trimmed)) return { ok: false, reason: 'invented' };

  if (findInventedFacts(trimmed, slots).length > 0) return { ok: false, reason: 'invented' };
  if (mentionsOutsideSlots(trimmed, PRICE, slots).length > 0) {
    return { ok: false, reason: 'invented' };
  }
  if (mentionsOutsideSlots(trimmed, WEEKDAY, slots).length > 0) {
    return { ok: false, reason: 'invented' };
  }

  for (const needed of input.mustMention ?? []) {
    if (needed.length > 0 && !trimmed.toLowerCase().includes(needed.toLowerCase())) {
      return { ok: false, reason: 'missing' };
    }
  }

  if (input.language === 'fr') {
    // A quoted fact (an English event title with "age" in it) is not the model's French.
    const outsideFacts = slots.reduce((text, slot) => text.split(slot).join(' '), trimmed);
    if (FRENCH_ASCII_GAP.test(outsideFacts)) return { ok: false, reason: 'french' };
    if (input.address === 'tu' && VOUS_REGISTER.test(outsideFacts)) {
      return { ok: false, reason: 'french' };
    }
    if (input.address === 'vous' && TU_REGISTER.test(outsideFacts)) {
      return { ok: false, reason: 'french' };
    }
  }

  if (DANGLING_LINK.test(trimmed) && !input.linkFollows) return { ok: false, reason: 'link' };
  if (input.kind === 'departure') {
    const present = input.language === 'fr' ? STILL_HERE_FR.test(trimmed) : STILL_HERE_EN.test(trimmed);
    if (!present) return { ok: false, reason: 'close' };
  }

  for (const rule of input.forbidden ?? []) {
    if (rule.pattern.test(trimmed)) return { ok: false, reason: `forbidden:${rule.name}` };
  }
  return { ok: true };
}
