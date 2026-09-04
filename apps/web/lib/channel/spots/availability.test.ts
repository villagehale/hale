import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SpotReading, readSpot, transitionKind } from './availability';

/**
 * VIL-337 · the reader, against the real bytes six PerfectMind course pages served.
 *
 * THE BUG THESE FIXTURES EXIST TO PREVENT is a watch that never fires. A BookMe4
 * course page publishes NOTHING readable about availability — the Markham page below
 * strips to 535 characters of "Course Dates 0 sessions Every Sat ... Load more..."
 * with no occurrence of full, waitlist, register or spaces — and carries its whole
 * record as a JSON object literal in a <script> block. A reader built on the visible
 * text would report every class as unreadable forever, and the only symptom would be
 * silence, which is exactly what a watch that is working also looks like.
 *
 * Every expectation is transcribed from the fixture's own model, never from what the
 * reader currently returns. Two of the six pages were caught with their registration
 * window OPEN — one with a full roster and a waitlist, one with two seats left — so
 * `full` and `open` are read off real bytes rather than inferred. The handful of states
 * still unobserved in the wild (an empty waitlist, a window that has not opened, a
 * course that is not bookable online) are tested as single-field variants of that real
 * open model, so only the named override is ever hypothetical.
 *
 * THE EVIDENCE CARRIES THE SCHEDULE TOO, because copy.ts prints a parenthetical from
 * it and may print nothing this array does not hold. It is the one part of the array
 * that is filtered rather than asserted: a schedule the page did not serialise the way
 * it is re-serialised here costs the parenthetical, where letting it fail the whole
 * reading would silence the watch over a decoration.
 *
 * THE OPEN-FULL PAGE CARRIES `CanNotBook: true`. It is bookable — onto the waitlist —
 * and its registration window is open, so a reader that took `CanNotBook` for "this
 * page is not registrable" would refuse to watch precisely the classes VIL-337 exists
 * for. It is a cross-check inside the seats branch and nothing else.
 */

const MARKHAM_COURSE = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const NEWMARKET_COURSE = '5f397fce-9475-4fcf-96d5-8769645f06b3';
const NVRC_COURSE = 'e1533a1c-30bf-4ef2-8765-3e123ec964db';
const OAKVILLE_COURSE = '16765c8e-835f-4ba6-9803-bbc84bd5ff8f';
const OPEN_FULL_COURSE = '85770d4d-bce9-4e53-b969-cf7e88775180';
const OPEN_SEATS_COURSE = '961140fe-0866-460f-9973-7c42cbe0a928';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `${name}.html`), 'utf8');
}

/** Variant harness only. The PAGE shape is the real one — the six saved tenants prove
 * that — and the model it wraps is a real one with named fields overridden. */
function pageWith(model: Record<string, unknown>): string {
  return `<html><body><script>\r\n  var eventInfo = $.extend(true, {}, {\r\n    BackAction: { Url: '/Clients/BookMe4' }\r\n  }, ${JSON.stringify(model)});\r\n</script></body></html>`;
}

/** Narrows away the unreadable arm, and fails loudly rather than skipping when a
 * reading a test is about turns out to carry no model. */
function readable(reading: SpotReading) {
  if (reading.state === 'unreadable') {
    throw new Error(`expected a readable page, got unreadable/${reading.reason}`);
  }
  return reading;
}

/** Markham's "Chess: Preschool", fetched with its registration window open and its
 * roster full. Reading it through `readSpot` rather than a saved JSON copy means the
 * base of every variant below is the live model, and a page that stopped being
 * readable fails here rather than quietly weakening the cases built on it. */
const openFullModel = readable(readSpot(fixture('open-window-markham'), OPEN_FULL_COURSE)).model;

function variant(overrides: Record<string, unknown> = {}): string {
  return pageWith({ ...openFullModel, ...overrides });
}

