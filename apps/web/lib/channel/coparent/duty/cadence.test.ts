import { describe, expect, it } from 'vitest';
import {
  GROUP_DISCRETIONARY_DAY_MAX,
  GROUP_DISCRETIONARY_WEEK_MAX,
  GROUP_HARD_DAY_MAX,
} from '~/lib/channel/linq/family-outbound';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { isWithinQuietHours, localParts } from '~/lib/loop/prefs';
import {
  type CadenceContext,
  DISCRETIONARY_PER_DAY,
  DISCRETIONARY_PER_WEEK,
  type DutyOccasion,
  PROACTIVE_BUBBLES_PER_DAY,
  dutyExtractorMayRun,
  dutyModeCountsAgainstAskBudget,
  dutySendHeldByCaps,
  inNightBeforeWindow,
  matchParentDutyAsk,
  planDutyCadence,
} from './cadence';

const TZ = 'America/Toronto';
/** Sunday 27 Sep 2026, 15:00 EDT. */
const SUNDAY_AFTERNOON = new Date('2026-09-27T19:00:00.000Z');
/** Sunday 27 Sep 2026, 18:00 EDT — inside 17:00–21:00, outside quiet hours. */
const SUNDAY_EVENING = new Date('2026-09-27T22:00:00.000Z');
/** Monday 28 Sep 2026, 15:00 EDT. */
const MONDAY = new Date('2026-09-28T19:00:00.000Z');
/** Tuesday 29 Sep 2026, 15:00 EDT. */
const TUESDAY = new Date('2026-09-29T19:00:00.000Z');

function occasion(partial: Partial<DutyOccasion> & Pick<DutyOccasion, 'eventKey'>): DutyOccasion {
  return {
    role: 'pickup',
    startsAt: MONDAY,
    hasOwner: false,
    conflict: false,
    needsWhichKid: false,
    cancelled: false,
    hasDutyRecord: false,
    reasked: false,
    source: 'calendar',
    ...partial,
  };
}

function ctx(partial: Partial<CadenceContext> = {}): CadenceContext {
  return {
    now: SUNDAY_AFTERNOON,
    bubbleLeaving: false,
    open: null,
    occasions: [],
    parentAsk: null,
    proactiveToday: 0,
    discretionaryToday: 0,
    discretionaryWeek: 0,
    localMinutes: 15 * 60,
    weekday: 0,
    quiet: false,
    quietStartMin: 21 * 60,
    timeZone: TZ,
    ...partial,
  };
}

describe('duty cadence windows', () => {
  it('treats 17:00 as inside the night-before window and 21:00 as quiet', () => {
    expect(inNightBeforeWindow(17 * 60, 21 * 60)).toBe(true);
    expect(inNightBeforeWindow(20 * 60 + 59, 21 * 60)).toBe(true);
    expect(inNightBeforeWindow(16 * 60 + 59, 21 * 60)).toBe(false);
    expect(inNightBeforeWindow(21 * 60, 21 * 60)).toBe(false);
    const evening = localParts(SUNDAY_EVENING, TZ);
    expect(evening.weekday).toBe(0);
    expect(inNightBeforeWindow(evening.minutes, 21 * 60)).toBe(true);
    expect(
      isWithinQuietHours(
        SUNDAY_EVENING,
        TZ,
        PROACTIVE_QUIET_HOURS.start,
        PROACTIVE_QUIET_HOURS.end,
      ),
    ).toBe(false);
    const night = new Date('2026-09-28T01:30:00.000Z');
    expect(
      isWithinQuietHours(night, TZ, PROACTIVE_QUIET_HOURS.start, PROACTIVE_QUIET_HOURS.end),
    ).toBe(true);
  });

  it('folds the Sunday overview into a bubble that is already leaving', () => {
    const plan = planDutyCadence(ctx({ bubbleLeaving: true, occasions: [] }));
    expect(plan.foldLines.map((row) => row.mode)).toEqual(['week_overview']);
    expect(plan.sendLines).toEqual([]);
  });

  it('does not open a Sunday bubble of its own', () => {
    const plan = planDutyCadence(ctx({ bubbleLeaving: false }));
    expect(plan.foldLines).toEqual([]);
    expect(plan.sendLines).toEqual([]);
  });

  it('folds one 48-hour re-ask and does not send it alone', () => {
    const folded = planDutyCadence(
      ctx({
        bubbleLeaving: true,
        occasions: [occasion({ eventKey: 'swim' })],
      }),
    );
    expect(folded.foldLines.map((row) => row.mode)).toEqual(['week_overview', 'reask_48h']);
    expect(folded.sendLines).toEqual([]);
    const alone = planDutyCadence(
      ctx({
        bubbleLeaving: false,
        occasions: [occasion({ eventKey: 'swim' })],
      }),
    );
    expect(alone.sendLines).toEqual([]);
    expect(alone.foldLines).toEqual([]);
  });

  it('sends a night-before confirmation only inside the window', () => {
    const owned = occasion({ eventKey: 'swim', hasOwner: true, hasDutyRecord: true });
    const evening = planDutyCadence(
      ctx({
        now: SUNDAY_EVENING,
        localMinutes: 18 * 60,
        occasions: [owned],
      }),
    );
    expect(evening.sendLines.map((row) => row.mode)).toEqual(['night_before']);
    const afternoon = planDutyCadence(ctx({ localMinutes: 15 * 60, occasions: [owned] }));
    expect(afternoon.sendLines).toEqual([]);
  });

  it('holds a night-before send during quiet hours', () => {
    const plan = planDutyCadence(
      ctx({
        now: new Date('2026-09-28T01:30:00.000Z'),
        localMinutes: 21 * 60 + 30,
        quiet: true,
        occasions: [occasion({ eventKey: 'swim', hasOwner: true, hasDutyRecord: true })],
      }),
    );
    expect(plan.sendLines).toEqual([]);
    expect(plan.held).toBe('quiet_hours');
  });
});

