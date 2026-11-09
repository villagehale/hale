import { type BookMe4Model, type SpotTransitionKind, fragment } from './availability';

/**
 * VIL-337 · what a spot-opened text may rest on, and what it may not say.
 *
 * THE MODEL WRITES EVERY WORD (compose.ts, skill `spot-open-voice`). Code owns the facts
 * the writer is handed, each checked against THIS tick's bytes before the writer sees it,
 * and the structural refusals its draft must clear. There is no template and no fallback
 * sentence: a draft that cannot be written is nothing sent, and the next tick re-reads
 * the page and asks again.
 *
 * THE LINK IS DATA, NOT COPY. The sanitized course url is appended by code on its own
 * line (`spotOpenBody`), never handed to the model to retype: one slipped character in a
 * GUID sends a parent to PerfectMind's "not found" page at the one moment that matters.
 * So the writer gets no url, and a draft carrying one is refused.
 *
 * EVERY DIGIT IS BACKED. The facts carry three sources of digits — the seat count
 * (checked against its `"SpotsLeft":n` fragment), the schedule the page serialised, and
 * the parent's own label ("Swimmer 3") — and a digit run outside those is refused. There
 * is no waitlist headcount on this portal (a queue length would be arithmetic over two
 * fields), so a waitlist fact carries no count at all.
 *
 * THE TEXT ASKS NOTHING. The link is already in it and no ledger row stands behind a
 * question, so a draft with a question mark is refused (the 2026-08-22 defect).
 */

/** The facts the writer is handed. Plain data: the eval replays exactly this object. */
export interface SpotOpenFacts {
  kind: SpotTransitionKind;
  /** Who is saying it — the hand-written registry label ("Markham's portal"). */
  source: string;
  /** What the parent called the class, in their own words. */
  label: string;
  /** The seat count on THIS tick's page, for `seat_opened` only. */
  spotsLeft: number | null;
  /** The day and time the page publishes for the class, verbatim, or null. */
  schedule: string | null;
  /** The parent's language tag. */
  language: string;
}

export interface SpotOpenFactsInput {
  kind: SpotTransitionKind;
  portalLabel: string;
  label: string;
  /** THIS tick's parsed model. A stored reading is never composed from. */
  model: BookMe4Model;
  /** THIS tick's evidence fragments, as taken from the fetched bytes. */
  evidence: readonly string[];
  language: string;
}

/**
 * The schedule the page publishes, or nothing. Two ways to get nothing, and both cost the
 * schedule rather than the send: bytes that do not carry the model's own schedule fields,
 * and a value carrying anything but letters, digits, spaces and a colon.
 */
function schedulePhrase(model: BookMe4Model, evidence: readonly string[]): string | null {
  const day = model.StartDay;
  const time = model.StartTime;
  if (!day || !time) return null;
  if (!evidence.includes(fragment('StartDay', day))) return null;
  if (!evidence.includes(fragment('StartTime', time))) return null;
  const phrase = `${day.trim()} ${time.trim()}`.replace(/\s+/g, ' ');
  return /^[A-Za-z0-9 :]+$/.test(phrase) ? phrase : null;
}

/**
 * The facts, or the named reasons this tick's bytes cannot back a text of this kind. A
 * refusal here is the page contradicting the opening the sweep claimed, which no
 * better-written sentence could fix.
 */
export function spotOpenFacts(
  input: SpotOpenFactsInput,
): { ok: true; facts: SpotOpenFacts } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  let spotsLeft: number | null = null;
  if (input.kind === 'seat_opened') {
    spotsLeft = input.model.SpotsLeft;
    if (spotsLeft < 1) reasons.push('no_seat');
    else if (!input.evidence.includes(fragment('SpotsLeft', spotsLeft))) {
      reasons.push('unbacked_count');
    }
  } else if (
    !input.evidence.includes(fragment('IsWaitListAvailable', true)) ||
    input.model.WaitListSpotsLeft < 1 ||
    !input.evidence.includes(fragment('WaitListSpotsLeft', input.model.WaitListSpotsLeft))
  ) {
    reasons.push('unbacked_waitlist');
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    facts: {
      kind: input.kind,
      source: input.portalLabel,
      label: input.label,
      spotsLeft,
      schedule: schedulePhrase(input.model, input.evidence),
      language: input.language,
    },
  };
}

/** A link with or without a scheme, on any TLD: a phone links "bit.ly/x" as readily as
 * "riverton.ca", so the shape is any dotted host rather than a list of TLDs. Clock words
 * such as "a.m." never match: no TLD is one letter. */
export const LINK_SHAPE = /https?:\/\/|www\.|[\p{L}\p{N}_-]\.\p{L}{2,}/iu;

/** Every number a draft may print, as numbers, so "05:00 PM" backs a written "5". */
function backedNumbers(facts: SpotOpenFacts): Set<number> {
  const sources = [facts.label, facts.schedule ?? '', String(facts.spotsLeft ?? '')];
  return new Set(sources.flatMap((text) => (text.match(/\d+/g) ?? []).map(Number)));
}

/**
 * Structural refusals only, never wording or length. Exported because the composer runs
 * it on every draft and the eval on every recording: a gate only the composer can reach
 * is a gate nobody can test.
 */
export function spotOpenRefusals(text: string, facts: SpotOpenFacts): string[] {
  const body = text.trim();
  if (body === '') return ['empty'];
  const refusals: string[] = [];
  if (LINK_SHAPE.test(body)) refusals.push('link');
  if (body.includes('?')) refusals.push('asks_a_question');
  const backed = backedNumbers(facts);
  if ((body.match(/\d+/g) ?? []).some((run) => !backed.has(Number(run)))) {
    refusals.push('unbacked_digit');
  }
  return refusals;
}

/** What goes on the wire before the opt-out line: the writer's text, then the link. */
export function spotOpenBody(text: string, url: string): string {
  return `${text.trim()}\n${url}`;
}

/** The writer's request shape, shared with the eval so its recordings key on what
 * production sends. */
export const SPOT_OPEN_SKILL = 'spot-open-voice';
export const SPOT_OPEN_TOOL = 'spot_open_text';
export const SPOT_OPEN_TOOL_DESCRIPTION =
  'The one text Hale sends a parent because a class they asked it to watch has room.';
export const SPOT_OPEN_TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;
export const SPOT_OPEN_MAX_TOKENS = 400;
export const SPOT_OPEN_MAX_ATTEMPTS = 2;

export function spotOpenUserMessage(facts: SpotOpenFacts): string {
  return JSON.stringify(facts);
}
