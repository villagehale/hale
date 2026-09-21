import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type OutboundGatePorts,
  PROACTIVE_CAP,
  PROACTIVE_CATEGORY,
  holdStatus,
  PROACTIVE_QUIET_HOURS,
  assertProactiveSendAllowed,
} from './outbound-gate.js';
import { OPT_OUT_PERIOD_DAYS, optOutPeriodStart } from './opt-out.js';

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
  /** Whether ANY proactive class has reached this family in the current opt-out period.
   * True by default: the steady state is a family Hale has texted before, and the tests
   * that care about the CASL line set it false to mean "first contact ever". */
  contactedThisPeriod: boolean;
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
    contactedThisPeriod: true,
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
      async proactiveSentSince() {
        calls.push('opt_out');
        return resolved.contactedThisPeriod;
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
    await expect(callGate(MIDDAY).verdict).resolves.toEqual({ allowed: true, optOut: 'short' });
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
    expect(verdict).toEqual({ allowed: true, optOut: 'short' });
    expect(seen).not.toBeNull();
    const { since, familyId } = seen as unknown as { since: Date; familyId: string };
    // Per FAMILY (not per parent) — a co-parent must not double the family's budget.
    expect(familyId).toBe(FAMILY);
    expect(MIDDAY.getTime() - since.getTime()).toBe(
      (PROACTIVE_CAP.nudge?.windowHours ?? 0) * 3_600_000,
    );
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
      optOut: 'short',
    });
  });

  it('reads the wall clock through DST, not a fixed UTC offset', async () => {
    // The SAME UTC time-of-day: 20:30 in January (EST, UTC-5) and 21:30 in July
    // (EDT, UTC-4). A fixed-offset implementation gets one of these wrong.
    await expect(callGate(new Date('2026-01-15T01:30:00.000Z')).verdict).resolves.toEqual({
      allowed: true,
      optOut: 'short',
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
      optOut: 'short',
    });
    await expect(callGate(evening, { timeZone: 'America/Toronto' }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });
});

/**
 * VIL-242 · M7 — the registration-sequence class, and the two exemptions it carries.
 *
 * Both exemptions are scoped to this class BY CONSTRUCTION, and the tests below exist to
 * prove the scoping rather than the exemption: a class that can opt out of the cap and
 * the clock is exactly the kind of thing that leaks to its neighbours.
 */
describe('the registration-sequence class', () => {
  function callSequenceGate(now: Date, state: Partial<FakeState> = {}, urgent = false) {
    const fake = ports(state);
    return {
      calls: fake.calls,
      verdict: assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'registration_sequence',
          now,
          urgent,
        },
        fake.ports,
      ),
    };
  }

  it('has no volume budget at all — the ladder is bounded by the window, not by a cap', () => {
    // A sequence's legs are finite by construction (one window, one ladder) and every
    // one of them is a date the parent asked to be walked through. Counting them
    // against a discretionary weekly nudge budget would let a busy registration season
    // silence the sequence a parent explicitly approved.
    expect(PROACTIVE_CAP.registration_sequence).toBeNull();
  });

  it('never even counts the family’s recent sends', async () => {
    const { calls, verdict } = callSequenceGate(MIDDAY, { recentSends: 99 });
    await expect(verdict).resolves.toEqual({ allowed: true, optOut: 'short' });
    expect(calls).toEqual(['enrolled', 'consent', 'tz', 'opt_out']);
  });

  it('still fails the checks that are about CONSENT, not volume', async () => {
    await expect(callSequenceGate(MIDDAY, { enrolled: false }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'not_enrolled',
    });
    await expect(callSequenceGate(MIDDAY, { consented: false }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'no_watch_consent',
    });
  });

  it('respects quiet hours for a leg that is not urgent', async () => {
    // 22:00 in Toronto. A heads-up a week out has all night to wait.
    const late = new Date('2026-07-16T02:00:00.000Z');
    await expect(callSequenceGate(late).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });

  it('crosses quiet hours for an urgent leg', async () => {
    // 06:15 in Toronto — inside quiet hours, and the only moment a "registration
    // opens at 6:30" message is worth anything.
    const dawn = new Date('2026-07-15T10:15:00.000Z');
    await expect(callSequenceGate(dawn).verdict).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
    await expect(callSequenceGate(dawn, {}, true).verdict).resolves.toEqual({ allowed: true, optOut: 'short' });
  });

  it('does NOT let a nudge claim the same exemption', async () => {
    // The scoping test. A nudge that asks for urgency is still held — fail-closed, so
    // a future caller cannot widen the exemption by setting a flag.
    const dawn = new Date('2026-07-15T10:15:00.000Z');
    const fake = ports();
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: dawn, urgent: true },
        fake.ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
  });

  it('does NOT let a nudge escape its cap', async () => {
    // The other half of the scoping test: the uncapped class must not have widened
    // the budget check for everyone.
    expect(PROACTIVE_CAP.nudge).toEqual({ max: 1, windowHours: 24 * 7 });
    await expect(callGate(MIDDAY, { recentSends: 1 }).verdict).resolves.toEqual({
      allowed: false,
      reason: 'frequency_cap',
    });
  });
});