describe('readSpot — the real pages', () => {
  it('reads Markham from its embedded model, never from its visible text', () => {
    const html = fixture('markham-course');

    const reading = readSpot(html, MARKHAM_COURSE);

    expect(reading).toMatchObject({ state: 'not_registrable', reason: 'closed' });
    expect(readable(reading).model.SpotsLeft).toBe(11);
    expect(readable(reading).model.MaximumCapacity).toBe(15);
    expect(readable(reading).evidence).toContain('"IsRegistrationClosed":true');
  });

  it('has nothing left to read once the script blocks are stripped', () => {
    // The control for the test above: `stripHtml` (verify-sweep.ts) deletes exactly
    // this, so the sweep's own text pipeline cannot back a spot watch.
    const stripped = fixture('markham-course').replace(/<script[\s\S]*?<\/script>/gi, ' ');

    expect(stripped).not.toContain('SpotsLeft');
    expect(readSpot(stripped, MARKHAM_COURSE)).toEqual({ state: 'unreadable', reason: 'no_model' });
  });

  it.each([
    ['newmarket-course', NEWMARKET_COURSE, { IsFull: true, SpotsLeft: 0, MaximumCapacity: 12 }],
    ['nvrc-course', NVRC_COURSE, { IsFull: false, SpotsLeft: 1, MaximumCapacity: 6 }],
  ])('reads %s the same way, off its own counters', (name, courseId, expected) => {
    // Two more tenants of the same vendor, one FULL and one with a seat left, both with
    // registration closed. The classifier must reach `not_registrable` on both without
    // ever consulting the counters — a reader that ranked IsFull first would call
    // Newmarket "full" and offer to watch a class nobody can book.
    const reading = readSpot(fixture(name), courseId);

    expect(reading).toMatchObject({ state: 'not_registrable', reason: 'closed' });
    expect(readable(reading).model).toMatchObject(expected);
  });

  it('reads Oakville, a fourth tenant on a /Contacts/ route, off its own model', () => {
    // The waitlist booleans on this page are the reason the classifier does not read
    // them: IsWaitListFull is true because the tenant configured NO waitlist at all
    // (WaitListCapacity 0), not because a queue filled up.
    const reading = readSpot(fixture('oakville-course'), OAKVILLE_COURSE);

    expect(reading).toMatchObject({ state: 'not_registrable', reason: 'closed' });
    expect(readable(reading).model).toMatchObject({
      IsFull: true,
      SpotsLeft: 0,
      MaximumCapacity: 14,
      IsWaitListFull: true,
      WaitListCapacity: 0,
    });
  });

  it('calls a real open window with a full roster full, and quotes its counters', () => {
    // Registration is OPEN here and the class is full with room on the waitlist — the
    // state a watch is armed in. CanNotBook is true on this very page, so the assertion
    // below is also the guard against reading that flag as "not registrable".
    const html = fixture('open-window-markham');

    const reading = readSpot(html, OPEN_FULL_COURSE);

    expect(reading).toMatchObject({ state: 'full' });
    expect(readable(reading).model).toMatchObject({
      IsRegistrationClosed: false,
      IsFutureRegistration: false,
      OnlineRegistration: true,
      CanNotBook: true,
      IsFull: true,
      SpotsLeft: 0,
      MaximumCapacity: 7,
      IsWaitListAvailable: true,
      WaitListSpotsLeft: 100,
    });
    expect(readable(reading).evidence).toEqual([
      '"IsFull":true',
      '"SpotsLeft":0',
      '"IsWaitListAvailable":true',
      '"WaitListSpotsLeft":100',
      '"StartDay":"Monday"',
      '"StartTime":"05:00 PM"',
    ]);
  });

  it('calls a real open window with two seats left open, and quotes the two', () => {
    const reading = readSpot(fixture('open-window-open-markham'), OPEN_SEATS_COURSE);

    expect(reading).toMatchObject({ state: 'open' });
    expect(readable(reading).model).toMatchObject({
      IsRegistrationClosed: false,
      CanNotBook: false,
      IsFull: false,
      SpotsLeft: 2,
      MaximumCapacity: 10,
    });
    expect(readable(reading).evidence).toEqual([
      '"IsFull":false',
      '"SpotsLeft":2',
      '"CanNotBook":false',
      '"StartDay":"Sunday"',
      '"StartTime":"10:15 AM"',
    ]);
  });
});

