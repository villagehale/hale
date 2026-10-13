import { describe, expect, it } from 'vitest';
import { volumeIsUnusual } from './volume';

describe('unusual volume alert', () => {
  it('pages at 12 and does not treat 11 as unusual', () => {
    expect(volumeIsUnusual(11)).toBe(false);
    expect(volumeIsUnusual(12)).toBe(true);
  });
});
