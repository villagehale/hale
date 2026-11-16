import { describe, expect, it, vi } from 'vitest';
import {
  fireMetaPurchaseConversion,
  metaPurchaseStorageKey,
  type MetaPurchaseEvent,
} from './meta-purchase.js';

const EVENT: MetaPurchaseEvent = {
  pixelId: '1460101092968766',
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

describe('fireMetaPurchaseConversion', () => {
  it('fires fbq Purchase once per Checkout Session id with that id as eventID', () => {
    const fbq = vi.fn();
    const storage = memoryStorage();
    expect(fireMetaPurchaseConversion(EVENT, fbq, storage)).toBe('fired');
    expect(fbq).toHaveBeenCalledWith(
      'track',
      'Purchase',
      { value: 79, currency: 'CAD' },
      { eventID: 'cs_test_1' },
    );
    expect(storage.getItem(metaPurchaseStorageKey('cs_test_1'))).toBe('1');
    expect(fireMetaPurchaseConversion(EVENT, fbq, storage)).toBe('already_fired');
    expect(fbq).toHaveBeenCalledTimes(1);
  });

  it('does not fire without fbq', () => {
    const storage = memoryStorage();
    expect(fireMetaPurchaseConversion(EVENT, undefined, storage)).toBe('missing_fbq');
    expect(storage.getItem(metaPurchaseStorageKey('cs_test_1'))).toBeNull();
  });
});