describe('readSpot — what it refuses to call a state', () => {
  it('treats an HTTP-200 "not found" page as unreadable, not as a class', () => {
    // PerfectMind answers an unknown courseId with 200 and a BookMe4 error page, so the
    // status throw never fires and the ABSENCE OF THE MODEL is the only signal.
    const errorPage = fixture('markham-course-not-found');

    expect(errorPage).toContain('was not found');
    expect(readSpot(errorPage, MARKHAM_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'no_model',
    });
  });

  it('parses the same error page once a model is spliced into it (positive control)', () => {
    const errorPage = fixture('markham-course-not-found');
    const withModel = errorPage.replace('</body>', `${variant()}</body>`);

    expect(readSpot(withModel, OPEN_FULL_COURSE).state).toBe('full');
  });

  it("matches the course id however the parent's browser capitalised it", () => {
    // PerfectMind serves the same page for either casing and the sanitizer lower-cases
    // what it stores, but a link that reached the watch by another route must not read
    // as a different class. A case-sensitive compare here is silent: every watch on an
    // upper-case link would go wrong_course forever, which looks exactly like a portal
    // that stopped publishing.
    expect(readSpot(fixture('markham-course'), MARKHAM_COURSE.toUpperCase())).toMatchObject({
      state: 'not_registrable',
      reason: 'closed',
    });
  });

  it('refuses a model that names a different course', () => {
    expect(readSpot(fixture('markham-course'), NEWMARKET_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'wrong_course',
    });
  });

  it.each([
    ['a full class with three spots left', { IsFull: true, SpotsLeft: 3 }],
    [
      'spots left in a class that cannot be booked',
      { IsFull: false, SpotsLeft: 2, CanNotBook: true },
    ],
    ['an empty class that does not call itself full', { IsFull: false, SpotsLeft: 0 }],
  ])('refuses %s — the counters and the flags must agree', (_why, model) => {
    expect(readSpot(variant(model), OPEN_FULL_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'inconsistent',
    });
  });

  it.each([
    ['a roster of minus one that does not call itself full', { IsFull: false, SpotsLeft: -1 }],
    ['a waitlist counted below zero', { WaitListSpotsLeft: -1 }],
  ])('refuses %s outright, rather than cross-checking it', (_why, model) => {
    // The flags-vs-counters cross-check would call the first of these `full` — IsFull
    // false, SpotsLeft not 0 — and arm a watch on an overbooked roster the portal never
    // marked full. A counter below zero is not a state to reconcile, it is a payload
    // this reader has no business classifying.
    expect(readSpot(variant(model), OPEN_FULL_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'bad_model',
    });
  });

  it('reads a model whose strings carry unbalanced braces', () => {
    // The brace scan is string-aware for this: RegistrationInfo is free text on every
    // tenant, and one stray brace inside it would end the slice early, turn the page
    // into `bad_model`, and silence the watch with no error anywhere.
    const html = variant({ RegistrationInfo: 'Ends 11/10 } see section {2' });

    expect(html).toContain('Ends 11/10 } see section {2');
    expect(readSpot(html, OPEN_FULL_COURSE).state).toBe('full');
  });

  it('refuses a model too large to be one course, and one that will not parse', () => {
    const huge = variant({ RegistrationInfo: 'x'.repeat(70_000) });
    expect(readSpot(huge, OPEN_FULL_COURSE)).toEqual({ state: 'unreadable', reason: 'bad_model' });

    const truncated = `${variant().slice(0, 400)}`;
    expect(readSpot(truncated, OPEN_FULL_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'bad_model',
    });
  });
});

