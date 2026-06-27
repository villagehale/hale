import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from './config';

/**
 * The caps are a SILENT guard — invisible to real users, tripped only by bots and
 * runaway loops. This pins them above the realistic-peak envelope documented in
 * config.ts so an edit can't quietly drop a cap to a level a real family would hit.
 * The floors are the envelope reasoning, not the current values, so a future
 * tightening toward a human's peak fails here on purpose.
 */
describe('RATE_LIMITS — generous enough to stay invisible', () => {
  it('keeps the coach caps far above a human burst (~5-10/min)', () => {
    expect(RATE_LIMITS.coach.limit).toBeGreaterThanOrEqual(40);
    expect(RATE_LIMITS['coach-action'].limit).toBeGreaterThanOrEqual(40);
  });

  it('keeps the ingest cap above a real forwarder yet under a flood', () => {
    expect(RATE_LIMITS.ingest.limit).toBeGreaterThanOrEqual(100);
  });

  it('uses a one-minute window for every route', () => {
    for (const opts of Object.values(RATE_LIMITS)) {
      expect(opts.windowSec).toBe(60);
    }
  });
});
