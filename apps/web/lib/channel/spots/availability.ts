import { z } from 'zod';

/**
 * VIL-337 · what a course page says about itself, read deterministically.
 *
 * NO MODEL RUNS HERE, and unlike the registration verify sweep that is not a cost
 * decision — there is nothing to interpret. A PerfectMind BookMe4 course page publishes
 * NOTHING readable about availability (the saved Markham page strips to 535 characters
 * of "Course Dates ... Load more..." with no occurrence of full, waitlist or register)
 * and carries its whole record as a JSON object literal inside a <script> block:
 *
 *     var eventInfo = $.extend(true, {}, { BackAction: {...} }, {"ParentEventId":null,...})
 *
 * The second argument is strict JSON — 168 keys, parsed on all three saved tenants —
 * of typed booleans and integers. A model reading that would only add a way to be
 * wrong, so this file is a brace-scan, a JSON.parse and a Zod parse.
 *
 * THE COUNTERS DECIDE; THE BOOLEANS ARE CROSS-CHECKS THAT FAIL CLOSED. All three
 * pages that could be captured are registration-CLOSED, so the boolean semantics
 * during an open window are UNOBSERVED — does `IsWaitListHasSpots` track
 * `WaitListSpotsLeft > 0` only while a class is bookable? Nobody knows yet. The
 * classifier therefore rests on `IsRegistrationClosed`/`IsFutureRegistration` plus the
 * two integer counters, precisely so that a boolean whose meaning shifts cannot flip a
 * state on its own; where a boolean disagrees with a counter, the reading is
 * `unreadable`, never a state.
 *
 * UNREADABLE IS NEVER A STATE, and that is the whole safety property. A missing model
 * (the HTTP-200 "not found" page PerfectMind serves for an unknown courseId), a Zod
 * failure, a courseId mismatch or a self-contradicting model can never satisfy the
 * `prev is full` precondition a transition needs. A page you could not open is not a
 * page that says the class is full.
 *
 * EVERY VALUE THE OUTBOUND SENTENCE PRINTS CARRIES ITS BYTES WITH IT. `evidence` holds
 * the literal serialised fragments the classification rested on (`"SpotsLeft":0`), each
 * asserted to be a substring of the page as fetched. A fragment that is not literally
 * in the bytes makes the reading `inconsistent` — so a number in a text to a parent is
 * always a run of characters a human can find on the page it came from.
 */

/** Fifteen fields out of 168. The rest pass through unread — this is a runtime parse
 * of somebody else's payload, not a tool schema, so unknown keys are data rather than
 * a contract breach. */
const bookMe4ModelSchema = z
  .object({
    EventId: z.string(),
    IsFull: z.boolean(),
    SpotsLeft: z.number().int(),
    MaximumCapacity: z.number().int(),
    IsRegistrationClosed: z.boolean(),
    IsFutureRegistration: z.boolean(),
    OnlineRegistration: z.boolean(),
    CanNotBook: z.boolean(),
    IsWaitListAvailable: z.boolean(),
    WaitListSpotsLeft: z.number().int(),
    /** Absent on a tenant that does not publish a schedule; the outbound sentence drops
     * its parenthetical rather than the reader dropping the page. */
    StartDay: z.string().nullish(),
    StartTime: z.string().nullish(),
  })
  .passthrough();

export type BookMe4Model = z.infer<typeof bookMe4ModelSchema>;

/** The three states a watch can sit in or move between. */
export type SpotState = 'open' | 'full' | 'waitlist_full';

export type SpotReading =
  | { state: SpotState; model: BookMe4Model; evidence: readonly string[] }
  | {
      state: 'not_registrable';
      reason: 'closed' | 'future' | 'offline';
      model: BookMe4Model;
      evidence: readonly string[];
    }
  | {
      state: 'unreadable';
      reason: 'no_model' | 'bad_model' | 'wrong_course' | 'inconsistent' | 'fetch_failed';
    };

/** The two changes worth waking a parent for. */
export type SpotTransitionKind = 'seat_opened' | 'waitlist_reopened';

/**
 * One course's record is ~10 KB on every tenant measured. This ceiling is an order of
 * magnitude above that and exists so an unbalanced brace cannot walk a 4 MB body.
 */
export const MAX_MODEL_CHARS = 65_536;

const MODEL_MARKER = 'var eventInfo';

/**
 * The JSON object literal `$.extend` is handed, sliced out by a string-aware brace
 * scan. A regex cannot do this: the payload contains braces inside quoted strings
 * (descriptions, urls) and the page contains other object literals on both sides.
 */
