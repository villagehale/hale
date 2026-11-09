import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type BookMe4Model, readSpot } from './availability';
import { type SpotOpenFacts, spotOpenBody, spotOpenFacts, spotOpenRefusals } from './copy';

/**
 * VIL-337 · the facts a spot-opened text rests on, and the draft refusals.
 *
 * The model writes the words (spot-open-voice, judged by run-spot-open-voice-eval.mjs).
 * What is tested here is the part that must not depend on a model: every fact the writer
 * is handed is on THIS tick's page, and a draft that prints a number the page did not
 * publish, carries a link, or asks a question is refused.
 */

const URL =
  'https://cityofexample.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=00000000-1111-2222-3333-444444444444&courseId=55555555-6666-7777-8888-999999999999';
const PORTAL = "Riverton's portal";

/** A real class saved with its window open and its roster full, through the
 * reader, so the base is the object the sweep would hand over. */
const baseReading = readSpot(
  readFileSync(join(__dirname, 'fixtures', 'open-window-markham.html'), 'utf8'),
  '85770d4d-bce9-4e53-b969-cf7e88775180',
);
if (baseReading.state === 'unreadable') {
  throw new Error(`open-window-markham.html is unreadable/${baseReading.reason}`);
}
const baseModel: BookMe4Model = baseReading.model;

function model(overrides: Partial<BookMe4Model>): BookMe4Model {
  return { ...baseModel, StartDay: null, StartTime: null, ...overrides };
}

function facts(overrides: Partial<SpotOpenFacts> = {}): SpotOpenFacts {
  return {
    kind: 'seat_opened',
    source: PORTAL,
    label: 'Tue swim',
    spotsLeft: 2,
    schedule: 'Saturday 09:30 AM',
    language: 'en',
    ...overrides,
  };
}

describe('spotOpenFacts — a seat', () => {
  it('hands the writer the count and schedule this tick serialised', () => {
    const prepared = spotOpenFacts({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
      evidence: ['"SpotsLeft":2', '"StartDay":"Saturday"', '"StartTime":"09:30 AM"'],
      language: 'fr',
    });

    expect(prepared).toEqual({
      ok: true,
      facts: {
        kind: 'seat_opened',
        source: PORTAL,
        label: 'Tue swim',
        spotsLeft: 2,
        schedule: 'Saturday 09:30 AM',
        language: 'fr',
      },
    });
  });

  it('withholds a schedule the bytes did not carry, and keeps the seat', () => {
    const prepared = spotOpenFacts({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
      evidence: ['"SpotsLeft":2'],
      language: 'en',
    });

    expect(prepared.ok && prepared.facts.schedule).toBeNull();
    expect(prepared.ok && prepared.facts.spotsLeft).toBe(2);
  });

  it.each([
    ['a count the bytes do not carry', 2, ['"SpotsLeft":3'], 'unbacked_count'],
    ['no seat at all', 0, ['"SpotsLeft":0'], 'no_seat'],
  ])('refuses %s', (_name, spotsLeft, evidence, reason) => {
    const prepared = spotOpenFacts({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      model: model({ SpotsLeft: spotsLeft }),
      evidence,
      language: 'en',
    });

    expect(prepared).toEqual({ ok: false, reasons: [reason] });
  });
});

describe('spotOpenFacts — a waitlist', () => {
  const backed = ['"IsWaitListAvailable":true', '"WaitListSpotsLeft":3'];

  it('carries no count for a queue', () => {
    const prepared = spotOpenFacts({
      kind: 'waitlist_reopened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      model: model({ SpotsLeft: 0, IsWaitListAvailable: true, WaitListSpotsLeft: 3 }),
      evidence: backed,
      language: 'en',
    });

    expect(prepared.ok && prepared.facts.spotsLeft).toBeNull();
  });

  it('refuses a waitlist the bytes do not show room on', () => {
    const prepared = spotOpenFacts({
      kind: 'waitlist_reopened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      model: model({ SpotsLeft: 0, IsWaitListAvailable: true, WaitListSpotsLeft: 3 }),
      evidence: ['"IsWaitListAvailable":true', '"WaitListSpotsLeft":0'],
      language: 'en',
    });

    expect(prepared).toEqual({ ok: false, reasons: ['unbacked_waitlist'] });
  });
});

describe('spotOpenRefusals', () => {
  it('passes a draft whose numbers are all on the page or in the label', () => {
    // The positive control for every refusal below.
    const draft = "Riverton's portal shows 2 spots in Swimmer 3 now, Saturdays at 9:30.";
    expect(spotOpenRefusals(draft, facts({ label: 'Swimmer 3' }))).toEqual([]);
  });

  it.each([
    ['a count the page did not publish', "Riverton's portal shows 3 spots left.", 'unbacked_digit'],
    ['a link', "Riverton's portal has room: https://example.com/x", 'link'],
    ['a bare web address', "Book at riverton.ca, there's room.", 'link'],
    ['a question', "Riverton's portal shows 2 spots. Want me to grab one?", 'asks_a_question'],
    ['nothing', '   ', 'empty'],
  ])('refuses %s', (_name, draft, refusal) => {
    expect(spotOpenRefusals(draft, facts())).toContain(refusal);
  });

  it('refuses any count on a waitlist text', () => {
    const waitlist = facts({ kind: 'waitlist_reopened', spotsLeft: null, schedule: null });
    expect(spotOpenRefusals("Riverton's portal has 5 places on the waitlist.", waitlist)).toEqual([
      'unbacked_digit',
    ]);
    expect(spotOpenRefusals("Riverton's portal has room on the waitlist again.", waitlist)).toEqual(
      [],
    );
  });
});

describe('spotOpenBody', () => {
  it('puts the sanitized link on its own line after the text', () => {
    expect(spotOpenBody('  Room in Tue swim.  ', URL)).toBe(`Room in Tue swim.\n${URL}`);
  });
});