describe('duty cadence caps and step-down', () => {
  it('matches the group bubble budget', () => {
    expect(PROACTIVE_BUBBLES_PER_DAY).toBe(GROUP_HARD_DAY_MAX);
    expect(DISCRETIONARY_PER_DAY).toBe(GROUP_DISCRETIONARY_DAY_MAX);
    expect(DISCRETIONARY_PER_WEEK).toBe(GROUP_DISCRETIONARY_WEEK_MAX);
    expect(PROACTIVE_BUBBLES_PER_DAY).toBe(2);
    expect(DISCRETIONARY_PER_DAY).toBe(1);
    expect(DISCRETIONARY_PER_WEEK).toBe(3);
  });

  it('holds the third proactive bubble and the second discretionary bubble', () => {
    const owned = occasion({ eventKey: 'swim', hasOwner: true, hasDutyRecord: true });
    const evening = {
      now: SUNDAY_EVENING,
      localMinutes: 18 * 60,
      occasions: [owned],
    };
    expect(planDutyCadence(ctx({ ...evening, proactiveToday: 2 })).held).toBe('group_cap');
    expect(planDutyCadence(ctx({ ...evening, discretionaryToday: 1 })).held).toBe('group_cap');
    expect(planDutyCadence(ctx({ ...evening, discretionaryWeek: 3 })).held).toBe('group_cap');
    expect(
      dutySendHeldByCaps({
        discretionary: false,
        proactiveToday: 1,
        discretionaryToday: 1,
        discretionaryWeek: 3,
      }),
    ).toBeNull();
  });

  it('steps down after three unanswered asks and does not ask again', () => {
    const open = {
      eventKey: 'swim',
      role: 'pickup' as const,
      unanswered: 3,
      silentNamed: true,
      status: 'open' as const,
    };
    const plan = planDutyCadence(
      ctx({
        bubbleLeaving: true,
        open,
        occasions: [occasion({ eventKey: 'swim' })],
      }),
    );
    expect(plan.stepDown).toEqual({ eventKey: 'swim', role: 'pickup' });
    expect(plan.foldLines.map((row) => row.mode)).toEqual(['week_overview']);
    expect(plan.sendLines).toEqual([]);
    const again = planDutyCadence(
      ctx({ open: { ...open, status: 'stepped_down' }, bubbleLeaving: true }),
    );
    expect(again.stepDown).toBeNull();
  });

  it('names a silent parent once, and only on a bubble that is already leaving', () => {
    const open = {
      eventKey: 'swim',
      role: 'pickup' as const,
      unanswered: 1,
      silentNamed: false,
      status: 'open' as const,
    };
    const named = planDutyCadence(ctx({ bubbleLeaving: true, open, occasions: [] }));
    expect(named.foldLines.filter((row) => row.namesSilentParent)).toHaveLength(1);
    const twice = planDutyCadence(
      ctx({ bubbleLeaving: true, open: { ...open, silentNamed: true }, occasions: [] }),
    );
    expect(twice.foldLines.filter((row) => row.namesSilentParent)).toHaveLength(0);
    const alone = planDutyCadence(ctx({ bubbleLeaving: false, open, occasions: [] }));
    expect(alone.sendLines).toEqual([]);
    expect(alone.foldLines).toEqual([]);
  });
});

