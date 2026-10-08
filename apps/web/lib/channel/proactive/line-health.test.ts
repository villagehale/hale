import { describe, expect, it } from 'vitest';
import { lineStatusPauses } from './line-health';

describe('line status', () => {
  it('pauses on flagged or throttled and not on active', () => {
    expect(lineStatusPauses('flagged')).toBe(true);
    expect(lineStatusPauses('Throttled')).toBe(true);
    expect(lineStatusPauses('active')).toBe(false);
    expect(lineStatusPauses('healthy')).toBe(false);
  });
});