describe('readSpot — the states no captured page shows', () => {
  it.each([
    ['full — the real model, unchanged, through the variant harness', {}, 'full'],
    ['waitlist_full, when the waitlist has none', { WaitListSpotsLeft: 0 }, 'waitlist_full'],
    ['full, when no waitlist is offered at all', { IsWaitListAvailable: false }, 'full'],
  ])('classifies %s', (_label, overrides, state) => {
    // The first row is the control: it must reproduce the real page's own reading, or
    // the two below are variants of nothing.
    expect(readSpot(variant(overrides), OPEN_FULL_COURSE).state).toBe(state);
  });

  it.each([
    ['closed', { IsRegistrationClosed: true }, 'closed'],
    ['not yet open', { IsFutureRegistration: true }, 'future'],
    ['not bookable online', { OnlineRegistration: false }, 'offline'],
  ])('calls a page that is %s not_registrable', (_label, overrides, reason) => {
    // Flipped one at a time on a model that is otherwise open, which is the only way to
    // prove the branch order: each of these must beat the counters that say "seats".
    expect(readSpot(variant(overrides), OPEN_FULL_COURSE)).toMatchObject({
      state: 'not_registrable',
      reason,
    });
  });
});

describe('readSpot — evidence is quoted from the bytes', () => {
  it.each([
    ['markham-course', MARKHAM_COURSE],
    ['newmarket-course', NEWMARKET_COURSE],
    ['nvrc-course', NVRC_COURSE],
    ['oakville-course', OAKVILLE_COURSE],
    ['open-window-markham', OPEN_FULL_COURSE],
    ['open-window-open-markham', OPEN_SEATS_COURSE],
  ])('every fragment %s yields is literally in the page', (name, courseId) => {
    const html = fixture(name);
    const reading = readSpot(html, courseId);

    if (reading.state === 'unreadable') throw new Error(`unreadable/${reading.reason}`);
    expect(reading.evidence.length).toBeGreaterThan(0);
    for (const fragment of reading.evidence) {
      expect(html).toContain(fragment);
    }
  });

  it('drops a schedule fragment the bytes escaped, and keeps the reading', () => {
    // The asymmetry that keeps a watch alive. .NET serialisers escape characters this
    // one does not, so a StartTime the page wrote as an escape parses to the same
    // string and re-serialises to a fragment that is nowhere in the bytes. Failing the
    // whole page there would lose a full-to-open transition over a parenthetical.
    const escaped = variant().replace('"StartTime":"05:00 PM"', '"StartTime":"05:00 \\u0050M"');
    const reading = readSpot(escaped, OPEN_FULL_COURSE);

    expect(escaped).not.toContain('"StartTime":"05:00 PM"');
    expect(readable(reading).state).toBe('full');
    expect(readable(reading).model.StartTime).toBe('05:00 PM');
    expect(readable(reading).evidence).toContain('"StartDay":"Monday"');
    expect(readable(reading).evidence).not.toContain('"StartTime":"05:00 PM"');
  });

  it('will not call a page a state when its own serialisation moved', () => {
    // One space after a colon is the whole mutation: the model still parses and still
    // says SpotsLeft 0, but the sentence Hale would send can no longer be traced to a
    // literal run of bytes on the page — so the reading is refused rather than trusted.
    const moved = variant().replace('"SpotsLeft":0', '"SpotsLeft": 0');
    const intact = readSpot(variant(), OPEN_FULL_COURSE);

    expect(readable(intact).model.SpotsLeft).toBe(0);
    expect(readable(intact).evidence).toContain('"SpotsLeft":0');
    expect(readSpot(moved, OPEN_FULL_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'inconsistent',
    });
  });
});

describe('transitionKind', () => {
  const reading = (overrides: Record<string, unknown>) =>
    readSpot(variant(overrides), OPEN_FULL_COURSE);
  const open = readSpot(fixture('open-window-open-markham'), OPEN_SEATS_COURSE);
  const fullWithWaitlistRoom = reading({});
  const fullNoWaitlist = reading({ IsWaitListAvailable: false });
  const waitlistFull = reading({ WaitListSpotsLeft: 0 });

  it.each([
    ['full', open, 'seat_opened'],
    ['waitlist_full', open, 'seat_opened'],
    ['waitlist_full', fullWithWaitlistRoom, 'waitlist_reopened'],
    ['waitlist_full', fullNoWaitlist, null],
    ['waitlist_full', waitlistFull, null],
    ['full', waitlistFull, null],
    ['open', fullWithWaitlistRoom, null],
    ['full', reading({ IsRegistrationClosed: true }), null],
  ] as const)('%s -> the new reading', (prev, next, kind) => {
    expect(transitionKind(prev, next)).toBe(kind);
  });
});
