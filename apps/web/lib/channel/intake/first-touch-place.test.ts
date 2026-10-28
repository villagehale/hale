import { describe, expect, it } from 'vitest';
import { placeFromMessage } from './first-touch-place';

describe('placeFromMessage', () => {
  it('reads a postal code out of a sentence and does not ask the phone', () => {
    const place = placeFromMessage("We're in M5V 2T6");
    expect(place).toMatchObject({
      kind: 'postal',
      areaCoarse: 'M5V',
      postalCode: 'M5V 2T6',
      municipality: 'toronto',
    });
    expect(placeFromMessage('M5V')).toMatchObject({ kind: 'postal', areaCoarse: 'M5V' });
    expect(placeFromMessage('+14165551234')).toBeNull();
    expect(placeFromMessage('416')).toBeNull();
  });

  it('reads a US ZIP and does not treat a city name as a place', () => {
    expect(placeFromMessage('we are in 10001')).toMatchObject({
      kind: 'postal',
      areaCoarse: '100',
      postalCode: '10001',
    });
    expect(placeFromMessage('90210')).toMatchObject({
      kind: 'postal',
      postalCode: '90210',
      areaCoarse: '902',
    });
    expect(placeFromMessage('Toronto')).toBeNull();
    expect(placeFromMessage('Chicago')).toBeNull();
    expect(placeFromMessage('north york please')).toBeNull();
    expect(placeFromMessage('SW1A 1AA')).toBeNull();
  });
});
