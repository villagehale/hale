// The week production `lookup_week` (apps/web/lib/channel/coach/tools.ts) reads, over a
// fixture's events: the family-local Monday-to-Sunday week `now` falls in, moved by
// `weekOffset`, from 00:00 Monday to 23:59 Sunday, as its reader queries it: an event
// starting by the week's end that starts inside it or is still running at its start. The window comes from the same spine functions the tool calls, so a fixture
// event dated next week is never read back as this week. fixture-week.test.mjs holds this
// to the real tool.

import { z } from 'zod';

const SPINE = new URL('../../../web/lib/plan/spine.ts', import.meta.url).href;

/** The tool's input schema: this week up to eight weeks ahead, and nothing past it (VIL-688). */
const lookupWeekInput = z.object({ weekOffset: z.number().int().min(0).max(8).optional() });

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
      const until = event.endsAt ? Date.parse(event.endsAt) : null;
      return at <= end && (at >= start || (until !== null && until > start));
    }),
  };
}

// REPLICATED from tools.ts localWhen / longWhen / spansDays: `~/` does not resolve here.
function localWhen(at, timeZone) {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  })
    .format(at)
    .replace(/\s/g, '')
    .toLowerCase();
  return `${weekday} ${time}`;
}

function longWhen(at, timeZone) {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(at);
  return `${day}, ${localWhen(at, timeZone).split(' ')[1]}`;
}

const dayKey = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);

/**
 * A family event's `when`, and its `until` only when it runs past the day it starts, as
 * production lookup_week renders them (VIL-688). fixture-week.test.mjs holds this to the
 * real tool.
 */
export function fixtureEventWhen(event, timeZone) {
  const startsAt = new Date(event.startsAt);
  const endsAt = event.endsAt ? new Date(event.endsAt) : null;
  if (endsAt === null || dayKey(endsAt, timeZone) === dayKey(startsAt, timeZone)) {
    return { when: localWhen(startsAt, timeZone) };
  }
  return { when: longWhen(startsAt, timeZone), until: longWhen(endsAt, timeZone) };
}