describe('one open question', () => {
  it('asks about one of two unowned events', () => {
    const plan = planDutyCadence(
      ctx({
        bubbleLeaving: true,
        occasions: [
          occasion({ eventKey: 'swim', startsAt: MONDAY }),
          occasion({ eventKey: 'piano', startsAt: TUESDAY }),
        ],
      }),
    );
    const questions = plan.foldLines.filter((row) => row.opensQuestion);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.eventKey).toBe('swim');
  });

  it('lets the silent line repeat the open question and never open a second one', () => {
    const plan = planDutyCadence(
      ctx({
        bubbleLeaving: true,
        open: {
          eventKey: 'swim',
          role: 'pickup',
          unanswered: 1,
          silentNamed: false,
          status: 'open',
        },
        occasions: [
          occasion({ eventKey: 'swim', startsAt: MONDAY }),
          occasion({ eventKey: 'piano', startsAt: TUESDAY }),
        ],
      }),
    );
    const questions = [...plan.foldLines, ...plan.sendLines].filter((row) => row.opensQuestion);
    expect(questions).toHaveLength(1);
    const silent = plan.foldLines.find((row) => row.mode === 'silent_parent');
    expect(silent?.opensQuestion).toBe(false);
    expect(silent?.namesSilentParent).toBe(true);
  });

  it('does not open a second question while one is unanswered', () => {
    const plan = planDutyCadence(
      ctx({
        bubbleLeaving: true,
        open: {
          eventKey: 'swim',
          role: 'pickup',
          unanswered: 1,
          silentNamed: false,
          status: 'open',
        },
        occasions: [
          occasion({ eventKey: 'swim', startsAt: MONDAY }),
          occasion({ eventKey: 'piano', startsAt: TUESDAY }),
        ],
      }),
    );
    const questions = [...plan.foldLines, ...plan.sendLines].filter((row) => row.opensQuestion);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.eventKey).toBe('swim');
  });

  it('drops email, including a party invite, and still invalidates a cancelled duty', () => {
    const plan = planDutyCadence(
      ctx({
        bubbleLeaving: true,
        occasions: [
          occasion({
            eventKey: 'party',
            source: 'email',
            cancelled: true,
            hasDutyRecord: true,
            startsAt: MONDAY,
          }),
        ],
      }),
    );
    expect(plan.invalidateEventKeys).toEqual(['party']);
    expect(plan.foldLines.map((row) => row.mode)).toEqual(['week_overview']);
    expect(plan.sendLines).toEqual([]);
  });
});

describe('parent-initiated asks', () => {
  it('recognises who has pickup on Thursday', () => {
    expect(matchParentDutyAsk("who's got pickup Thursday?")).toEqual({
      role: 'pickup',
      weekday: 4,
    });
    expect(matchParentDutyAsk('see you Thursday')).toBeNull();
  });

  it('answers in the group and does not open a second question', () => {
    const plan = planDutyCadence(
      ctx({
        parentAsk: { role: 'pickup', weekday: null },
        open: {
          eventKey: 'piano',
          role: 'dropoff',
          unanswered: 1,
          silentNamed: false,
          status: 'open',
        },
        occasions: [occasion({ eventKey: 'swim', role: 'pickup' })],
      }),
    );
    expect(plan.held).toBe('open_question');
    expect(plan.sendLines).toEqual([]);
  });
});

describe('ask budget and stop asking', () => {
  it('counts which-kid, both-claimed, re-ask, and night-before, and not the other three', () => {
    for (const mode of ['which_kid', 'both_claimed', 'reask_48h', 'night_before'] as const) {
      expect(dutyModeCountsAgainstAskBudget(mode)).toBe(true);
    }
    for (const mode of ['week_overview', 'parent_initiated', 'silent_parent'] as const) {
      expect(dutyModeCountsAgainstAskBudget(mode)).toBe(false);
    }
    const evening = planDutyCadence(
      ctx({
        now: SUNDAY_EVENING,
        localMinutes: 18 * 60,
        occasions: [occasion({ eventKey: 'swim', hasOwner: true, hasDutyRecord: true })],
      }),
    );
    expect(evening.sendLines[0]).toMatchObject({ mode: 'night_before', discretionary: true });
    const overview = planDutyCadence(ctx({ bubbleLeaving: true }));
    expect(overview.foldLines[0]).toMatchObject({ mode: 'week_overview', discretionary: false });
  });

  it('holds items 3 to 7 for a parent who said stop asking, and still answers', () => {
    const owned = occasion({ eventKey: 'swim', hasOwner: true, hasDutyRecord: true });
    const held = planDutyCadence(
      ctx({
        now: SUNDAY_EVENING,
        localMinutes: 18 * 60,
        bubbleLeaving: true,
        stopAsking: true,
        open: {
          eventKey: 'swim',
          role: 'pickup',
          unanswered: 1,
          silentNamed: false,
          status: 'open',
        },
        occasions: [owned, occasion({ eventKey: 'piano', needsWhichKid: true, startsAt: TUESDAY })],
      }),
    );
    const modes = [...held.foldLines, ...held.sendLines].map((row) => row.mode);
    expect(modes).toEqual(['week_overview']);
    expect(held.sendLines).toEqual([]);
    const answered = planDutyCadence(
      ctx({
        stopAsking: true,
        parentAsk: { role: 'pickup', weekday: null },
        occasions: [occasion({ eventKey: 'swim', role: 'pickup', hasOwner: true })],
      }),
    );
    expect(answered.sendLines.map((row) => row.mode)).toEqual(['parent_initiated']);
    expect(answered.sendLines[0]?.discretionary).toBe(false);
  });
});

describe('duty extractor budget', () => {
  it('does not run when the send flag is off or the day is spent', () => {
    expect(dutyExtractorMayRun({ sendsActive: false, callsToday: 0 })).toBe(false);
    expect(dutyExtractorMayRun({ sendsActive: true, callsToday: 1 })).toBe(false);
    expect(dutyExtractorMayRun({ sendsActive: true, callsToday: 0 })).toBe(true);
  });
});
