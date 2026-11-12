// The week production `lookup_week` (apps/web/lib/channel/coach/tools.ts) reads, over a
// fixture's events: the family-local Monday-to-Sunday week `now` falls in, moved by
// `weekOffset`, from 00:00 Monday to 23:59 Sunday with both ends kept, as its reader
// queries it. The window comes from the same spine functions the tool calls, so a fixture
// event dated next week is never read back as this week. fixture-week.test.mjs holds this
// to the real tool.

import { z } from 'zod';

const SPINE = new URL('../../../web/lib/plan/spine.ts', import.meta.url).href;

/** The tool's input schema: this week or the next, and nothing past it. */
const lookupWeekInput = z.object({ weekOffset: z.number().int().min(0).max(1).optional() });

export async function fixtureWeek(events, input, { now, timeZone }) {
  const { weekOffset = 0 } = lookupWeekInput.parse(input);
  const { weekWindow, zonedLocalInstant } = await import(SPINE);
  const window = weekWindow(new Date(now), timeZone, 1, weekOffset);
  const start = zonedLocalInstant(window.startKey, '00:00', timeZone).getTime();
  const end = zonedLocalInstant(window.dayKeys[6], '23:59', timeZone).getTime();
  return {
    weekStart: window.startKey,
    events: events.filter((event) => {
      const at = Date.parse(event.startsAt);
      return at >= start && at <= end;
    }),
  };
}
