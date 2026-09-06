import { describe, expect, it } from 'vitest';
import {
  freshnessTone,
  minutesAgo,
  serviceStateLine,
  STALE_POLL_MINUTES,
} from './panel-state';

describe('serviceStateLine', () => {
  it('names the missing env var for a not_configured outcome', () => {
    expect(
      serviceStateLine('PostHog', {
        ok: false,
        status: 'not_configured',
        detail: 'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set',
      }),
    ).toBe('POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set.');
  });

  it('says the provider did not answer, keeping the link promise', () => {
    const line = serviceStateLine('Twilio', {
      ok: false,
      status: 'unreachable',
      detail: 'Twilio answered 503',
    });
    expect(line).toContain('Twilio didn’t answer');
    expect(line).toContain('link below still works');
  });
});

describe('minutesAgo', () => {
  it('floors the gap to whole minutes rather than rounding it up', () => {
    expect(minutesAgo('2026-09-04T14:00:00Z', new Date('2026-09-04T14:31:45.000Z'))).toBe(31);
  });

  it('reads a stamp from the future as 0, never as a negative age', () => {
    expect(minutesAgo('2026-09-04T14:00:30Z', new Date('2026-09-04T14:00:00.000Z'))).toBe(0);
  });

  it('crosses the stale threshold only past it (positive control at the boundary)', () => {
    const polled = '2026-09-04T14:00:00Z';
    expect(minutesAgo(polled, new Date('2026-09-04T14:30:00.000Z'))).toBe(STALE_POLL_MINUTES);
    expect(minutesAgo(polled, new Date('2026-09-04T14:31:00.000Z'))).toBeGreaterThan(
      STALE_POLL_MINUTES,
    );
  });
});

describe('freshnessTone', () => {
  it('reads an absent age as never rather than as a fresh zero', () => {
    expect(freshnessTone(null, STALE_POLL_MINUTES)).toBe('never');
  });

  it('holds fresh exactly AT the threshold and turns stale only past it', () => {
    expect(freshnessTone(STALE_POLL_MINUTES, STALE_POLL_MINUTES)).toBe('fresh');
    expect(freshnessTone(STALE_POLL_MINUTES + 1, STALE_POLL_MINUTES)).toBe('stale');
  });
});
