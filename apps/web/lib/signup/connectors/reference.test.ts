import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { bookingRoute } from '../providers';
import {
  REFERENCE_CONNECTOR_HOST,
  REFERENCE_CONNECTOR_ID,
  type SandboxPartnershipClient,
  referenceBookingConnector,
  sandboxPartnershipBooking,
  sandboxPartnershipClient,
} from './reference';
import { bookingConnectors } from './registry';

const SAMPLE = {
  url: `https://${REFERENCE_CONNECTOR_HOST}/lessons`,
  activityKey: 'swim-parent-tot',
  sessionId: 'tue-1630',
  approvedPriceCents: 1800,
  slots: [
    { slot: 'child_first_name' as const, value: 'Ada' },
    { slot: 'parent_email' as const, value: 'ada@example.test' },
    { slot: 'session' as const, value: 'tue-1630' },
  ],
};

function posted(fetchImpl: { mock: { calls: unknown[][] } }): [unknown, RequestInit] {
  const call = fetchImpl.mock.calls[0];
  if (!call || call.length < 2) throw new Error('expected a sandbox fetch call');
  return [call[0], call[1] as RequestInit];
}

function clientReturning(booked: boolean): SandboxPartnershipClient & { calls: number } {
  const seen = { calls: 0 };
  return {
    get calls() {
      return seen.calls;
    },
    async createBooking() {
      seen.calls += 1;
      return { booked };
    },
  };
}

