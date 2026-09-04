import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withOptOut } from '~/lib/channel/opt-out';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import type { BookMe4Model } from './availability';
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

const baseModel = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'open-full.assumption.json'), 'utf8'),
) as BookMe4Model;

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
      evidence: ['"SpotsLeft":2'],
    });

    expect(body).toBe(`${PORTAL} now shows 2 spots left for Tue swim (Saturday 09:30 AM). ${URL}`);
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
});

describe('renderSpotOpen — what every body must satisfy', () => {
  const body = renderSpotOpen({
    kind: 'seat_opened',
    portalLabel: PORTAL,
    label: 'Tue swim',
    url: URL,
    model: model({ SpotsLeft: 2, StartDay: 'Saturday', StartTime: '09:30 AM' }),
    evidence: ['"SpotsLeft":2'],
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
      evidence: ['"SpotsLeft":100'],
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

  it('refuses a headcount on a waitlist sentence', () => {
    const body = `${PORTAL} now shows room on the waitlist for Tue swim, 2 spots left. ${URL}`;

    expect(
      spotOpenViolations(body, { ...context, kind: 'waitlist_reopened', count: null }),
    ).toEqual(expect.arrayContaining(['counts_a_waitlist', 'unbacked_digit']));
  });
});
