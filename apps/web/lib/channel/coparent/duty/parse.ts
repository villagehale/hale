import { isFigureItOutLine } from '~/lib/channel/linq/logistics-poll';
import { CONFIDENCE_FLOOR } from '~/lib/memory/facts';
import { type DutyRole, needsWhichKid } from './model';

/**
 * VIL-381 — deterministic duty replies.
 *
 * Rules run before any model. A question, a laugh tapback, or a confidence
 * under 0.7 does not set `write`. The model fallback lives in interpret.ts.
 */

export type DutyClaimKind =
  | 'self'
  | 'other_parent'
  | 'named'
  | 'both'
  | 'neither'
  | 'maybe'
  | 'not_me';

export interface DutyParent {
  userId: string;
  name: string;
}

export interface DutyParseInput {
  text: string;
  tapback?: string | null;
  speakerUserId: string;
  parents: readonly DutyParent[];
  askedRole?: DutyRole | null;
  childNames?: readonly string[];
  eventTitle?: string | null;
}

export interface DutySlot {
  role: DutyRole;
  claim: DutyClaimKind;
  /** Display name for `named`, or the other parent's name for `other_parent`. */
  name: string | null;
  /** Set for `other_parent` and `self`. */
  userId: string | null;
  confidence: number;
}

export interface DutyParse {
  method: 'rules' | 'llm' | 'none';
  llm: 'rules' | 'used' | 'not_configured';
  slots: DutySlot[];
  question: boolean;
  askWhichKid: boolean;
  write: boolean;
  confidence: number;
}

const CLEAR = 1;
const UNCLEAR = 0.4;

