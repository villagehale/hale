import { describe, expect, it } from 'vitest';
import { lineStatusKnown, lineStatusPauses } from './line-health';

describe('line status', () => {
  it('pauses on flagged or throttled and not on active', () => {
    expect(lineStatusPauses('flagged')).toBe(true);
    expect(lineStatusPauses('Throttled')).toBe(true);
    expect(lineStatusPauses('suspended')).toBe(true);
    expect(lineStatusPauses('active')).toBe(false);
    expect(lineStatusPauses('healthy')).toBe(false);
  });
  it('fails closed on a status word it does not know', () => {
    expect(lineStatusPauses('blocked')).toBe(true);
    expect(lineStatusPauses('review_pending')).toBe(true);
    expect(lineStatusPauses('')).toBe(true);
    expect(lineStatusKnown('blocked')).toBe(false);
    expect(lineStatusKnown('active')).toBe(true);
    expect(lineStatusKnown('flagged')).toBe(true);
  });
});