describe('gate ordering', () => {
  it('runs enrolled → consent → cap → quiet hours', async () => {
    const { calls, verdict } = callGate(MIDDAY);
    await verdict;
    // 'opt_out' runs LAST and only on the allowed path: a held message is not a send,
    // so it must not spend the family's reminder.
    expect(calls).toEqual(['enrolled', 'consent', 'cap', 'tz', 'opt_out']);
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

/**
 * THE CASL OPT-OUT BUDGET (2026-08-13). The line is a right, not a footer: it must reach
 * every family, and it must not ride every message. These four pin both halves.
 */
describe('the opt-out line', () => {
  /**
   * CASL s.6(2)(c) / s.11 want the unsubscribe mechanism set out clearly and prominently in
   * EVERY commercial electronic message — there is no "periodically" allowance; that one is
   * CTIA's, and it is a US rule. So the gate no longer decides WHETHER the line rides. It
   * decides which FORM rides (founder decision, 2026-08-14, after counsel).
   */
  it('rides EVERY proactive message - the mechanism is never absent', async () => {
    for (const contactedThisPeriod of [true, false]) {
      const verdict = await callGate(MIDDAY, { contactedThisPeriod }).verdict;
      expect(verdict.allowed, `contactedThisPeriod=${contactedThisPeriod}`).toBe(true);
      expect(
        verdict.allowed && verdict.optOut,
        'no allowed verdict may omit the unsubscribe',
      ).toBeTruthy();
    }
  });

  it('gives a first contact the full line and everything after it the short one', async () => {
    await expect(callGate(MIDDAY, { contactedThisPeriod: false }).verdict).resolves.toEqual({
      allowed: true,
      optOut: 'full',
    });
    await expect(callGate(MIDDAY, { contactedThisPeriod: true }).verdict).resolves.toEqual({
      allowed: true,
      optOut: 'short',
    });
  });

  it('asks whether ANY proactive class has landed for THIS PARENT, not just this class', async () => {
    // Kind-blind, because the form is not a message class's. Per PARENT and not per family,
    // because the five classes text different people — scoped to the household, a co-parent
    // could be texted for months and never once get the full line.
    let seen: { subject: string; since: Date } | null = null;
    await assertProactiveSendAllowed(
      { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
      {
        ...ports().ports,
        async proactiveSentSince(parentUserId, since) {
          seen = { subject: parentUserId, since };
          return true;
        },
      },
    );
    const asked = seen as unknown as { subject: string; since: Date };
    expect(asked.subject).toBe(PARENT);
    expect(asked.subject).not.toBe(FAMILY);
    // A fixed 30-day grid, so the window start is the same instant for every family and
    // every surface, and nothing has to be stored to agree on it.
    expect(asked.since).toEqual(optOutPeriodStart(MIDDAY));
    expect(MIDDAY.getTime() - asked.since.getTime()).toBeLessThan(
      OPT_OUT_PERIOD_DAYS * 24 * 3_600_000,
    );
  });

  it('falls back to the FULL line when the ledger read fails', async () => {
    // Fail toward compliance. The short form is the optimisation; the full line is the
    // obligation, so an unknown answer resolves to the obligation.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'nudge', now: MIDDAY },
        {
          ...ports().ports,
          async proactiveSentSince() {
            throw new Error('ledger unavailable');
          },
        },
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'full' });
  });

  it('still decides the form for an urgent leg that skips the clock', async () => {
    const dawn = new Date('2026-07-15T10:30:00.000Z'); // 06:30 Toronto - inside quiet hours
    await expect(
      assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'registration_sequence',
          now: dawn,
          urgent: true,
        },
        ports({ contactedThisPeriod: false }).ports,
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'full' });
  });

  it('is not read at all for a message that was held', async () => {
    // A held send is not a send, and the gate looks at nothing it is not entitled to act on.
    const { calls, verdict } = callGate(MIDDAY, { enrolled: false, contactedThisPeriod: false });
    await verdict;
    expect(calls).not.toContain('opt_out');
  });
});

/**
 * VIL-337 · the watched-spot classes. Two kinds, one category, and the difference
 * between them is a stored per-watch opt-in rather than anything a caller may assert.
 */
describe('the watched-spot proactive classes', () => {
  /** 02:00 in Toronto (EDT) — the middle of the proactive quiet window. */
  const TWO_AM = new Date('2026-07-15T06:00:00.000Z');

  it('holds spot_open at 02:00 even when the caller claims urgency', async () => {
    // Kills the "instant is a call-site flag" mutation: URGENCY_ALLOWED.spot_open = true
    // would let any sweep tick text a household at 2 a.m. by passing urgent: true.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'spot_open', now: TWO_AM, urgent: true },
        ports().ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
  });

  it('lets spot_open_instant through at 02:00 — that is the whole of what the parent opted into', async () => {
    // Kills URGENCY_ALLOWED.spot_open_instant = false, which would silently turn the
    // per-watch opt-in into nothing at all.
    await expect(
      assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'spot_open_instant',
          now: TWO_AM,
          urgent: true,
        },
        ports().ports,
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'short' });
  });

  it('still holds spot_open_instant when it does not claim urgency', async () => {
    // The class is an ALLOWANCE, not a bypass: a send that did not ask to cross quiet
    // hours does not cross them.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'spot_open_instant', now: TWO_AM },
        ports().ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
  });

  it('counts both kinds under ONE ledger category, on ONE budget', () => {
    // Kills the mutation that gives spot_open_instant its own category: a household
    // holding several watches would then get 4 held + 4 instant openings in a day, and
    // the cap the two classes exist to share would read as half spent.
    expect(PROACTIVE_CATEGORY.spot_open).toBe('spot_open');
    expect(PROACTIVE_CATEGORY.spot_open_instant).toBe('spot_open');
    expect(PROACTIVE_CAP.spot_open).toEqual({ max: 4, windowHours: 24 });
    expect(PROACTIVE_CAP.spot_open_instant).toEqual({ max: 4, windowHours: 24 });
  });

  it('never lets an email alert claim urgency — the inbox keeps until 08:00', async () => {
    // Kills URGENCY_ALLOWED.email_alert = true, copied from the instant watch above: a
    // classifier that fires at 02:00 would then wake a household about a school notice.
    await expect(
      assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'email_alert',
          now: TWO_AM,
          urgent: true,
        },
        ports().ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
  });

  it('holds the fourth email alert in a day', async () => {
    // Kills PROACTIVE_CAP.email_alert = null: the volume of this class is set by how much
    // mail arrives, so an uncapped one turns a busy mailbox into a feed.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'email_alert', now: MIDDAY },
        ports({ recentSends: 3 }).ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'email_alert', now: MIDDAY },
        ports({ recentSends: 2 }).ports,
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'short' });
  });

  it('never lets a calendar alert claim urgency — a moved Thursday keeps until 08:00', async () => {
    // Kills URGENCY_ALLOWED.calendar_alert = true: a connector sweep runs every fifteen
    // minutes, so an exemption here would let a 02:00 edit wake the household.
    await expect(
      assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'calendar_alert',
          now: TWO_AM,
          urgent: true,
        },
        ports().ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
  });

  it('holds the fourth calendar alert in a day, on a counter of its own', async () => {
    // Kills PROACTIVE_CAP.calendar_alert = null: the volume is set by how much a family
    // rearranges its week, and a Sunday-evening rebuild is thirty edits in one sweep.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'calendar_alert', now: MIDDAY },
        ports({ recentSends: 3 }).ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'calendar_alert', now: MIDDAY },
        ports({ recentSends: 2 }).ports,
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'short' });
  });

  it('counts the calendar apart from the inbox', () => {
    // Kills PROACTIVE_CATEGORY.calendar_alert = 'email_alert', which would make three
    // school emails silence the calendar for the rest of the day.
    expect(PROACTIVE_CATEGORY.calendar_alert).toBe('calendar_alert');
    expect(PROACTIVE_CATEGORY.email_alert).toBe('email_alert');
  });

  it('holds the fifth opening in a day', async () => {
    // Kills `PROACTIVE_CAP.spot_open = null`, which the registration ladder's entry makes
    // an easy copy: a flapping portal would then be an unbounded text campaign.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'spot_open', now: MIDDAY },
        ports({ recentSends: 4 }).ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
  });
});

