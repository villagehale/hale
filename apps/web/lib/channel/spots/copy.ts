import { asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { withOptOut } from '~/lib/channel/opt-out';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import { type BookMe4Model, type SpotTransitionKind, fragment } from './availability';

/**
 * VIL-337 · the two sentences a watched spot may send, rendered deterministically.
 *
 * NO MODEL COMPOSES OR EDITS ONE OF THESE, on the registration-sequence discipline
 * (registration/sequence/copy.ts) and for a sharper reason than that file has: this
 * text arrives unprompted, carries a number, and asks a parent to stop what they are
 * doing and go and register. A generated sentence with that privilege is a sentence
 * nobody reviewed.
 *
 * FOUR BINDINGS, EACH STRUCTURAL:
 *
 *   ATTRIBUTION LEADS. The subject is the SOURCE — `portalLabel` comes hand-written
 *     from the host registry (url.ts), never derived from the URL. A parent who cannot
 *     check the page in the next minute can still see who said it.
 *
 *   EVERY CLAIM IS QUOTED, NOT COMPUTED. The body says three things a parent will act
 *     on — a count, a schedule, and (for a waitlist) that there is room — and each one
 *     is checked against the fragment the reader took from THIS tick's bytes before it
 *     can be printed. "3 spots left" against a page that says 1 costs somebody a
 *     morning, and an interpolation bug makes that error silently; "room on the
 *     waitlist" against a queue that is full carries no digits at all, which is why it
 *     needs a gate of its own rather than the digit rule. `renderSpotOpen` THROWS on an
 *     unbacked count or an unbacked waitlist, and DROPS an unbacked parenthetical — the
 *     schedule is decoration, the seat is the message.
 *
 *   THERE IS NO WAITLIST HEADCOUNT. The model carries `WaitListCapacity` 99 and
 *     `WaitListSpotsLeft` 94, so "5 people ahead of you" is arithmetic over two fields
 *     — a derived number, which is the one thing the evidence rule forbids. The
 *     waitlist sentence therefore says "room", and the ticket's example clause is
 *     unattainable on this portal rather than approximated.
 *
 *   THE MESSAGE ASKS NOTHING. The ticket's draft ended "Want the link?"; a question
 *     with no row behind it is the 2026-08-22 defect, and the link is already in the
 *     text. No question mark, no first-person future verb — so `extractStateClaims`
 *     comes back empty and there is nothing here a ledger would have to back.
 *
 * Plain ASCII throughout: one typographic dash flips the whole SMS to UCS-2 and halves
 * the budget (sms-segments.ts).
 */

/**
 * Three segments, measured against the FULL CASL form — the longest a real send can
 * be, since the opt-out form is chosen per recipient and this budget must hold for
 * whichever one it picks.
 */
export const MAX_SPOT_OPEN_SEGMENTS = 3;

export interface SpotOpenInput {
  kind: SpotTransitionKind;
  /** The hand-written registry label for the host, e.g. "Markham's portal". */
  portalLabel: string;
  /** What the parent called the class, in their own words. */
  label: string;
  /** The sanitized source url, code-appended and never model-written. */
  url: string;
  /** THIS tick's parsed model. A stored reading is never composed from. */
  model: BookMe4Model;
  /** THIS tick's evidence fragments, as taken from the fetched bytes. */
  evidence: readonly string[];
}

export interface SpotOpenContext {
  url: string;
  /** THIS tick's evidence fragments — the page's own serialisation of every field a
   * body is allowed to rest on. */
  evidence: readonly string[];
  kind: SpotTransitionKind;
  /** The number the body prints, or null when it prints none. */
  count: number | null;
  /** The schedule phrase the body prints verbatim from the model, or null. */
  when: string | null;
  /** THIS tick's parsed model. The claims above are the body's; this and `evidence`
   * are what they are checked against. */
  model: BookMe4Model;
}

/**
 * The schedule the page publishes, or nothing. Two ways to get nothing, and both cost
 * the parenthetical rather than the send: bytes that do not carry the model's own
 * schedule fields, and a StartTime carrying a character that would break GSM-7 or close
 * the parenthetical early.
 */
function schedulePhrase(model: BookMe4Model, evidence: readonly string[]): string | null {
  const day = model.StartDay;
  const time = model.StartTime;
  if (!day || !time) return null;
  if (!evidence.includes(fragment('StartDay', day))) return null;
  if (!evidence.includes(fragment('StartTime', time))) return null;
  const phrase = asciiSpaces(`${day.trim()} ${time.trim()}`);
  return /^[A-Za-z0-9 :]+$/.test(phrase) ? phrase : null;
}

/** Removes one literal occurrence, so the checks below run on what is left over after
 * the pieces the body is allowed to carry are accounted for. */
function without(text: string, literal: string | null): string {
  if (literal === null || literal === '') return text;
  const at = text.indexOf(literal);
  return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + literal.length)}`;
}

/**
 * Everything wrong with this body, named. Exported because the composer runs it on
 * itself and copy.test.ts runs it on the output: a gate only the composer can reach is
 * a gate nobody can test.
 */
export function spotOpenViolations(body: string, context: SpotOpenContext): string[] {
  const violations: string[] = [];

  if (!body.includes(context.url)) violations.push('url_missing');
  if (context.count !== null && !context.evidence.includes(fragment('SpotsLeft', context.count))) {
    violations.push('unbacked_count');
  }
  if (context.kind === 'seat_opened' && (context.count === null || context.count < 1)) {
    violations.push('no_seat');
  }
  if (context.kind === 'waitlist_reopened') {
    if (/spots?\s+left/i.test(body)) violations.push('counts_a_waitlist');
    if (
      !context.evidence.includes(fragment('IsWaitListAvailable', true)) ||
      context.model.WaitListSpotsLeft < 1 ||
      !context.evidence.includes(fragment('WaitListSpotsLeft', context.model.WaitListSpotsLeft))
    ) {
      violations.push('unbacked_waitlist');
    }
  }
  if (context.when !== null && context.when !== schedulePhrase(context.model, context.evidence)) {
    violations.push('unbacked_when');
  }

  const rest = without(without(body, context.url), context.when);
  if (rest.includes('?')) violations.push('asks_a_question');
  const digits = rest.match(/\d+/g) ?? [];
  if (digits.some((run) => context.count === null || run !== String(context.count))) {
    violations.push('unbacked_digit');
  }

  if (!isGsm7(body)) violations.push('not_gsm7');
  if (smsSegments(withOptOut(body, 'full')) > MAX_SPOT_OPEN_SEGMENTS) {
    violations.push('too_many_segments');
  }
  return violations;
}

/**
 * The body, or nothing at all. A refusal here is not recoverable by trimming — a spot
 * text whose number cannot be traced to the page is not a text worth sending in a
 * shorter form.
 */
export function renderSpotOpen(input: SpotOpenInput): string {
  const count = input.kind === 'seat_opened' ? input.model.SpotsLeft : null;
  const when = schedulePhrase(input.model, input.evidence);
  const what =
    count === null
      ? `room on the waitlist for ${input.label}`
      : `${count} spot${count === 1 ? '' : 's'} left for ${input.label}`;
  const body = `${input.portalLabel} now shows ${what}${when === null ? '' : ` (${when})`}. ${input.url}`;

  const violations = spotOpenViolations(body, {
    url: input.url,
    evidence: input.evidence,
    kind: input.kind,
    count,
    when,
    model: input.model,
  });
  if (violations.length > 0) {
    throw new Error(`spot-open copy refused: ${violations.join(', ')}`);
  }
  return body;
}