describe('sandbox partnership connector', () => {
  it('speaks the sandbox booking shape and drops anything outside the slot list', () => {
    const body = sandboxPartnershipBooking({
      ...SAMPLE,
      slots: [
        ...SAMPLE.slots,
        { slot: 'child_first_name', value: '  ' },
        { slot: 'phone' as 'parent_email', value: '+14165550100' },
      ],
    });
    expect(Object.keys(body).sort()).toEqual([
      'activity_key',
      'approved_price_cents',
      'session_id',
      'slots',
    ]);
    expect(body.approved_price_cents).toBe(1800);
    expect(body.slots.map((slot) => slot.slot)).toEqual([
      'child_first_name',
      'parent_email',
      'session',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/card|cvv|cvc|payment/i);
  });

  it('matches only the sandbox registration host', () => {
    const connector = referenceBookingConnector(clientReturning(true));
    expect(connector.id).toBe(REFERENCE_CONNECTOR_ID);
    expect(connector.matches(new URL(`https://${REFERENCE_CONNECTOR_HOST}/lessons`))).toBe(true);
    expect(connector.matches(new URL(`https://www.${REFERENCE_CONNECTOR_HOST}/lessons`))).toBe(
      false,
    );
    expect(connector.matches(new URL('https://book.sandbox-partner.test.evil.com/lessons'))).toBe(
      false,
    );
    expect(connector.matches(new URL('https://www.toronto.ca/recreation'))).toBe(false);
    expect(connector.matches(new URL('https://api.amilia.com/register'))).toBe(false);
  });

  it('refuses a denylisted host without calling the client', async () => {
    const client = clientReturning(true);
    const connector = referenceBookingConnector(client);
    const result = await connector.book({
      ...SAMPLE,
      url: 'https://www.toronto.ca/explore-enjoy/recreation/registrations',
    });
    expect(result).toEqual({ ok: false, reason: 'connector_failed' });
    expect(client.calls).toBe(0);
  });

  it('returns connector_failed when the sandbox call does not book, and does not throw', async () => {
    const failed = await referenceBookingConnector(clientReturning(false)).book(SAMPLE);
    expect(failed).toEqual({ ok: false, reason: 'connector_failed' });
    const thrown = await referenceBookingConnector({
      async createBooking() {
        throw new Error('sandbox down');
      },
    }).book(SAMPLE);
    expect(thrown).toEqual({ ok: false, reason: 'connector_failed' });
  });

  it('books when the sandbox says booked', async () => {
    const result = await referenceBookingConnector(clientReturning(true)).book(SAMPLE);
    expect(result).toEqual({ ok: true });
  });

  it('does not call a real host, an http .test host, or a URL with a secret', async () => {
    const fetchImpl = vi.fn();
    const booking = sandboxPartnershipBooking(SAMPLE);
    const refused = [
      'https://api.real-partner.com',
      'http://api.sandbox-partner.test',
      'https://user:secret@api.sandbox-partner.test',
      'https://www.toronto.ca',
      'https://api.amilia.com',
      '',
    ];
    for (const base of refused) {
      const client = sandboxPartnershipClient(
        { BOOKING_REFERENCE_CONNECTOR_BASE_URL: base },
        fetchImpl,
      );
      await expect(client.createBooking(booking)).resolves.toEqual({ booked: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts JSON to the sandbox path with no authorization header and no spend fields', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'booked', id: 'sb_1' }));
    const client = sandboxPartnershipClient(
      { BOOKING_REFERENCE_CONNECTOR_BASE_URL: 'https://api.sandbox-partner.test' },
      fetchImpl,
    );
    await expect(client.createBooking(sandboxPartnershipBooking(SAMPLE))).resolves.toEqual({
      booked: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = posted(fetchImpl);
    expect(String(url)).toBe('https://api.sandbox-partner.test/v1/bookings');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('authorization');
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('bearer');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'activity_key',
      'approved_price_cents',
      'session_id',
      'slots',
    ]);
    expect(body).not.toHaveProperty('payment');
    expect(body).not.toHaveProperty('card');
  });

  it('treats a non-booked response, a spend field, and a broken body as not booked', async () => {
    const cases = [
      () => Response.json({ status: 'unavailable' }),
      () => Response.json({ status: 'booked', amount_cents: 1800 }),
      () => Response.json({ status: 'booked', payment_intent: 'pi_test' }),
      () => new Response('not-json', { status: 200 }),
      () => new Response('', { status: 503 }),
    ];
    for (const respond of cases) {
      const fetchImpl = vi.fn(async () => respond());
      const client = sandboxPartnershipClient(
        { BOOKING_REFERENCE_CONNECTOR_BASE_URL: 'http://127.0.0.1:9' },
        fetchImpl,
      );
      await expect(client.createBooking(sandboxPartnershipBooking(SAMPLE))).resolves.toEqual({
        booked: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('allows loopback http for a local sandbox and still sends no secret', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'booked' }));
    const client = sandboxPartnershipClient(
      { BOOKING_REFERENCE_CONNECTOR_BASE_URL: 'http://127.0.0.1:4312' },
      fetchImpl,
    );
    await expect(client.createBooking(sandboxPartnershipBooking(SAMPLE))).resolves.toEqual({
      booked: true,
    });
    const [url, init] = posted(fetchImpl);
    expect(String(url)).toBe('http://127.0.0.1:4312/v1/bookings');
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('keeps partner secrets and spend clients out of the connector source', () => {
    const source = readFileSync(fileURLToPath(new URL('./reference.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/sk_live|sk_test|api[_-]?key|authorization|bearer|stripe/i);
    expect(source).not.toContain('STOP');
  });
});

describe('booking connector registry', () => {
  it('ships empty unless the reference flag is exactly on', () => {
    expect(bookingConnectors({})).toEqual([]);
    expect(bookingConnectors({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'true' })).toEqual([]);
    expect(bookingConnectors({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'ON' })).toEqual([]);
    const live = bookingConnectors({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'on' });
    expect(live.map((connector) => connector.id)).toEqual([REFERENCE_CONNECTOR_ID]);
  });

  it('runs the reference connector before the browser and cannot override the denylist', () => {
    const connectors = bookingConnectors({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'on' });
    expect(bookingRoute(`https://${REFERENCE_CONNECTOR_HOST}/lessons`, connectors).kind).toBe(
      'connector',
    );
    expect(bookingRoute('https://tickets.example-zoo.test/book', connectors).kind).toBe('browser');
    expect(bookingRoute('https://www.toronto.ca/recreation', connectors).kind).toBe('handoff');
    expect(bookingRoute('https://app.amilia.com/register', connectors).kind).toBe('handoff');
    expect(bookingRoute('https://recreation.brampton.ca/programs', connectors).kind).toBe(
      'handoff',
    );
    expect(bookingRoute(`https://${REFERENCE_CONNECTOR_HOST}/lessons`, []).kind).toBe('browser');
  });
});
