import { describe, expect, it } from 'vitest';
import { BOOKING_CONNECTORS, type BookingConnector, bookingRoute } from './providers';

describe('booking route', () => {
  it('registers no connector unconditionally', () => {
    expect(BOOKING_CONNECTORS).toEqual([]);
  });

  it('sends every provider host to the browser, municipal and platform hosts included', () => {
    const hosts = [
      'https://anc.ca.apm.activecommunities.com/toronto/activity/search',
      'https://www.activenetwork.com/register',
      'https://register.xplorrecreation.com/brampton',
      'https://city.perfectmind.com/signup',
      'https://www.toronto.ca/explore-enjoy/recreation/registrations',
      'https://www.vaughan.ca/register',
      'https://activities.oakville.ca/camps',
      'https://app.amilia.com/register',
      'https://tickets.example-zoo.test/book',
      'http://127.0.0.1:4312/tickets',
      'http://localhost/reserve',
    ];
    for (const href of hosts) {
      expect(bookingRoute(href).kind, href).toBe('browser');
    }
  });

  it('prefers a matching connector over the browser on any host', () => {
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
    expect(bookingRoute('https://www.toronto.ca/recreation', [connector]).kind).toBe('connector');
    expect(bookingRoute('https://tickets.example-zoo.test/book', [connector]).kind).toBe('browser');
  });
});