describe('the travel brief class', () => {
  /** 02:00 Toronto — inside the 21:00-08:00 proactive quiet window. */
  const TWO_AM = new Date('2026-07-15T06:00:00.000Z');

  it('never claims urgency — a trip next week is worth the same at 08:00', async () => {
    // Kills URGENCY_ALLOWED.travel_brief = true. There is no version of "here is what is
    // on in New York in seven days" that is worth waking a house for, and the exemption is
    // read per CLASS so a sweep cannot reach it by setting a flag.
    await expect(
      assertProactiveSendAllowed(
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          kind: 'travel_brief',
          now: TWO_AM,
          urgent: true,
        },
        ports().ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'quiet_hours' });
  });

  it('holds the second trip inside one week, on a counter of its own', async () => {
    // Kills PROACTIVE_CAP.travel_brief = null, which the two nulls above make an easy
    // copy. The per-trip bound is the claim keyed on the trip id, so this counter only
    // binds when something upstream went wrong — or in the one honest case the design
    // names out loud, a household with two trips in one seven-day window.
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'travel_brief', now: MIDDAY },
        ports({ recentSends: 1 }).ports,
      ),
    ).resolves.toEqual({ allowed: false, reason: 'frequency_cap' });
    await expect(
      assertProactiveSendAllowed(
        { familyId: FAMILY, parentUserId: PARENT, kind: 'travel_brief', now: MIDDAY },
        ports({ recentSends: 0 }).ports,
      ),
    ).resolves.toEqual({ allowed: true, optOut: 'short' });
    expect(PROACTIVE_CAP.travel_brief).toEqual({ max: 1, windowHours: 24 * 7 });
  });

  it('counts apart from the inbox it was detected in', () => {
    // Kills PROACTIVE_CATEGORY.travel_brief = 'email_alert', which would make three school
    // emails silence a family's one travel text — and then read the inbox cap as spent by
    // a message the alert path never sent.
    expect(PROACTIVE_CATEGORY.travel_brief).toBe('travel_brief');
  });
});

