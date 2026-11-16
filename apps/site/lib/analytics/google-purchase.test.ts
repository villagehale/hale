import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_ADS_ID } from './google-ads.js';
import {
  fireGooglePurchaseConversion,
  googlePurchaseStorageKey,
  type GooglePurchaseEvent,
} from './google-purchase.js';

const EVENT: GooglePurchaseEvent = {
  sendTo: 'AW-18412881223/O_6XCJWSnbkdEMeK-ctE',
  value: 79,
  currency: 'CAD',
  transactionId: 'cs_test_1',
};

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

describe('fireGooglePurchaseConversion', () => {
  it('fires gtag conversion once per session id', () => {
    const gtag = vi.fn();
    const storage = memoryStorage();
    expect(fireGooglePurchaseConversion(EVENT, gtag, storage)).toBe('fired');
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', {
      send_to: EVENT.sendTo,
      value: 79,
      currency: 'CAD',
      transaction_id: 'cs_test_1',
    });
    expect(storage.getItem(googlePurchaseStorageKey('cs_test_1'))).toBe('1');
    expect(fireGooglePurchaseConversion(EVENT, gtag, storage)).toBe('already_fired');
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it('does not fire without gtag and does not mark the session', () => {
    const storage = memoryStorage();
    expect(fireGooglePurchaseConversion(EVENT, undefined, storage)).toBe('missing_gtag');
    expect(storage.getItem(googlePurchaseStorageKey('cs_test_1'))).toBeNull();
  });

  it('documents the Website Purchase send_to on the existing Google tag', () => {
    expect(EVENT.sendTo.startsWith(`${GOOGLE_ADS_ID}/`)).toBe(true);
  });
});
