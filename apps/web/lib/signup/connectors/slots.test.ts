import { describe, expect, it } from 'vitest';
import { SHAREABLE_SIGNUP_FIELDS } from '../consent';
import { connectorBookingSlots } from './slots';

const IDENTITY = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2023-09-29',
  parentFirstName: 'Test Parent',
  parentEmail: 'parent@example.test',
  postalCode: 'M5V2T6',
  teenager: false,
};

const SESSION = {
  id: 'tue-1630',
  startsAt: '2026-10-06T20:30:00.000Z',
  partySize: 2,
  seatingNote: 'Window',
};

describe('connectorBookingSlots', () => {
  it('returns only granted shareable slots and omits the family record', () => {
    const result = connectorBookingSlots({
      identity: IDENTITY,
      session: SESSION,
      fieldsAllowed: ['child_first_name', 'session', 'visit_date', 'postal_code'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toEqual([
      { slot: 'child_first_name', value: 'Ada' },
      { slot: 'session', value: 'tue-1630' },
      { slot: 'visit_date', value: '2026-10-06' },
      { slot: 'postal_code', value: 'M5V2T6' },
    ]);
    expect(JSON.stringify(result.slots)).not.toContain('Lovelace');
    expect(JSON.stringify(result.slots)).not.toContain('teenager');
    expect(JSON.stringify(result.slots)).not.toContain('parent@');
    for (const slot of result.slots) {
      expect(SHAREABLE_SIGNUP_FIELDS).toContain(slot.slot);
    }
  });

  it('drops an unknown slot name and a blank value', () => {
    const result = connectorBookingSlots({
      identity: { ...IDENTITY, childLastName: '  ' },
      session: { ...SESSION, partySize: null, seatingNote: null },
      fieldsAllowed: ['child_last_name', 'phone', 'party_size', 'session'],
    });
    expect(result).toEqual({ ok: true, slots: [{ slot: 'session', value: 'tue-1630' }] });
  });

  it('stops before a call when a granted seating note is health or allergy content', () => {
    const allergy = connectorBookingSlots({
      identity: IDENTITY,
      session: { ...SESSION, seatingNote: 'peanut allergy' },
      fieldsAllowed: ['seating_note', 'session'],
    });
    expect(allergy).toEqual({ ok: false, reason: 'allergy' });
    const medical = connectorBookingSlots({
      identity: IDENTITY,
      session: { ...SESSION, seatingNote: 'needs medication' },
      fieldsAllowed: ['seating_note'],
    });
    expect(medical).toEqual({ ok: false, reason: 'medical' });
  });

  it('does not send a seating note the grant left out', () => {
    const result = connectorBookingSlots({
      identity: IDENTITY,
      session: { ...SESSION, seatingNote: 'peanut allergy' },
      fieldsAllowed: ['session'],
    });
    expect(result).toEqual({ ok: true, slots: [{ slot: 'session', value: 'tue-1630' }] });
  });
});