function extractEventInfo(rawHtml: string): string | null {
  const marker = rawHtml.indexOf(MODEL_MARKER);
  if (marker < 0) return null;
  const start = rawHtml.indexOf('{"', marker);
  if (start < 0) return null;

  const limit = Math.min(rawHtml.length, start + MAX_MODEL_CHARS);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < limit; at += 1) {
    const char = rawHtml[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return rawHtml.slice(start, at + 1);
    }
  }
  return null;
}

/** A field as the page serialised it. `JSON.stringify` of the value is exactly what
 * the portal emitted, because the portal emitted JSON. */
function fragment(key: string, value: string | number | boolean): string {
  return `"${key}":${JSON.stringify(value)}`;
}

function classify(model: BookMe4Model): SpotReading {
  // Bookability is asked FIRST and off the flags the vendor uses to render its own
  // button. A reader that ranked the counters first would call a closed class with an
  // empty roster "full" and offer to watch a page nobody can book from.
  if (model.IsRegistrationClosed) {
    return {
      state: 'not_registrable',
      reason: 'closed',
      model,
      evidence: [fragment('IsRegistrationClosed', true)],
    };
  }
  if (model.IsFutureRegistration) {
    return {
      state: 'not_registrable',
      reason: 'future',
      model,
      evidence: [fragment('IsFutureRegistration', true)],
    };
  }
  if (!model.OnlineRegistration) {
    return {
      state: 'not_registrable',
      reason: 'offline',
      model,
      evidence: [fragment('OnlineRegistration', false)],
    };
  }

  if (!model.IsFull && model.SpotsLeft > 0) {
    if (model.CanNotBook) return { state: 'unreadable', reason: 'inconsistent' };
    return {
      state: 'open',
      model,
      evidence: [
        fragment('IsFull', model.IsFull),
        fragment('SpotsLeft', model.SpotsLeft),
        fragment('CanNotBook', model.CanNotBook),
      ],
    };
  }

  if (model.IsFull !== (model.SpotsLeft === 0)) return { state: 'unreadable', reason: 'inconsistent' };

  // A waitlist with room and no waitlist at all are the same thing to a parent: wait
  // for a seat. Only a waitlist that has filled up is a different sentence.
  const waitlistFull = model.IsWaitListAvailable && model.WaitListSpotsLeft === 0;
  return {
    state: waitlistFull ? 'waitlist_full' : 'full',
    model,
    evidence: [
      fragment('IsFull', model.IsFull),
      fragment('SpotsLeft', model.SpotsLeft),
      fragment('IsWaitListAvailable', model.IsWaitListAvailable),
      fragment('WaitListSpotsLeft', model.WaitListSpotsLeft),
    ],
  };
}

export function readSpot(rawHtml: string, courseId: string): SpotReading {
  const blob = extractEventInfo(rawHtml);
  if (blob === null) {
    // An unknown courseId is answered with HTTP 200 and a BookMe4 error page, so the
    // status throw never fires and this is the only signal that the page is not a class.
    return { state: 'unreadable', reason: rawHtml.includes(MODEL_MARKER) ? 'bad_model' : 'no_model' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { state: 'unreadable', reason: 'bad_model' };
  }

  const model = bookMe4ModelSchema.safeParse(parsed);
  if (!model.success) return { state: 'unreadable', reason: 'bad_model' };
  if (model.data.EventId.toLowerCase() !== courseId.toLowerCase()) {
    return { state: 'unreadable', reason: 'wrong_course' };
  }

  const reading = classify(model.data);
  if (reading.state === 'unreadable') return reading;
  for (const evidence of reading.evidence) {
    if (!rawHtml.includes(evidence)) return { state: 'unreadable', reason: 'inconsistent' };
  }
  return reading;
}

/**
 * The change, if this reading is one worth a text.
 *
 * TWO TRANSITIONS, and the second is the one a parent on a queued class can actually
 * act on: Markham's own registration page says a freed seat in a full class is emailed
 * to the next waitlisted person, who has 48 hours to accept before it passes down the
 * list — so for a class with a queue, `seat_opened` may fire late or never. Everything
 * else (full to waitlist_full, open to full) is recorded and says nothing.
 */
export function transitionKind(prev: SpotState, reading: SpotReading): SpotTransitionKind | null {
  if (reading.state === 'open') {
    return prev === 'full' || prev === 'waitlist_full' ? 'seat_opened' : null;
  }
  if (reading.state === 'full' && prev === 'waitlist_full') {
    return reading.model.IsWaitListAvailable && reading.model.WaitListSpotsLeft > 0
      ? 'waitlist_reopened'
      : null;
  }
  return null;
}