describe('holdStatus — one copy, beside the union it is keyed on', () => {
  /**
   * It was a module-private `Record` in `integrations/email-alert.ts` and AGAIN in
   * `integrations/calendar-alert.ts`; the travel sweep needed a third, so it was hoisted
   * here instead. A `Record` over `ProactiveHoldReason`, so a fifth hold reason cannot be
   * added without choosing what its receipt says.
   */
  it('maps every hold reason to the suppression the ledger records', () => {
    expect(holdStatus('quiet_hours')).toBe('suppressed_quiet_hours');
    expect(holdStatus('frequency_cap')).toBe('suppressed_cap');
    expect(holdStatus('not_enrolled')).toBe('suppressed_consent');
    expect(holdStatus('no_watch_consent')).toBe('suppressed_consent');
  });

  /**
   * WHY THIS SCANS THE TREE RATHER THAN A LIST OF FILES. The first version of this test
   * named the three files the hoist had touched, and a fourth private copy — landed in
   * `channel/coparent/departure-notice.ts` before this branch was cut — sat outside it and
   * made the claim above false while the test stayed green. A list of the places a shape
   * has already leaked to cannot catch the next one; the scan can, and a file added
   * tomorrow is in it for free.
   */
  it('is the ONLY copy left — no file under apps/web re-declares it', () => {
    // A private copy re-appearing is the drift this hoist exists to prevent, and it is not
    // catchable by types: a second literal compiles perfectly.
    const web = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
    const declaring: string[] = [];
    for (const file of sourceFiles(join(web, 'lib')).concat(sourceFiles(join(web, 'app')))) {
      if (file === join(web, 'lib/channel/outbound-gate.ts')) continue;
      if (readFileSync(file, 'utf8').includes('HOLD_STATUS')) {
        declaring.push(file.slice(web.length + 1));
      }
    }
    expect(declaring, 'these files must import holdStatus instead of re-declaring it').toEqual([]);
  });

  it('is imported by every file that records a hold — the control for the scan above', () => {
    // Absence proves nothing on its own: the scan would also pass if no file used the
    // mapping at all. These three take it from the one copy.
    const web = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
    for (const file of [
      'lib/integrations/email-alert.ts',
      'lib/integrations/calendar-alert.ts',
      'lib/channel/coparent/departure-notice.ts',
      'lib/travel/sweep.ts',
    ]) {
      const source = readFileSync(join(web, file), 'utf8');
      expect(source, `${file} must import holdStatus`).toContain('holdStatus');
    }
  });
});

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);

/** Every non-test source file under `dir`, the `one-door.test.ts` walk. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}
