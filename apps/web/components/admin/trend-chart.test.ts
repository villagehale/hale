import { describe, expect, it } from 'vitest';
import { failureRate } from './trend-chart';

/** Delivery health: rate days are honest — no sends means a GAP, not a 0%. */
describe('failureRate', () => {
  it('is null (a chart gap) when nothing went out', () => {
    expect(failureRate({ msgsOut: 0, msgsFailed: 0 })).toBeNull();
  });

  it('is the failed share in %, one decimal', () => {
    expect(failureRate({ msgsOut: 3, msgsFailed: 1 })).toBe(33.3);
    expect(failureRate({ msgsOut: 200, msgsFailed: 1 })).toBe(0.5);
    expect(failureRate({ msgsOut: 5, msgsFailed: 0 })).toBe(0);
  });
});
