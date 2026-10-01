import { describe, expect, it } from 'vitest';
import { mapDeliveryStatus, overwritableFrom } from '~/lib/channel/delivery-status';

/**
 * The delivery-callback DECISION, tested as the pure function it is. Callbacks arrive
 * out of order (Twilio makes no ordering guarantee across HTTP requests), so "which
 * ledger states may this callback overwrite" is the whole correctness question — a
 * late `sent` must not un-deliver a message that is already delivered.
 */

describe('mapDeliveryStatus', () => {
  it('maps the pre-send lifecycle to queued', () => {
    for (const raw of ['accepted', 'scheduled', 'queued', 'sending']) {
      expect(mapDeliveryStatus(raw)).toBe('queued');
    }
  });

  it('maps handoff-to-carrier to sent', () => {
    expect(mapDeliveryStatus('sent')).toBe('sent');
  });

  it('maps carrier confirmation (and read receipts) to delivered', () => {
    expect(mapDeliveryStatus('delivered')).toBe('delivered');
    expect(mapDeliveryStatus('read')).toBe('delivered');
  });

  it('maps both failure terminals to failed', () => {
    expect(mapDeliveryStatus('undelivered')).toBe('failed');
    expect(mapDeliveryStatus('failed')).toBe('failed');
  });

  it('is case-insensitive on the provider value', () => {
    expect(mapDeliveryStatus('Delivered')).toBe('delivered');
  });

  it('returns null for inbound-only and unknown statuses rather than guessing', () => {
    for (const raw of ['receiving', 'received', 'partially_delivered', '', 'nonsense']) {
      expect(mapDeliveryStatus(raw)).toBeNull();
    }
  });
});

describe('overwritableFrom', () => {
  it('lets delivered overwrite only the earlier states', () => {
    expect(overwritableFrom('delivered')).toEqual(['queued', 'sent']);
  });

  it('lets sent overwrite only queued — never a delivered row', () => {
    expect(overwritableFrom('sent')).toEqual(['queued']);
    expect(overwritableFrom('sent')).not.toContain('delivered');
  });

  it('lets failed overwrite every non-terminal state, including delivered', () => {
    // A late failure is the more actionable truth than a stale success, and Twilio
    // does report undelivered after an optimistic delivered on some carriers.
    expect(overwritableFrom('failed')).toEqual(['queued', 'sent', 'delivered']);
  });

  it('never lets queued overwrite anything — a late pre-send callback is a no-op', () => {
    expect(overwritableFrom('queued')).toEqual([]);
  });

  it('never overwrites a suppression, which never reached a provider at all', () => {
    for (const next of ['queued', 'sent', 'delivered', 'failed'] as const) {
      const from = overwritableFrom(next);
      expect(from).not.toContain('suppressed_consent');
      expect(from).not.toContain('suppressed_quiet_hours');
      expect(from).not.toContain('suppressed_cap');
      expect(from).not.toContain('suppressed_pref');
    }
  });
});

