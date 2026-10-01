import { describe, expect, it } from 'vitest';
import { referenceConnectorEnabled } from './flag';

describe('referenceConnectorEnabled', () => {
  it('is on only for the exact string on', () => {
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'on' })).toBe(true);
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'on\n' })).toBe(true);
  });

  it('stays off for every other value, including unset', () => {
    expect(referenceConnectorEnabled({})).toBe(false);
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: '' })).toBe(false);
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'true' })).toBe(false);
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'ON' })).toBe(false);
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: '1' })).toBe(false);
    expect(referenceConnectorEnabled({ BOOKING_REFERENCE_CONNECTOR_ENABLED: 'off' })).toBe(false);
  });
});
