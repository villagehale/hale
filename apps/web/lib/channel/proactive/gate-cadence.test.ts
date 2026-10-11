import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type OutboundGatePorts,
  PROACTIVE_CAP,
  assertProactiveSendAllowed,
} from '../outbound-gate';

/**
 * VIL-226 · what the cadence flag changes at the gate. Live reads the counters as
 * context, not a hold. Shadow and live start quiet hours at 20:00 for a Florida or
 * Oklahoma number. Unset changes nothing, and reads no phone.
 */

const FAMILY = 'fam-1';
const PARENT = 'user-1';
const TZ = 'America/New_York';
/** Thursday 12:00 local, outside every quiet window. */
const MIDDAY = new Date('2026-10-08T16:00:00.000Z');
/** Thursday 20:30 local: quiet for a Florida number, not for anyone else. */
const EVENING = new Date('2026-10-09T00:30:00.000Z');
const FLORIDA = '+14075550100';
const ELSEWHERE = '+12065550100';

afterEach(() => {
  vi.unstubAllEnvs();
});

function ports(over: Partial<OutboundGatePorts> = {}): OutboundGatePorts & { phoneReads: number } {
  const state = { phoneReads: 0 };
  const base: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 100,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => TZ,
    ...over,
  };
  const phone = over.parentPhone;
  return Object.assign(state, base, {
    parentPhone: phone
      ? async (id: string) => {
          state.phoneReads += 1;
          return phone(id);
        }
      : undefined,
  });
}

const nudge = (now: Date) => ({
  familyId: FAMILY,
  parentUserId: PARENT,
  kind: 'nudge' as const,
  now,
});

describe('the numeric cap under the cadence flag', () => {
  it('holds the weekly nudge cap while the flag is unset', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(PROACTIVE_CAP.nudge).toEqual({ max: 1, windowHours: 24 * 7 });
    await expect(assertProactiveSendAllowed(nudge(MIDDAY), ports())).resolves.toEqual({
      allowed: false,
      reason: 'frequency_cap',
    });
  });

  it('still holds it in shadow', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await expect(assertProactiveSendAllowed(nudge(MIDDAY), ports())).resolves.toEqual({
      allowed: false,
      reason: 'frequency_cap',
    });
  });

  it('lets a nudge past the old cap when live, and keeps consent', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await expect(assertProactiveSendAllowed(nudge(MIDDAY), ports())).resolves.toEqual({
      allowed: true,
      optOut: 'short',
    });
    await expect(
      assertProactiveSendAllowed(nudge(MIDDAY), ports({ watchConsentGranted: async () => false })),
    ).resolves.toEqual({ allowed: false, reason: 'no_watch_consent' });
  });

  it('keeps the cap when live for a kind the decider does not see yet', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await expect(
      assertProactiveSendAllowed({ ...nudge(MIDDAY), kind: 'email_alert' }, ports()),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
    await expect(
      assertProactiveSendAllowed({ ...nudge(MIDDAY), kind: 'evening_check_in' }, ports()),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
  });
});

describe('the Florida and Oklahoma quiet start', () => {
  const uncapped = { countProactiveSends: async () => 0 };

  it('starts at 20:00 for a Florida number when the flag is armed', async () => {
    for (const mode of ['shadow', 'live']) {
      vi.stubEnv('PROACTIVE_CADENCE', mode);
      await expect(
        assertProactiveSendAllowed(
          nudge(EVENING),
          ports({ ...uncapped, parentPhone: async () => FLORIDA }),
        ),
      ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
      await expect(
        assertProactiveSendAllowed(
          nudge(EVENING),
          ports({ ...uncapped, parentPhone: async () => ELSEWHERE }),
        ),
      ).resolves.toEqual({ allowed: true, optOut: 'short' });
    }
  });

  it('reads no phone and keeps 21:00 while the flag is unset', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    const gate = ports({ ...uncapped, parentPhone: async () => FLORIDA });
    await expect(assertProactiveSendAllowed(nudge(EVENING), gate)).resolves.toEqual({
      allowed: true,
      optOut: 'short',
    });
    expect(gate.phoneReads).toBe(0);
  });
});
