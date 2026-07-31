import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_LEAD_HOURS,
  CHECK_IN_REPLY_WINDOW_HOURS,
  type SequenceState,
  awaitingOutcome,
  dueLeg,
  legIsUrgent,
  openLegWindows,
  waitlistDeadline,
  waitlistLegWindows,
} from './schedule.js';

/**
 * VIL-242 · M7 — the sequence scheduler's contract.
 *
 * Expectations are derived from the product rule, not from the implementation:
 *
 *   - every leg is an INTERVAL, so a missed tick self-heals and a quiet-hours hold
 *     simply retries later instead of dropping the leg forever;
 *   - the intervals are contiguous and disjoint, so two legs can never be due at once;
 *   - the "go" leg NEVER fires after the registration opens — a "here's your link,
 *     it opens at 6:30" text at 6:31 is a lie;
 *   - the local slots are wall-clock, so a window seven days out across a DST change
 *     still lands at 10:00 in the family's own morning;
 *   - opt-in gates the battle plan and the go: the heads-up is the same news M4 would
 *     have sent, the rest presume the parent said yes to this window.
 */

const TZ = 'America/Toronto';

/** Tuesday 15 Sept 2026, 06:30 America/Toronto (EDT, UTC-4). */
const OPEN_AT = new Date('2026-09-15T10:30:00.000Z');

function state(overrides: Partial<SequenceState> = {}): SequenceState {
  return {
    openAt: OPEN_AT,
    timeZone: TZ,
    optIn: 'opted_in',
    outcome: null,
    waitlistStartedAt: null,
    waitlistResponseHours: null,
    ...overrides,
  };
}

