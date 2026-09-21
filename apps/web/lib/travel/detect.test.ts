import { describe, expect, it } from 'vitest';
import { HOME_METRO, isAwayDestination } from './away';
import { destinationShape, localCalendarDay, looksLikeBooking } from './detect';

/**
 * The three deterministic gates, tested apart from the pass that calls them.
 *
 * Each one exists because the alternative failed somewhere real: the two-token filter
 * because a keyword matcher over ordinary household words shipped a destructive false
 * positive twice; the shape gate because the query-time scrub runs long after the column
 * is persisted and exported; the metro list because a hotel writes a district and a
 * 21-town list reads eight of them as another country.
 */

const CHILDREN = ['Mia', 'Sydney', 'Paris'];

describe('looksLikeBooking', () => {
  /**
   * Derived from what a confirmation email actually says, never from what the matcher
   * happens to accept — and each one carries BOTH halves: a booking noun in the subject
   * and a travel co-token in the subject or the snippet.
   */
  it('accepts a real confirmation, in each of the four shapes one arrives in', () => {
    const positives = [
      { subject: 'Your itinerary for AC 704', snippet: 'Departure Toronto YYZ, boarding 8:10' },
      { subject: 'Reservation confirmed - Hotel Indigo', snippet: '2 nights, check-out Sunday' },
      { subject: 'Your trip to New York', snippet: 'flight and hotel in one place' },
      { subject: 'e-Ticket Receipt', snippet: 'airline confirmation for your upcoming journey' },
    ];
    for (const envelope of positives) {
      expect(looksLikeBooking(envelope), envelope.subject).toBe(true);
    }
  });

  /**
   * THE HARD NEGATIVES, each beside a positive in the same `it` — an absence assertion on
   * its own fails open, and a matcher that rejected everything would pass a negatives-only
   * test perfectly.
   *
   * The last three are the ones the SECOND token is for. Every one of them carries a
   * booking noun a single-token filter would have accepted, and what it would have cost is
   * not a wasted model call: it is that email's BODY plus the household's children's first
   * names crossing the border to a US model.
   */
  it('refuses the household emails a single booking noun would have let through', () => {
    const negatives = [
      { subject: 'Your order has shipped', snippet: 'tracking number inside' },
      { subject: 'Booking confirmed: haircut Thursday', snippet: 'see you at 2' },
      { subject: 'Your reservation is ready for pickup', snippet: 'Toronto Public Library' },
      { subject: 'Check-in is now open', snippet: 'daily sign-in sheet for the room' },
      { subject: 'Swim class cancelled', snippet: 'the pool is closed this week' },
      { subject: 'Reserve your spot in fall swim', snippet: 'registration opens Tuesday' },
    ];
    for (const envelope of negatives) {
      expect(looksLikeBooking(envelope), envelope.subject).toBe(false);
    }
    // The positive control, in the same `it`: the filter is not simply saying no.
    expect(
      looksLikeBooking({ subject: 'Your itinerary', snippet: 'departing Friday' }),
    ).toBe(true);
  });

  it('needs the booking noun in the SUBJECT, not merely somewhere in the email', () => {
    expect(
      looksLikeBooking({ subject: 'A note from the office', snippet: 'your itinerary is attached, flight at 9' }),
    ).toBe(false);
    // Same words, moved: the subject line is the one field a confirmation spends on
    // saying what it is.
    expect(
      looksLikeBooking({ subject: 'Your itinerary is attached', snippet: 'flight at 9' }),
    ).toBe(true);
  });

  it('is word-boundary anchored, so "reserve" is not "reservation"', () => {
    expect(looksLikeBooking({ subject: 'Reserve a room', snippet: 'hotel deals' })).toBe(false);
    expect(looksLikeBooking({ subject: 'Reservation', snippet: 'hotel deals' })).toBe(true);
  });
});

