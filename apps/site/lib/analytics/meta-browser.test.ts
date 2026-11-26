import { describe, expect, it, vi } from 'vitest';
import { openDirectCheckout } from '~/lib/billing/checkout-client';
import {
  fireMetaInitiateCheckout,
  fireMetaLead,
  metaInitiateStorageKey,
  metaLeadEventId,
  storedMetaLeadId,
} from './meta-browser';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = { ...seed };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    clear: () => {
      for (const key of Object.keys(data)) delete data[key];
    },
    key: () => null,
    get length() {
      return Object.keys(data).length;
    },
  } as Storage;
}

describe('InitiateCheckout pixel', () => {
  it('fires once per Checkout Session id, which is the eventID', () => {
    const fbq = vi.fn();
    const storage = memoryStorage();
    const event = { eventId: 'cs_test_checkout', value: 59, currency: 'CAD' };
    expect(fireMetaInitiateCheckout(event, fbq, storage)).toBe('fired');
    expect(fbq).toHaveBeenCalledWith(
      'track',
      'InitiateCheckout',
      { value: 59, currency: 'CAD' },
      { eventID: 'cs_test_checkout' },
    );
    expect(storage.getItem(metaInitiateStorageKey('cs_test_checkout'))).toBe('1');
    expect(fireMetaInitiateCheckout({ ...event, currency: 'USD', value: 39 }, fbq, storage)).toBe(
      'already_fired',
    );
    expect(fbq).toHaveBeenCalledTimes(1);
  });

  it('does not fire without the pixel or for a non-CAD/USD currency', () => {
    const storage = memoryStorage();
    expect(
      fireMetaInitiateCheckout(
        { eventId: 'cs_test_checkout', value: 59, currency: 'CAD' },
        undefined,
        storage,
      ),
    ).toBe('missing_fbq');
    expect(
      fireMetaInitiateCheckout(
        { eventId: 'cs_test_checkout', value: 59, currency: 'EUR' },
        vi.fn(),
        storage,
      ),
    ).toBe('refused');
    expect(storage.getItem(metaInitiateStorageKey('cs_test_checkout'))).toBeNull();
  });
});

describe('Lead pixel', () => {
  it('fires one Lead per tab and keeps that event id for CAPI', () => {
    const fbq = vi.fn();
    const storage = memoryStorage();
    const eventId = metaLeadEventId();
    expect(fireMetaLead(fbq, storage, eventId)).toBe('fired');
    expect(fbq).toHaveBeenCalledWith('track', 'Lead', {}, { eventID: eventId });
    expect(storedMetaLeadId(storage)).toBe(eventId);
    expect(fireMetaLead(fbq, storage, metaLeadEventId())).toBe('already_fired');
    expect(fbq).toHaveBeenCalledTimes(1);
  });
});

describe('openDirectCheckout', () => {
  it('fires InitiateCheckout with the session id, then opens Stripe', async () => {
    const fbq = vi.fn();
    const storage = memoryStorage();
    const assigned: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          url: 'https://checkout.stripe.com/c/pay/cs_test_json',
          sessionId: 'cs_test_json',
          value: 39,
          currency: 'USD',
        }),
        { status: 200 },
      );
    });
    await openDirectCheckout({
      href: '/api/checkout?tier=plus',
      fbq,
      storage,
      fetchImpl,
      assign: (url) => assigned.push(url),
    });
    expect(fbq).toHaveBeenCalledWith(
      'track',
      'InitiateCheckout',
      { value: 39, currency: 'USD' },
      { eventID: 'cs_test_json' },
    );
    expect(assigned).toEqual(['https://checkout.stripe.com/c/pay/cs_test_json']);
    await openDirectCheckout({
      href: '/api/checkout?tier=plus',
      fbq,
      storage,
      fetchImpl,
      assign: (url) => assigned.push(url),
    });
    expect(fbq).toHaveBeenCalledTimes(1);
  });
});
