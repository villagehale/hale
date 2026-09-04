import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withOptOut } from '~/lib/channel/opt-out';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import { type BookMe4Model, readSpot } from './availability';
import { MAX_SPOT_OPEN_SEGMENTS, renderSpotOpen, spotOpenViolations } from './copy';

/**
 * VIL-337 · the two sentences a watched spot may send.
 *
 * A spot-opened text arrives unprompted, carries a number, and asks a parent to drop
 * what they are doing and go and register. So the number is the whole risk: "3 spots
 * left" when the page says 1 is a text that costs somebody a morning, and it is the
 * kind of error an interpolation bug makes silently. Every digit outside the URL must
 * therefore be a run of characters that is literally on the page it came from, and the
 * composer refuses to emit a body it cannot back.
 */

const URL =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const PORTAL = "Markham's portal";

/** The model Markham published for a real class whose registration window was open
 * and whose roster was full — the state a seat_opened text is composed against. Taken
 * through the reader rather than from a saved copy, so the composer's base is the same
 * object the sweep would hand it. */
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

/** Everything the body says that is not the link — where a stray digit would show up. */
function outsideTheUrl(body: string): string {
  return body.replace(URL, ' ');
}

describe('renderSpotOpen — a seat', () => {
  it.each([
    [2, '2 spots left'],
    [1, '1 spot left'],
  ])('prints the count the page serialised, and nothing else (%i)', (spotsLeft, phrase) => {
    const body = renderSpotOpen({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      url: URL,
      model: model({ SpotsLeft: spotsLeft }),
      evidence: [`"SpotsLeft":${spotsLeft}`],
    });

    expect(body).toBe(`${PORTAL} now shows ${phrase} for Tue swim. ${URL}`);
    expect(outsideTheUrl(body).match(/\d+/g)).toEqual([String(spotsLeft)]);
  });

  it('carries the schedule the model published, verbatim', () => {
    const body = renderSpotOpen({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      url: URL,
      model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
      evidence: ['"SpotsLeft":2', '"StartDay":"Saturday"', '"StartTime":"09:30 AM"'],
    });

    expect(body).toBe(`${PORTAL} now shows 2 spots left for Tue swim (Saturday 09:30 AM). ${URL}`);
  });

  it("drops the parenthetical when this tick's bytes do not carry the schedule", () => {
    // The stored-reading defect in its quietest form: a model whose schedule fields the
    // page did not serialise the way they are re-serialised here. The parenthetical is
    // decoration, so it is what gets dropped -- the seat is still worth the text.
    const body = renderSpotOpen({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      url: URL,
      model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
      evidence: ['"SpotsLeft":2'],
    });

    expect(body).toBe(`${PORTAL} now shows 2 spots left for Tue swim. ${URL}`);
  });

  it('THROWS rather than announce a seat the counter does not show', () => {
    // `transitionKind` only says seat_opened off a reading with SpotsLeft > 0, so a zero
    // here means the composer was handed a kind and a model from different ticks. "0
    // spots left" is a text that sends a parent to a full page.
    expect(() =>
      renderSpotOpen({
        kind: 'seat_opened',
        portalLabel: PORTAL,
        label: 'Tue swim',
        url: URL,
        model: model({ SpotsLeft: 0 }),
        evidence: ['"SpotsLeft":0'],
      }),
    ).toThrow(/no_seat/);
  });

  it('THROWS on a count the evidence does not carry', () => {
    // The defect this exists for: a composer handed a stored reading, or a count read
    // from one field and quoted from another. There is no fallback — a spot text with
    // an unbacked number is not sent at all.
    expect(() =>
      renderSpotOpen({
        kind: 'seat_opened',
        portalLabel: PORTAL,
        label: 'Tue swim',
        url: URL,
        model: model({ SpotsLeft: 3 }),
        evidence: ['"SpotsLeft":2'],
      }),
    ).toThrow(/unbacked_count/);
  });
});

describe('renderSpotOpen — a waitlist', () => {
  it('says there is room and counts nothing', () => {
    // The model carries WaitListCapacity and WaitListSpotsLeft, so "5 on the waitlist"
    // would be 99 minus 94 — arithmetic over two fields, which is exactly the derived
    // number the evidence rule forbids. The sentence therefore has no headcount at all.
    const body = renderSpotOpen({
      kind: 'waitlist_reopened',
      portalLabel: PORTAL,
      label: 'Tue swim',
      url: URL,
      model: model({ WaitListSpotsLeft: 94 }),
      evidence: ['"IsWaitListAvailable":true', '"WaitListSpotsLeft":94'],
    });

    expect(body).toBe(`${PORTAL} now shows room on the waitlist for Tue swim. ${URL}`);
    expect(body).not.toMatch(/spots?\s+left/i);
    expect(outsideTheUrl(body)).not.toMatch(/\d/);
  });

  it.each([
    [
      'a waitlist with nobody able to join it',
      model({ WaitListSpotsLeft: 0 }),
      ['"IsWaitListAvailable":true', '"WaitListSpotsLeft":0'],
    ],
    [
      'a page whose bytes never said there was room',
      model({ WaitListSpotsLeft: 94 }),
      ['"SpotsLeft":0'],
    ],
    [
      'a tenant that offers no waitlist at all',
      model({ IsWaitListAvailable: false, WaitListSpotsLeft: 94 }),
      ['"IsWaitListAvailable":false', '"WaitListSpotsLeft":94'],
    ],
  ])('THROWS on %s', (_why, published, evidence) => {
    // "room on the waitlist" carries no digits, which is exactly why it needs a gate of
    // its own: an unbacked count is caught by the digits, an unbacked CLAIM is not.
    expect(() =>
      renderSpotOpen({
        kind: 'waitlist_reopened',
        portalLabel: PORTAL,
        label: 'Tue swim',
        url: URL,
        model: published,
        evidence,
      }),
    ).toThrow(/unbacked_waitlist/);
  });
});

