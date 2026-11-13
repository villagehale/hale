import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { addDaysToKey, dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';

/**
 * "The next day", on the household's own clock: from the end of quiet hours on the local
 * day after the ask, to the same time a day later. Built from the gate's own floor, not a
 * slot of its own. Inside it the decider picks the moment and the gate keeps quiet hours.
 */
export function nextDayWindow(anchor: Date, timeZone: string): { opensAt: Date; closesAt: Date } {
  const day = addDaysToKey(dayKeyIn(anchor, timeZone), 1);
  return {
    opensAt: zonedLocalInstant(day, PROACTIVE_QUIET_HOURS.end, timeZone),
    closesAt: zonedLocalInstant(addDaysToKey(day, 1), PROACTIVE_QUIET_HOURS.end, timeZone),
  };
}

export type CheckbackTiming =
  | { due: true; opensAt: Date; closesAt: Date }
  | { due: false; reason: 'too_soon' | 'past_day' };

/** One chance: a day that passed is not caught up later (fewer asks wins every tie). */
export function checkbackTiming(input: {
  anchor: Date;
  timeZone: string;
  now: Date;
}): CheckbackTiming {
  const { opensAt, closesAt } = nextDayWindow(input.anchor, input.timeZone);
  if (input.now.getTime() < opensAt.getTime()) return { due: false, reason: 'too_soon' };
  if (input.now.getTime() >= closesAt.getTime()) return { due: false, reason: 'past_day' };
  return { due: true, opensAt, closesAt };
}
