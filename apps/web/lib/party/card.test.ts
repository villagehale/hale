import { describe, expect, it } from 'vitest';
import { GUEST_OF_HONOUR, buildPartyCard, partyWhen, redactTeenNames } from './card';

/**
 * VIL-245 · M10 — the public invite card is the ONE surface in Hale that shows a
 * family's own words to strangers, so its two jobs are tested here against the SPEC,
 * not against whatever the builder currently emits:
 *
 *   1. Host-entered content is passed through. The address IS the invitation; a card
 *      that hid where the party is would not be an invitation.
 *   2. A 13+ child is never named on it (rule #1), even though the host typed the name
 *      and even though nothing in the row is marked sensitive. The gate is the child's
 *      AGE, applied at READ time.
 */

const TORONTO = 'America/Toronto';

describe('redactTeenNames', () => {
  it("replaces a teen's first name wherever the host typed it", () => {
    expect(redactTeenNames("Maya's 16th birthday", ['Maya'])).toBe(
      `${GUEST_OF_HONOUR}'s 16th birthday`,
    );
    expect(redactTeenNames('at Maya house', ['Maya'])).toBe(`at ${GUEST_OF_HONOUR} house`);
  });

  it('is case-insensitive — a host who typed lowercase is not a loophole', () => {
    expect(redactTeenNames('maya turns 16', ['Maya'])).toBe(`${GUEST_OF_HONOUR} turns 16`);
    expect(redactTeenNames('MAYA turns 16', ['Maya'])).toBe(`${GUEST_OF_HONOUR} turns 16`);
  });

  it('redacts every teen in the household, not just the first', () => {
    expect(redactTeenNames('Maya and Noor turn 16', ['Maya', 'Noor'])).toBe(
      `${GUEST_OF_HONOUR} and ${GUEST_OF_HONOUR} turn 16`,
    );
  });

  it('matches whole words only — a name inside a longer word is not the child', () => {
    // "Sam" must not eat "Samosa Palace", which is a restaurant a party could be at.
    expect(redactTeenNames('Samosa Palace', ['Sam'])).toBe('Samosa Palace');
    expect(redactTeenNames('Kensington Market', ['Ken'])).toBe('Kensington Market');
  });

  it('leaves text alone when the household has no teenagers', () => {
    expect(redactTeenNames("Max's 5th birthday", [])).toBe("Max's 5th birthday");
  });

  it('treats a regex-special name as literal text, never as a pattern', () => {
    // A name is user data. If it compiled as a pattern, a name like "A." would redact
    // every two-character run in the title.
    expect(redactTeenNames('A. and Bo', ['A.'])).toBe(`${GUEST_OF_HONOUR} and Bo`);
    expect(redactTeenNames('Ax and Bo', ['A.'])).toBe('Ax and Bo');
  });
});

describe('partyWhen', () => {
  it('spells the date out in the FAMILY zone, not the viewer’s', () => {
    // 2026-08-22T18:00Z is 2pm Saturday in Toronto.
    const when = partyWhen(new Date('2026-08-22T18:00:00Z'), TORONTO);
    expect(when).toBe('Saturday, August 22 at 2:00 PM');
  });

  it('renders a late-evening instant on the correct local day', () => {
    // 2026-08-24T01:30Z is 9:30pm on the 23rd in Toronto — a naive UTC read would
    // print the 24th and send guests on the wrong day.
    expect(partyWhen(new Date('2026-08-24T01:30:00Z'), TORONTO)).toBe(
      'Sunday, August 23 at 9:30 PM',
    );
  });
});

describe('buildPartyCard', () => {
  const base = {
    title: "Max's 5th birthday",
    location: '14 Elm St',
    startsAt: new Date('2026-08-22T18:00:00Z'),
    timeZone: TORONTO,
    cancelled: false,
  };

  it('passes host-entered title and location through verbatim', () => {
    const card = buildPartyCard({ ...base, teenFirstNames: [] });
    expect(card.title).toBe("Max's 5th birthday");
    expect(card.location).toBe('14 Elm St');
    expect(card.when).toBe('Saturday, August 22 at 2:00 PM');
    expect(card.cancelled).toBe(false);
  });

  it('never names a 13+ child, in the title OR the location', () => {
    const card = buildPartyCard({
      ...base,
      title: "Maya's 16th birthday",
      location: "Maya's house, 14 Elm St",
      teenFirstNames: ['Maya'],
    });
    expect(card.title).not.toMatch(/maya/i);
    expect(card.location).not.toMatch(/maya/i);
    // The address survives — the redaction removes the NAME, not the invitation.
    expect(card.location).toContain('14 Elm St');
  });

  it('keeps a null location null rather than inventing an empty string', () => {
    const card = buildPartyCard({ ...base, location: null, teenFirstNames: [] });
    expect(card.location).toBeNull();
  });

  it('carries the cancelled flag through so the page can say so', () => {
    const card = buildPartyCard({ ...base, cancelled: true, teenFirstNames: [] });
    expect(card.cancelled).toBe(true);
  });
});
