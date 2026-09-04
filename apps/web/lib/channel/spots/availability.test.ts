import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SpotReading, readSpot, transitionKind } from './availability';

/**
 * VIL-337 · the reader, against the real bytes three PerfectMind tenants served.
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
 * reader currently returns. All three saved pages are registration-CLOSED, so the
 * open-window branches are driven by `open-full.assumption.json` — a hand-edited copy
 * of the Markham model — and every test that rests on it says ASSUMPTION in its name.
 */

const MARKHAM_COURSE = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const NEWMARKET_COURSE = '5f397fce-9475-4fcf-96d5-8769645f06b3';
const NVRC_COURSE = 'e1533a1c-30bf-4ef2-8765-3e123ec964db';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `${name}.html`), 'utf8');
}

const assumedOpenFull = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'open-full.assumption.json'), 'utf8'),
) as Record<string, unknown>;

/** ASSUMPTION fixtures only. The PAGE shape is the real one — the three saved tenants
 * prove that — and only the model's values are hand-edited. */
function pageWith(model: Record<string, unknown>): string {
  return `<html><body><script>\r\n  var eventInfo = $.extend(true, {}, {\r\n    BackAction: { Url: '/Clients/BookMe4' }\r\n  }, ${JSON.stringify(model)});\r\n</script></body></html>`;
}

function assumed(overrides: Record<string, unknown> = {}): string {
  return pageWith({ ...assumedOpenFull, ...overrides });
}

/** Narrows away the unreadable arm, and fails loudly rather than skipping when a
 * reading a test is about turns out to carry no model. */
function readable(reading: SpotReading) {
  if (reading.state === 'unreadable') {
    throw new Error(`expected a readable page, got unreadable/${reading.reason}`);
  }
  return reading;
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
    const withModel = errorPage.replace('</body>', `${assumed()}</body>`);

    expect(readSpot(withModel, MARKHAM_COURSE).state).toBe('full');
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
  ])('refuses %s — the counters and the flags must agree (ASSUMPTION fixture)', (_why, model) => {
    expect(readSpot(assumed(model), MARKHAM_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'inconsistent',
    });
  });

  it('refuses a model too large to be one course, and one that will not parse', () => {
    const huge = assumed({ RegistrationInfo: 'x'.repeat(70_000) });
    expect(readSpot(huge, MARKHAM_COURSE)).toEqual({ state: 'unreadable', reason: 'bad_model' });

    const truncated = `${assumed().slice(0, 400)}`;
    expect(readSpot(truncated, MARKHAM_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'bad_model',
    });
  });
});

describe('readSpot — the open-window states (ASSUMPTION fixture)', () => {
  it.each([
    ['full, with room on the waitlist', {}, 'full'],
    ['waitlist_full, when the waitlist has none', { WaitListSpotsLeft: 0 }, 'waitlist_full'],
    ['full, when no waitlist is offered at all', { IsWaitListAvailable: false }, 'full'],
    ['open, when the page shows seats', { IsFull: false, SpotsLeft: 2, CanNotBook: false }, 'open'],
  ])('classifies %s', (_label, overrides, state) => {
    expect(readSpot(assumed(overrides), MARKHAM_COURSE).state).toBe(state);
  });

  it.each([
    ['closed', { IsRegistrationClosed: true }, 'closed'],
    ['not yet open', { IsFutureRegistration: true }, 'future'],
    ['not bookable online', { OnlineRegistration: false }, 'offline'],
  ])('calls a page that is %s not_registrable', (_label, overrides, reason) => {
    expect(readSpot(assumed(overrides), MARKHAM_COURSE)).toMatchObject({
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
  ])('every fragment %s yields is literally in the page', (name, courseId) => {
    const html = fixture(name);
    const reading = readSpot(html, courseId);

    if (reading.state === 'unreadable') throw new Error(`unreadable/${reading.reason}`);
    expect(reading.evidence.length).toBeGreaterThan(0);
    for (const fragment of reading.evidence) {
      expect(html).toContain(fragment);
    }
  });

  it('will not call a page a state when its own serialisation moved (ASSUMPTION fixture)', () => {
    // One space after a colon is the whole mutation: the model still parses and still
    // says SpotsLeft 0, but the sentence Hale would send can no longer be traced to a
    // literal run of bytes on the page — so the reading is refused rather than trusted.
    const moved = assumed().replace('"SpotsLeft":0', '"SpotsLeft": 0');
    const intact = readSpot(assumed(), MARKHAM_COURSE);

    expect(readable(intact).model.SpotsLeft).toBe(0);
    expect(readable(intact).evidence).toContain('"SpotsLeft":0');
    expect(readSpot(moved, MARKHAM_COURSE)).toEqual({
      state: 'unreadable',
      reason: 'inconsistent',
    });
  });
});

describe('transitionKind', () => {
  const reading = (overrides: Record<string, unknown>) =>
    readSpot(assumed(overrides), MARKHAM_COURSE);
  const open = reading({ IsFull: false, SpotsLeft: 2, CanNotBook: false });
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