describe('destinationShape', () => {
  it('accepts a place name in the alphabets a real destination is written in', () => {
    for (const city of ['Toronto', 'New York', 'Saint-Sauveur', "St. John's", 'Québec', 'Kōbe']) {
      expect(destinationShape(city, CHILDREN), city).toBe(true);
    }
  });

  /**
   * Everything a model writes when it was asked for "the location" and reached for the
   * nearest string: a booking reference, a property line, a room number, a street, an
   * email address. Each one carries a digit, an `@` or a `#`, which is exactly the class
   * `scrubResidualPii` does NOT catch at query time — and by then the value has already
   * been persisted and served to the rights export.
   */
  it('refuses a reference, a property line, a room, a street and an address', () => {
    for (const bad of [
      'ABC123',
      'Marriott #4471',
      'Room 412',
      '1535 Broadway',
      'guest@example.com',
      'Toronto, ON',
      'Toronto/Pearson',
      '',
    ]) {
      expect(destinationShape(bad, CHILDREN), bad).toBe(false);
    }
    // Positive control: the gate is not refusing everything.
    expect(destinationShape('Toronto', CHILDREN)).toBe(true);
  });

  /**
   * A child called Sydney, Paris, Austin or Victoria whose family goes there. The refusal
   * runs HERE, at the write, rather than at the query gate: `gateFreeText` would catch it
   * on the way to the search, long after the name had been stored in a column and served
   * in a right-to-access copy.
   */
  it('refuses a city that is also a member of this household', () => {
    expect(destinationShape('Sydney', CHILDREN)).toBe(false);
    expect(destinationShape('Paris', CHILDREN)).toBe(false);
    // The same two strings for a household with different children: the refusal is about
    // this family, not about a blocklist of city names.
    expect(destinationShape('Sydney', ['Mia'])).toBe(true);
    expect(destinationShape('Paris', ['Mia'])).toBe(true);
  });
});

describe('isAwayDestination', () => {
  it('reads all 25 GTA municipalities as home, not just the 21 with a verified calendar', () => {
    for (const town of [
      'Toronto',
      'Markham',
      'Vaughan',
      'Richmond Hill',
      'Mississauga',
      'Oakville',
      'Burlington',
      'Halton Hills',
      'Brampton',
      'Caledon',
      'Ajax',
      'Pickering',
      'Whitby',
      'Oshawa',
      'Aurora',
      'Stouffville',
      'Newmarket',
      'King',
      'East Gwillimbury',
      'Georgina',
      'Uxbridge',
      // The four in the region with no verified registration calendar — a fact about the
      // radar, not about whether a family had to travel.
      'Milton',
      'Clarington',
      'Brock',
      'Scugog',
    ]) {
      expect(isAwayDestination(town), town).toBe(false);
    }
    expect(HOME_METRO.length).toBeGreaterThanOrEqual(25);
  });

  /**
   * THE DISTRICT HALF, and it is the reason this list is not the registration union. A
   * hotel, an Airbnb or an airline writes its own locality, and without these names a
   * Toronto family whose confirmation says Scarborough gets "You're in Scarborough the
   * 12th to the 15th."
   */
  it('reads the district names a hotel writes as home too', () => {
    for (const district of [
      'Scarborough',
      'North York',
      'Etobicoke',
      'Thornhill',
      'Woodbridge',
      'Unionville',
      'Port Credit',
      'Streetsville',
      'Bramalea',
      'Georgetown',
    ]) {
      expect(isAwayDestination(district), district).toBe(false);
    }
  });

  it('reads a real destination as away — the positive control the two lists above need', () => {
    for (const city of ['New York', 'Ottawa', 'Montreal', 'Vancouver', 'Québec', 'Blue Mountain']) {
      expect(isAwayDestination(city), city).toBe(true);
    }
  });

  it('normalises case, accents and punctuation, so one spelling is one place', () => {
    expect(isAwayDestination('TORONTO')).toBe(false);
    expect(isAwayDestination('north  york')).toBe(false);
    expect(isAwayDestination('Richmond-Hill')).toBe(false);
  });
});

describe('localCalendarDay', () => {
  /**
   * "Today" is the PARENT's calendar day, never UTC. A boundary computed on the wrong
   * clock is one that is wrong for seven hours of every day — which is exactly the window
   * in which an evening detection would read tomorrow's trip as being in the past.
   */
  it('answers on the parent zone, not on UTC', () => {
    const at = new Date('2026-09-13T02:30:00.000Z');
    expect(localCalendarDay(at, 'UTC')).toBe('2026-09-13');
    expect(localCalendarDay(at, 'America/Toronto')).toBe('2026-09-12');
    expect(localCalendarDay(at, 'America/Vancouver')).toBe('2026-09-12');
    expect(localCalendarDay(at, 'Asia/Tokyo')).toBe('2026-09-13');
  });
});