const PICKUP_RE = /\b(pick[\s-]?ups?|picking up|pick up|picks up)\b/i;
const DROPOFF_RE = /\b(drop[\s-]?offs?|dropping off|drop off|drops off)\b/i;
const ATTEND_RE = /\b(attend|attending|coming|we're going|we are going|going)\b/i;

const YES_TAP = new Set(['love', 'like', 'emphasize', 'heart', 'thumbs_up', 'thumbsup']);
const NO_TAP = new Set(['dislike', 'thumbs_down', 'thumbsdown']);
const QUESTION_TAP = new Set(['question', 'question_mark']);

const SELF_EXACT =
  /^(me|mine|moi|oui|i will|i'll|i can|i got it|i've got it|i have got it|i have it|je m'en occupe|c'est moi)$/i;
const SELF_START = /^(i(?:'ll| will)|i can|i(?:'ve| have) got|i got|je m'en occupe|c'est moi)\b/i;

const MAYBE_RE = /\b(maybe|not sure|unsure|might|possibly|peut-etre|peut etre|peut-être)\b/i;
const NEITHER_RE =
  /\b(neither of us|neither|nobody|no one|on verra|ni l'un ni l'autre|aucun de nous)\b/i;
const BOTH_PARENTS_RE =
  /^(both|both of us|the two of us|les deux|nous deux)$|(\b(both of us|we'll both|we will both|we both|we can both|both parents|we're both|we are both|les deux|nous deux)\b)/i;
const NOT_ME_RE = /^(not me|i can't|i cannot|i won't|i wont|pas moi)$|\bnot me\b/i;

function normalize(text: string): string {
  return text.trim().replace(/[’]/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

function defaultRole(input: DutyParseInput): DutyRole {
  return input.askedRole ?? 'attend';
}

function rolesIn(text: string): DutyRole[] {
  const roles: DutyRole[] = [];
  if (DROPOFF_RE.test(text)) roles.push('dropoff');
  if (PICKUP_RE.test(text)) roles.push('pickup');
  if (ATTEND_RE.test(text) && !DROPOFF_RE.test(text) && !PICKUP_RE.test(text)) {
    roles.push('attend');
  }
  return roles;
}

function slot(
  role: DutyRole,
  claim: DutyClaimKind,
  confidence: number,
  extra: { name?: string | null; userId?: string | null } = {},
): DutySlot {
  return {
    role,
    claim,
    name: extra.name ?? null,
    userId: extra.userId ?? null,
    confidence,
  };
}

export function finishDutyParse(
  partial: Omit<DutyParse, 'write' | 'confidence'> & { confidence?: number },
): DutyParse {
  const confidence =
    partial.confidence ??
    (partial.slots.length === 0 ? 0 : Math.min(...partial.slots.map((row) => row.confidence)));
  const write =
    !partial.question &&
    !partial.askWhichKid &&
    partial.method !== 'none' &&
    partial.slots.length > 0 &&
    partial.slots.every((row) => row.confidence >= CONFIDENCE_FLOOR) &&
    confidence >= CONFIDENCE_FLOOR;
  return { ...partial, confidence, write };
}

function base(input: DutyParseInput): { askWhichKid: boolean } {
  return { askWhichKid: needsWhichKid(input.eventTitle, input.childNames ?? []) };
}

function questionParse(input: DutyParseInput): DutyParse {
  return finishDutyParse({
    method: 'rules',
    llm: 'rules',
    slots: [],
    question: true,
    askWhichKid: base(input).askWhichKid,
  });
}

function noneParse(input: DutyParseInput, confidence = 0): DutyParse {
  return finishDutyParse({
    method: 'none',
    llm: 'not_configured',
    slots: [],
    question: false,
    askWhichKid: base(input).askWhichKid,
    confidence,
  });
}

function ruled(input: DutyParseInput, slots: DutySlot[], question = false): DutyParse {
  return finishDutyParse({
    method: 'rules',
    llm: 'rules',
    slots,
    question,
    askWhichKid: base(input).askWhichKid,
  });
}

function parseTapback(tap: string, input: DutyParseInput): DutyParse {
  const kind = tap.trim().toLowerCase();
  if (QUESTION_TAP.has(kind)) return questionParse(input);
  const role = defaultRole(input);
  if (YES_TAP.has(kind)) {
    return ruled(input, [slot(role, 'self', CLEAR, { userId: input.speakerUserId, name: null })]);
  }
  if (NO_TAP.has(kind))
    return ruled(input, [slot(role, 'not_me', CLEAR, { userId: input.speakerUserId })]);
  return noneParse(input, UNCLEAR);
}

function opposed(text: string): { yes: DutyRole; no: DutyRole } | null {
  const parts = text.split(/\b(?:but not|and not|, not| not )\b/i);
  if (parts.length !== 2) return null;
  const left = rolesIn(parts[0] ?? '');
  const right = rolesIn(parts[1] ?? '');
  const yes = left[0];
  const no = right[0];
  if (!yes || !no || left.length !== 1 || right.length !== 1 || yes === no) return null;
  return { yes, no };
}

function parentByName(name: string, parents: readonly DutyParent[]): DutyParent | null {
  const needle = name.trim().toLowerCase();
  if (needle.length < 2) return null;
  return parents.find((parent) => parent.name.trim().toLowerCase() === needle) ?? null;
}

function leadingName(raw: string): { name: string; rest: string } | null {
  const match = /^([A-Za-z][A-Za-z-]*)(?:'s)?\s+(.+)$/.exec(raw.trim().replace(/’/g, "'"));
  const name = match?.[1];
  const rest = match?.[2];
  if (!name || !rest) return null;
  const lower = name.toLowerCase();
  if (
    [
      'i',
      'we',
      'you',
      'both',
      'maybe',
      'neither',
      'on',
      'the',
      'not',
      "i'll",
      "i've",
      "i'm",
    ].includes(lower)
  ) {
    return null;
  }
  return { name, rest };
}

function roleFromRest(rest: string, fallback: DutyRole): DutyRole {
  const found = rolesIn(rest);
  return found[0] ?? fallback;
}

function namedOrParent(input: DutyParseInput, raw: string): DutySlot[] | null {
  const leading = leadingName(raw);
  if (!leading) return null;
  const rest = normalize(leading.rest);
  const looksLikeDuty =
    PICKUP_RE.test(rest) ||
    DROPOFF_RE.test(rest) ||
    ATTEND_RE.test(rest) ||
    /\b(got|take|takes|taking|will|can|is)\b/i.test(rest);
  if (!looksLikeDuty) return null;
  const role = roleFromRest(rest, defaultRole(input));
  const parent = parentByName(leading.name, input.parents);
  if (parent) {
    if (parent.userId === input.speakerUserId) {
      return [slot(role, 'self', CLEAR, { userId: parent.userId, name: parent.name })];
    }
    return [slot(role, 'other_parent', CLEAR, { userId: parent.userId, name: parent.name })];
  }
  return [slot(role, 'named', CLEAR, { name: leading.name })];
}

function otherFromYou(input: DutyParseInput, text: string): DutySlot[] | null {
  if (!/\b(you|toi)\b/i.test(text)) return null;
  const others = input.parents.filter((parent) => parent.userId !== input.speakerUserId);
  const other = others.length === 1 ? others[0] : null;
  if (!other) return null;
  const roles = rolesIn(text);
  const role = roles[0] ?? defaultRole(input);
  return [slot(role, 'other_parent', CLEAR, { userId: other.userId, name: other.name })];
}

function matchRules(raw: string, input: DutyParseInput): DutySlot[] | null {
  const text = normalize(raw);
  if (!text) return null;
  if (isFigureItOutLine(text) || NEITHER_RE.test(text)) {
    const roles = rolesIn(text);
    const targets = roles.length > 0 ? roles : [defaultRole(input)];
    return targets.map((role) => slot(role, 'neither', CLEAR));
  }
  const split = opposed(text);
  if (split) {
    return [
      slot(split.yes, 'self', CLEAR, { userId: input.speakerUserId }),
      slot(split.no, 'not_me', CLEAR, { userId: input.speakerUserId }),
    ];
  }
  if (/\b(i(?:'ll| will)|i can|i) do both\b/i.test(text)) {
    return [
      slot('dropoff', 'self', CLEAR, { userId: input.speakerUserId }),
      slot('pickup', 'self', CLEAR, { userId: input.speakerUserId }),
    ];
  }
  if (BOTH_PARENTS_RE.test(text) && !/\bboth of (these|those|them|the)\b/i.test(text)) {
    const roles = rolesIn(text);
    const role = roles[0] === 'dropoff' || roles[0] === 'pickup' ? roles[0] : 'attend';
    return [slot(role, 'both', CLEAR)];
  }
  if (MAYBE_RE.test(text)) {
    const roles = rolesIn(text);
    const targets = roles.length > 0 ? roles : [defaultRole(input)];
    return targets.map((target) => slot(target, 'maybe', CLEAR, { userId: input.speakerUserId }));
  }
  const named = namedOrParent(input, raw.trim());
  if (named) return named;
  const you = otherFromYou(input, text);
  if (you) return you;
  if (NOT_ME_RE.test(text)) {
    const roles = rolesIn(text);
    const targets = roles.length > 0 ? roles : [defaultRole(input)];
    return targets.map((role) => slot(role, 'not_me', CLEAR, { userId: input.speakerUserId }));
  }
  if (SELF_EXACT.test(text) || SELF_START.test(text)) {
    const roles = rolesIn(text);
    const targets = roles.length > 0 ? roles : [defaultRole(input)];
    return targets.map((role) => slot(role, 'self', CLEAR, { userId: input.speakerUserId }));
  }
  return null;
}

/** Rules only. `method: 'none'` means the model fallback may run. */
export function parseDutyReply(input: DutyParseInput): DutyParse {
  const tap = input.tapback?.trim();
  if (tap) return parseTapback(tap, input);
  const raw = input.text ?? '';
  if (raw.includes('?')) return questionParse(input);
  const slots = matchRules(raw, input);
  if (!slots) return noneParse(input);
  return ruled(input, slots);
}

/** A who-takes poll choice, already structured. Removal is not a slot. */
export function slotFromPollChoice(input: {
  voterUserId: string;
  choiceKind: string | null;
  choiceValue: string | null;
  parents: readonly DutyParent[];
}): DutySlot | null {
  if (input.choiceKind === 'figure_it_out') {
    return slot('attend', 'neither', CLEAR);
  }
  if (input.choiceKind !== 'parent' || !input.choiceValue) return null;
  const parent = input.parents.find((row) => row.userId === input.choiceValue);
  if (input.choiceValue === input.voterUserId) {
    return slot('attend', 'self', CLEAR, {
      userId: input.voterUserId,
      name: parent?.name ?? null,
    });
  }
  return slot('attend', 'other_parent', CLEAR, {
    userId: input.choiceValue,
    name: parent?.name ?? null,
  });
}
