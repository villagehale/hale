import { describe, expect, it } from 'vitest';
import {
  type OutboundGatePorts,
  PROACTIVE_CAP,
  PROACTIVE_QUIET_HOURS,
  assertProactiveSendAllowed,
} from './outbound-gate.js';

/**
 * VIL-239 · M4 — the F14 outbound chokepoint.
 *
 * Expectations are derived from the gate's contract, not from its implementation:
 *
 *   - the four checks run in a FIXED order, and the first failure is the verdict — a
 *     family that pressed STOP is never counted, never consented-against, never
 *     quiet-hour-checked, because none of that is any of our business once they left;
 *   - "enrolled" is the LIVE channel state, never a consent-ledger read;
 *   - the cap is per FAMILY per rolling 7 days, so a second parent cannot double it;
 *   - quiet hours are the parent's own wall clock, which means the same UTC instant is
 *     quiet in July and not quiet in January.
 */

const FAMILY = 'fam-1';
const PARENT = 'user-1';

interface FakeState {
  enrolled: boolean;
  consented: boolean;
  recentSends: number;
  timeZone: string;
}

function ports(state: Partial<FakeState> = {}): {
  ports: OutboundGatePorts;
  calls: string[];
} {
  const resolved: FakeState = {
    enrolled: true,
    consented: true,
    recentSends: 0,
    timeZone: 'America/Toronto',
    ...state,
  };
  const calls: string[] = [];
  return {
    calls,
    ports: {
      async channelEnrolled() {
        calls.push('enrolled');
        return resolved.enrolled;
      },
      async watchConsentGranted() {
        calls.push('consent');
        return resolved.consented;
      },
      async countProactiveSends() {
        calls.push('cap');
        return resolved.recentSends;
      },
      async parentTimeZone() {
        calls.push('tz');
        return resolved.timeZone;
      },
    },
  };
}

/** A Wednesday, 14:00 in Toronto (EDT) — squarely outside quiet hours. */
const MIDDAY = new Date('2026-07-15T18:00:00.000Z');

function callGate(now: Date, state: Partial<FakeState> = {}) {
  const fake = ports(state);
  return {
    calls: fake.calls,
    verdict: assertProactiveSendAllowed(
      { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now },
      fake.ports,
    ),
  };
}

describe('assertProactiveSendAllowed', () => {
  it('allows a send when every check passes', async () => {
    await expect(callGate(MIDDAY).verdict).resolves.toEqual({ allowed: true });
  });

  it('holds when the parent has no live channel — the STOP gate', async () => {
    await expect(callGate(MIDDAY, { enrolled: false }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'not_enrolled',
    });
  });

  it('holds when proactive_watch was never granted', async () => {
    await expect(callGate(MIDDAY, { consented: false }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'no_watch_consent',
    });
  });

  it('holds at the frequency cap — one proactive nudge per family per rolling 7 days', async () => {
    expect(PROACTIVE_CAP.nudge).toEqual({ max: 1, windowHours: 24 * 7 });
    await expect(callGate(MIDDAY, { recentSends: 1 }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'frequency_cap',
    });
  });

  it('passes the cap window start the count must be taken from', async () => {
    let seen: { since: Date; familyId: string } | null = null;
    const verdict = await assertProactiveSendAllowed(
      { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
      {
        ...ports().ports,
        async countProactiveSends(familyId, _kind, since) {
          seen = { since, familyId };
          return 0;
        },
      },
    );
    expect(verdict).toEqual({ allowed: true });
    expect(seen).not.toBeNull();
    const { since, familyId } = seen as unknown as { since: Date; familyId: string };
    // Per FAMILY (not per parent) — a co-parent must not double the family's budget.
    expect(familyId).toBe(FAMILY);
    expect(MIDDAY.getTime() - since.getTime()).toBe(PROACTIVE_CAP.nudge.windowHours * 3_600_000);
  });

  it('holds inside quiet hours in the parent’s own zone', async () => {
    // 22:00 in Toronto.
    const late = new Date('2026-07-16T02:00:00.000Z');
    await expect(callGate(late).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });

  it('holds before the local morning boundary and allows on it', async () => {
    expect(PROACTIVE_QUIET_HOURS).toEqual({ start: '21:00', end: '08:00' });
    // 07:59 vs 08:00 in Toronto (EDT).
    await expect(callGate(new Date('2026-07-15T11:59:00.000Z')).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
    await expect(callGate(new Date('2026-07-15T12:00:00.000Z')).verdict).resolves.toEqual({
      allowed: true,
    });
  });

  it('reads the wall clock through DST, not a fixed UTC offset', async () => {
    // The SAME UTC time-of-day: 20:30 in January (EST, UTC-5) and 21:30 in July
    // (EDT, UTC-4). A fixed-offset implementation gets one of these wrong.
    await expect(callGate(new Date('2026-01-15T01:30:00.000Z')).verdict).resolves.toEqual({
      allowed: true,
    });
    await expect(callGate(new Date('2026-07-15T01:30:00.000Z')).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });

  it('honours a parent in another zone rather than the server’s', async () => {
    // 22:30 in Toronto is 19:30 in Vancouver — quiet for one parent, fine for the other.
    const evening = new Date('2026-07-16T02:30:00.000Z');
    await expect(callGate(evening, { timeZone: 'America/Vancouver' }).verdict).resolves.toEqual({
      allowed: true,
    });
    await expect(callGate(evening, { timeZone: 'America/Toronto' }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });
});

describe('gate ordering', () => {
  it('runs enrolled → consent → cap → quiet hours', async () => {
    const { calls, verdict } = callGate(MIDDAY);
    await verdict;
    expect(calls).toEqual(['enrolled', 'consent', 'cap', 'tz']);
  });

  it('stops at the first failure — an unenrolled family is never counted or clock-checked', async () => {
    const { calls, verdict } = callGate(MIDDAY, { enrolled: false });
    await verdict;
    expect(calls).toEqual(['enrolled']);
  });

  it('never reaches the cap count for a family that did not consent', async () => {
    const { calls, verdict } = callGate(MIDDAY, { consented: false });
    await verdict;
    expect(calls).toEqual(['enrolled', 'consent']);
  });

  it('never reads the clock for a family already at its cap', async () => {
    const { calls, verdict } = callGate(MIDDAY, { recentSends: 1 });
    await verdict;
    expect(calls).toEqual(['enrolled', 'consent', 'cap']);
  });
});
