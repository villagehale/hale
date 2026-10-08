import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type OutboundGatePorts,
  PROACTIVE_CAP,
  assertProactiveSendAllowed,
  holdStatus,
} from '../outbound-gate';

/**
 * VIL-226 · live cadence skips the numeric counters and holds a paused line.
 * Off keeps the cap. Quiet hours, including the Florida 20:00 floor, stay.
 */

const FAMILY = 'fam-1';
const PARENT = 'user-1';

afterEach(() => {
  vi.unstubAllEnvs();
});

function ports(over: Partial<OutboundGatePorts> = {}): OutboundGatePorts {
  return {
    async channelEnrolled() {
      return true;
    },
    async watchConsentGranted() {
      return true;
    },
    async countProactiveSends() {
      return 100;
    },
    async proactiveSentSince() {
      return true;
    },
    async parentTimeZone() {
      return 'America/Toronto';
    },
    ...over,
  };
}

/** Thursday 12:00 EDT, outside both quiet windows. */
const MIDDAY = new Date('2026-10-08T16:00:00.000Z');
/** Friday 20:30 EDT. Quiet for a Florida number, not for Toronto. */
const EVENING = new Date('2026-10-09T00:30:00.000Z');

describe('proactive cadence live', () => {
  it('keeps the weekly nudge cap while the flag is off', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(PROACTIVE_CAP.nudge).toEqual({ max: 1, windowHours: 24 * 7 });
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
        ports(),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
  });

  it('allows a nudge past the old cap when cadence is live', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
        ports(),
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'short' });
  });

  it('still caps in shadow', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
        ports(),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
  });

  it('holds a paused line, and lets a requested time-critical item through', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const paused = ports({
      async linePaused() {
        return true;
      },
      async countProactiveSends() {
        return 0;
      },
    });
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
        paused,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'line_health' });
    expect(holdStatus('line_health')).toBe('suppressed_pref');
    await expect(
      assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'registration_sequence',
          now: MIDDAY,
          urgent: true,
        },
        paused,
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('starts quiet hours at 20:00 for a Florida number and 21:00 otherwise', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: EVENING },
        ports({
          async countProactiveSends() {
            return 0;
          },
          async parentPhone() {
            return '+14075550100';
          },
        }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: EVENING },
        ports({
          async countProactiveSends() {
            return 0;
          },
          async parentPhone() {
            return '+14165550100';
          },
        }),
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'short' });
  });
});