describe('renderSpotOpen — what every body must satisfy', () => {
  const body = renderSpotOpen({
    kind: 'seat_opened',
    portalLabel: PORTAL,
    label: 'Tue swim',
    url: URL,
    model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
    evidence: ['"SpotsLeft":2', '"StartDay":"Saturday"', '"StartTime":"09:30 AM"'],
  });

  it('leads with the source and carries the link verbatim', () => {
    // The attribution is the part a parent cannot check without the link, so the SOURCE
    // is the subject of the sentence and the label beside it is hand-written.
    expect(body.startsWith(PORTAL)).toBe(true);
    expect(body).toContain(URL);
  });

  it('asks nothing, and claims nothing a ledger would have to back', () => {
    // The ticket's own draft ended "Want the link?" — a question with no row behind it
    // is the 2026-08-22 defect, and the link is already in the text.
    expect(outsideTheUrl(body)).not.toContain('?');
    expect(extractStateClaims(body)).toEqual([]);
  });

  it('fits three segments in its worst case, in GSM-7', () => {
    // The worst case a real send can reach: the longest URL the sanitizer will pass, a
    // 40-character label, a three-digit count, a full schedule and the FULL CASL line.
    const longUrl = `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${'a'.repeat(36)}&courseId=${'b'.repeat(60)}`;
    expect(longUrl.length).toBe(200);
    const worst = renderSpotOpen({
      kind: 'seat_opened',
      portalLabel: PORTAL,
      label: 'Wednesday preschool swim at the rec centre',
      url: longUrl,
      model: model({ SpotsLeft: 100, StartDay: 'Wednesday', StartTime: '12:30 PM' }),
      evidence: ['"SpotsLeft":100', '"StartDay":"Wednesday"', '"StartTime":"12:30 PM"'],
    });

    expect(isGsm7(worst)).toBe(true);
    expect(smsSegments(withOptOut(worst, 'full'))).toBeLessThanOrEqual(MAX_SPOT_OPEN_SEGMENTS);
  });
});

describe('spotOpenViolations', () => {
  const context = {
    url: URL,
    evidence: ['"SpotsLeft":2'] as readonly string[],
    kind: 'seat_opened' as const,
    count: 2,
    when: null,
    model: model({ SpotsLeft: 2 }),
  };
  const good = `${PORTAL} now shows 2 spots left for Tue swim. ${URL}`;

  it('passes the body the composer emits (positive control)', () => {
    expect(spotOpenViolations(good, context)).toEqual([]);
  });

  it.each([
    ['url_missing', good.replace(URL, 'the portal')],
    ['asks_a_question', good.replace('.', '. Want the link?')],
    ['unbacked_digit', good.replace('Tue swim', 'Tue swim, 15 min drive')],
    ['not_gsm7', good.replace('Tue swim', 'Tue swim — the 4pm one')],
  ])('names %s', (violation, body) => {
    expect(spotOpenViolations(body, context)).toContain(violation);
  });

  it("names unbacked_when for a parenthetical this tick's bytes do not carry", () => {
    // The gate is what a caller composing its own body runs into: the composer drops an
    // unbacked schedule, so this violation can only be reached from outside it.
    const body = `${PORTAL} now shows 2 spots left for Tue swim (Saturday 09:30 AM). ${URL}`;

    expect(spotOpenViolations(body, { ...context, when: 'Saturday 09:30 AM' })).toContain(
      'unbacked_when',
    );
    expect(
      spotOpenViolations(body, {
        ...context,
        when: 'Saturday 09:30 AM',
        model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
        evidence: ['"SpotsLeft":2', '"StartDay":"Saturday"', '"StartTime":"09:30 AM"'],
      }),
    ).toEqual([]);
  });

  it('refuses a headcount on a waitlist sentence', () => {
    const body = `${PORTAL} now shows room on the waitlist for Tue swim, 2 spots left. ${URL}`;

    expect(
      spotOpenViolations(body, { ...context, kind: 'waitlist_reopened', count: null }),
    ).toEqual(expect.arrayContaining(['counts_a_waitlist', 'unbacked_digit']));
  });
});
