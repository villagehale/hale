import { describe, expect, it } from 'vitest';
import type { SignupSession } from '../types';
import { normalizeSession } from './details';

const SESSION: SignupSession = {
  id: 'fri-1900',
  label: 'Fri 7:00',
  startsAt: '2026-10-09T23:00:00.000Z',
  endsAt: '2026-10-10T00:30:00.000Z',
  full: false,
  priceCents: null,
};

describe('normalizeSession', () => {
  it('keeps a party size and a short seating note', () => {
    expect(normalizeSession({ ...SESSION, partySize: 4, seatingNote: '  Window ' })).toMatchObject({
      partySize: 4,
      seatingNote: 'Window',
    });
  });

  it('rejects a headcount, a health note, and a contact note', () => {
    expect(normalizeSession({ ...SESSION, partySize: 0 })).toBeNull();
    expect(normalizeSession({ ...SESSION, partySize: 21 })).toBeNull();
    expect(normalizeSession({ ...SESSION, seatingNote: 'peanut allergy' })).toBeNull();
    expect(normalizeSession({ ...SESSION, seatingNote: 'ana@example.test' })).toBeNull();
  });
});