/** The local wall-clock rendering of an instant, for readable expectations. */
function local(instant: Date, timeZone = TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

describe('openLegWindows', () => {
  it('anchors the heads-up seven days out at 10:00 in the family morning', () => {
    const windows = openLegWindows(OPEN_AT, TZ);
    expect(local(windows.heads_up.from)).toBe('2026-09-08, 10:00');
  });

  it('anchors the battle plan at 19:00 the evening before the open', () => {
    const windows = openLegWindows(OPEN_AT, TZ);
    expect(local(windows.battle_plan.from)).toBe('2026-09-14, 19:00');
  });

  it('anchors the go leg exactly fifteen minutes before the open', () => {
    const windows = openLegWindows(OPEN_AT, TZ);
    expect(windows.go.from.toISOString()).toBe('2026-09-15T10:15:00.000Z');
    // It expires AT the open: a "opens in a moment" text after the fact is a lie.
    expect(windows.go.until.getTime()).toBe(OPEN_AT.getTime());
  });

  it('opens the check-in four hours after the open and closes it three days later', () => {
    const windows = openLegWindows(OPEN_AT, TZ);
    expect(windows.check_in.from.getTime()).toBe(
      OPEN_AT.getTime() + CHECK_IN_LEAD_HOURS * 3_600_000,
    );
    expect(windows.check_in.until.getTime()).toBe(
      OPEN_AT.getTime() + (CHECK_IN_LEAD_HOURS + CHECK_IN_REPLY_WINDOW_HOURS) * 3_600_000,
    );
  });

  it('leaves no gap and no overlap between the three pre-open legs', () => {
    const windows = openLegWindows(OPEN_AT, TZ);
    expect(windows.heads_up.until.getTime()).toBe(windows.battle_plan.from.getTime());
    expect(windows.battle_plan.until.getTime()).toBe(windows.go.from.getTime());
    expect(windows.heads_up.from.getTime()).toBeLessThan(windows.battle_plan.from.getTime());
  });

  it('holds the 10:00 local slot across the autumn DST change, not a fixed offset', () => {
    // Thursday 5 Nov 2026, 06:30 EST. Seven days earlier is 29 Oct, still EDT — a
    // naive `openAt - 7 * 86_400_000` lands at 09:00 local, an hour early.
    const novemberOpen = new Date('2026-11-05T11:30:00.000Z');
    const windows = openLegWindows(novemberOpen, TZ);
    expect(local(windows.heads_up.from)).toBe('2026-10-29, 10:00');
    expect(windows.heads_up.from.toISOString()).toBe('2026-10-29T14:00:00.000Z');
  });

  it('holds the 19:00 local slot on the DST transition day itself', () => {
    // Monday 2 Nov 2026, 06:30 EST. The evening before IS the changeover day
    // (1 Nov 2026, 02:00 EDT → 01:00 EST), so 19:00 local is EST, not EDT.
    const novemberOpen = new Date('2026-11-02T11:30:00.000Z');
    const windows = openLegWindows(novemberOpen, TZ);
    expect(local(windows.battle_plan.from)).toBe('2026-11-01, 19:00');
    expect(windows.battle_plan.from.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('reads the slots in the FAMILY zone, not the server zone', () => {
    const windows = openLegWindows(OPEN_AT, 'America/Vancouver');
    expect(local(windows.heads_up.from, 'America/Vancouver')).toBe('2026-09-08, 10:00');
  });
});

describe('dueLeg', () => {
  it('is silent before the heads-up slot opens', () => {
    expect(dueLeg(state(), new Date('2026-09-08T13:59:00.000Z'))).toBeNull();
  });

  it('fires the heads-up inside its interval', () => {
    expect(dueLeg(state(), new Date('2026-09-08T14:00:00.000Z'))).toBe('heads_up');
  });

  it('still fires the heads-up on a later tick — a missed slot self-heals', () => {
    // Three days out: the family was matched late, or a tick was dropped. The news
    // is still worth having, so the interval has not closed.
    expect(dueLeg(state(), new Date('2026-09-12T14:00:00.000Z'))).toBe('heads_up');
  });

  it('fires the heads-up for a family that has NOT yet approved the shortlist', () => {
    expect(dueLeg(state({ optIn: 'pending' }), new Date('2026-09-08T14:00:00.000Z'))).toBe(
      'heads_up',
    );
  });

  it('says nothing at all once the parent declined the shortlist', () => {
    for (const at of ['2026-09-08T14:00:00.000Z', '2026-09-14T23:00:00.000Z']) {
      expect(dueLeg(state({ optIn: 'declined' }), new Date(at))).toBeNull();
    }
  });

  it('withholds the battle plan and the go from a family that never approved', () => {
    expect(dueLeg(state({ optIn: 'pending' }), new Date('2026-09-14T23:00:00.000Z'))).toBeNull();
    expect(dueLeg(state({ optIn: 'pending' }), new Date('2026-09-15T10:20:00.000Z'))).toBeNull();
  });

  it('fires the battle plan the evening before for an opted-in family', () => {
    expect(dueLeg(state(), new Date('2026-09-14T23:00:00.000Z'))).toBe('battle_plan');
  });

  it('fires the go inside the final fifteen minutes', () => {
    expect(dueLeg(state(), new Date('2026-09-15T10:15:00.000Z'))).toBe('go');
    expect(dueLeg(state(), new Date('2026-09-15T10:29:00.000Z'))).toBe('go');
  });

  it('never fires the go once registration has opened', () => {
    expect(dueLeg(state(), OPEN_AT)).toBeNull();
    expect(dueLeg(state(), new Date('2026-09-15T10:31:00.000Z'))).toBeNull();
  });

  it('fires the check-in four hours after the open and stops after three days', () => {
    expect(dueLeg(state(), new Date('2026-09-15T14:30:00.000Z'))).toBe('check_in');
    expect(dueLeg(state(), new Date('2026-09-18T14:29:00.000Z'))).toBe('check_in');
    expect(dueLeg(state(), new Date('2026-09-18T14:31:00.000Z'))).toBeNull();
  });

  it('stops asking once an outcome is on file', () => {
    expect(
      dueLeg(state({ outcome: 'registered' }), new Date('2026-09-15T14:30:00.000Z')),
    ).toBeNull();
    expect(dueLeg(state({ outcome: 'missed' }), new Date('2026-09-15T14:30:00.000Z'))).toBeNull();
  });
});

describe('waitlist clock', () => {
  /** The parent texted "waitlisted #15" at 11:00 local on the open day. */
  const REPLY_AT = new Date('2026-09-15T15:00:00.000Z');

  it('expires a Toronto offer 36 hours after the parent reported it', () => {
    expect(waitlistDeadline(REPLY_AT, 36)?.toISOString()).toBe('2026-09-17T03:00:00.000Z');
  });

  it('expires a Markham offer 48 hours after the parent reported it', () => {
    expect(waitlistDeadline(REPLY_AT, 48)?.toISOString()).toBe('2026-09-17T15:00:00.000Z');
  });

  it('has no clock at all where the municipality publishes no response window', () => {
    expect(waitlistDeadline(REPLY_AT, null)).toBeNull();
  });

  it('guards at half-life and two hours before expiry — 36h municipality', () => {
    const windows = waitlistLegWindows(REPLY_AT, 36);
    expect(windows?.waitlist_half?.from.toISOString()).toBe('2026-09-16T09:00:00.000Z');
    expect(windows?.waitlist_final.from.toISOString()).toBe('2026-09-17T01:00:00.000Z');
    // Neither guard may outlive the deadline it is guarding.
    expect(windows?.waitlist_final.until.toISOString()).toBe('2026-09-17T03:00:00.000Z');
    expect(windows?.waitlist_half?.until.getTime()).toBe(windows?.waitlist_final.from.getTime());
  });

  it('guards at half-life and two hours before expiry — 48h municipality', () => {
    const windows = waitlistLegWindows(REPLY_AT, 48);
    expect(windows?.waitlist_half?.from.toISOString()).toBe('2026-09-16T15:00:00.000Z');
    expect(windows?.waitlist_final.from.toISOString()).toBe('2026-09-17T13:00:00.000Z');
  });

  it('drops the half-life guard when it would land after the final one', () => {
    // A 3-hour response window: half-life is 1h30m, the final guard is at 1h. Two
    // reminders inside three hours is nagging, and the ORDER would be wrong.
    const windows = waitlistLegWindows(REPLY_AT, 3);
    expect(windows?.waitlist_half).toBeNull();
    expect(windows?.waitlist_final.from.toISOString()).toBe('2026-09-15T16:00:00.000Z');
  });

  it('has no guards without a published response window', () => {
    expect(waitlistLegWindows(REPLY_AT, null)).toBeNull();
  });

  it('fires each guard inside its interval and nothing outside them', () => {
    const waitlisted = state({
      outcome: 'waitlisted',
      waitlistStartedAt: REPLY_AT,
      waitlistResponseHours: 36,
    });
    expect(dueLeg(waitlisted, new Date('2026-09-15T20:00:00.000Z'))).toBeNull();
    expect(dueLeg(waitlisted, new Date('2026-09-16T09:00:00.000Z'))).toBe('waitlist_half');
    expect(dueLeg(waitlisted, new Date('2026-09-17T01:00:00.000Z'))).toBe('waitlist_final');
    // Past the deadline there is nothing left to guard.
    expect(dueLeg(waitlisted, new Date('2026-09-17T03:00:00.000Z'))).toBeNull();
  });

  it('never asks a waitlisted family the check-in question again', () => {
    const waitlisted = state({
      outcome: 'waitlisted',
      waitlistStartedAt: REPLY_AT,
      waitlistResponseHours: null,
    });
    expect(dueLeg(waitlisted, new Date('2026-09-15T14:30:00.000Z'))).toBeNull();
  });
});

describe('legIsUrgent', () => {
  it('marks only the battle plan and the go as urgent', () => {
    expect(legIsUrgent('battle_plan')).toBe(true);
    expect(legIsUrgent('go')).toBe(true);
    expect(legIsUrgent('heads_up')).toBe(false);
    expect(legIsUrgent('check_in')).toBe(false);
    // A waitlist guard defers out of quiet hours: it has hours of slack by design,
    // and a 4 a.m. "your waitlist expires" is the annoyance this engine avoids.
    expect(legIsUrgent('waitlist_half')).toBe(false);
    expect(legIsUrgent('waitlist_final')).toBe(false);
  });
});

describe('awaitingOutcome', () => {
  it('is true only inside the check-in reply window with no outcome yet', () => {
    expect(awaitingOutcome(state(), new Date('2026-09-15T14:30:00.000Z'))).toBe(true);
    // Before the open there is nothing to report.
    expect(awaitingOutcome(state(), new Date('2026-09-15T09:00:00.000Z'))).toBe(false);
    // Three days later the conversation has moved on.
    expect(awaitingOutcome(state(), new Date('2026-09-18T14:31:00.000Z'))).toBe(false);
    expect(
      awaitingOutcome(state({ outcome: 'registered' }), new Date('2026-09-15T14:30:00.000Z')),
    ).toBe(false);
  });

  it('accepts a reply from the moment registration opens, not only after the check-in', () => {
    // A parent who got in at 6:31 says so at 6:31. Waiting for our own question
    // before we are willing to hear the answer would be absurd.
    expect(awaitingOutcome(state(), new Date('2026-09-15T10:31:00.000Z'))).toBe(true);
  });

  it('is false for a family that never opted in', () => {
    expect(awaitingOutcome(state({ optIn: 'pending' }), new Date('2026-09-15T14:30:00.000Z'))).toBe(
      false,
    );
  });
});
