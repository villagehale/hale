import type { ReplyLanguage } from '../language';
import { findInventedFacts } from '../../loop/voice/facts-lint';

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

const EMOJI = /\p{Extended_Pictographic}/u;

/** Letter-aware boundaries: ASCII \b would split "êtes" into "ê" + "tes". */
const VOUS_REGISTER = /(?<![\p{L}])(?:vous|votre|vos)(?![\p{L}])/iu;
const TU_REGISTER = /(?<![\p{L}])(?:tu|toi|ton|ta|tes)(?![\p{L}])/iu;

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

/** What the model is handed. Facts and direction only: no ids, no phone, no link. */
export function spokenLineContext(input: SpokenLineInput): unknown {
  return {
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

  for (const rule of input.forbidden ?? []) {
    if (rule.pattern.test(trimmed)) return { ok: false, reason: `forbidden:${rule.name}` };
  }
  return { ok: true };
}
