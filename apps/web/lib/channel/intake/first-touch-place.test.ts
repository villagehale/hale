import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { placeFromGivenFields, placeFromMessage } from './first-touch-place';

it('keeps the onboarding coverage instruction consistent with US ZIP admission', () => {
  const skill = readFileSync(
    new URL('../../../../../packages/agent/skills/onboarding-friend.md', import.meta.url),
    'utf8',
  );
  expect(skill).toContain('Canadian postal code or US ZIP');
  expect(skill).toContain('Hale covers the US and Canada');
  expect(skill).not.toContain('Hale covers the GTA');
});

it('accepts a model-extracted US ZIP without inventing an Ontario municipality', () => {
  expect(placeFromGivenFields({ postalCode: '05401', city: null })).toMatchObject({
    country: 'United States',
    postalCode: '05401',
    areaCoarse: '054',
    municipality: null,
  });
});

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

  it('accepts a city as the whole message, including the ambiguous names', () => {
    expect(placeFromMessage('Toronto')).toMatchObject({
      kind: 'city',
      municipality: 'toronto',
      city: 'Toronto',
    });
    expect(placeFromMessage('Sharon')).toMatchObject({
      kind: 'city',
      municipality: 'east_gwillimbury',
    });
    expect(placeFromMessage('York')).toMatchObject({ kind: 'city', municipality: 'toronto' });
    expect(placeFromMessage('King')).toMatchObject({ kind: 'city', municipality: 'king' });
  });

  it('does not treat those ambiguous names as a place when they sit inside a sentence', () => {
    expect(placeFromMessage('Sharon is 4')).toBeNull();
    expect(placeFromMessage('we live in York')).toBeNull();
    expect(placeFromMessage('King is coming')).toBeNull();
    expect(placeFromMessage('north york please')).toMatchObject({
      kind: 'city',
      municipality: 'toronto',
    });
  });
});
