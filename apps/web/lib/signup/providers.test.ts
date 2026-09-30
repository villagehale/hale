import { describe, expect, it } from 'vitest';
import {
  BOOKING_CONNECTORS,
  BOOKING_DENY_SUFFIXES,
  type BookingConnector,
  bookingRoute,
  municipalBookingHost,
} from './providers';

describe('booking route', () => {
  it('registers no connector and names the denied suffixes', () => {
    expect(BOOKING_CONNECTORS).toEqual([]);
    expect(BOOKING_DENY_SUFFIXES).toEqual([
      'activecommunities.com',
      'activenetwork.com',
      'perfectmind.com',
      'xplorrecreation.com',
      'toronto.ca',
      'brampton.ca',
      'markham.ca',
    ]);
  });

  it('sends municipal, ActiveNet, Xplor, and PerfectMind hosts to handoff', () => {
    const denied = [
      'https://anc.ca.apm.activecommunities.com/toronto/activity/search',
      'https://ca.apm.activecommunities.com/markham/activity/search',
      'https://www.activenetwork.com/register',
      'https://register.xplorrecreation.com/brampton',
      'https://city.perfectmind.com/signup',
      'https://www.toronto.ca/explore-enjoy/recreation/registrations',
      'https://www.markham.ca/recreation',
      'https://recreation.brampton.ca/programs',
    ];
    for (const href of denied) {
      expect(bookingRoute(href).kind, href).toBe('handoff');
      expect(municipalBookingHost(new URL(href).hostname), href).toBe(true);
    }
  });

  it('does not deny a private host or a name that merely contains a city', () => {
    expect(municipalBookingHost('tickets.example-zoo.test')).toBe(false);
    expect(municipalBookingHost('swim.example-school.test')).toBe(false);
    expect(municipalBookingHost('nottoronto.ca')).toBe(false);
    expect(municipalBookingHost('toronto.ca.evil.test')).toBe(false);
    expect(bookingRoute('https://tickets.example-zoo.test/book').kind).toBe('browser');
    expect(bookingRoute('http://127.0.0.1:4312/tickets').kind).toBe('browser');
    expect(bookingRoute('http://localhost/reserve').kind).toBe('browser');
  });

  it('prefers a connector over the browser, and the denylist over a connector', () => {
    const connector: BookingConnector = {
      id: 'example-swim-api',
      matches: (url) =>
        url.hostname === 'book.example-swim.test' || url.hostname.endsWith('toronto.ca'),
      book: async () => ({ ok: true }),
    };
    expect(bookingRoute('https://book.example-swim.test/lessons', [connector])).toEqual({
      kind: 'connector',
      connector,
    });
    expect(bookingRoute('https://www.toronto.ca/recreation', [connector]).kind).toBe('handoff');
    expect(bookingRoute('https://tickets.example-zoo.test/book', [connector]).kind).toBe('browser');
  });
});
