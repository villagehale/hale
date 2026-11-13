import { tsImport } from 'tsx/esm/api';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COACH_BUBBLES_FIXTURES,
  COACH_BUBBLES_NOW,
  COACH_BUBBLES_TIME_ZONE,
} from '../coach-bubbles-fixtures.mjs';
import { FIXTURE_FAR_EVENTS, FIXTURE_NOW, FIXTURE_TIMEZONE } from '../coach-channel-fixtures.mjs';
import { fixtureEventWhen, fixtureWeek } from './fixture-week.mjs';

/**
 * The coach-bubbles `lookup_week` stub reads the week the production tool reads. The other
 * side of each comparison is the REAL `lookup_week` (apps/web/lib/channel/coach/tools.ts)
 * over a reader holding the same events, filtered the way its query filters them
 * (starting by the window's end, and starting inside it or ending after its start).
 */

const TOOLS = new URL('../../../web/lib/channel/coach/tools.ts', import.meta.url);
const WEB_TSCONFIG = new URL('../../../web/tsconfig.json', import.meta.url).pathname;
const CLOCK = { now: COACH_BUBBLES_NOW, timeZone: COACH_BUBBLES_TIME_ZONE };
const ids = (events) => events.map((event) => event.eventId);

let productionLookupWeek;
beforeAll(async () => {
  const { buildChannelCoachTools } = await tsImport(TOOLS.href, {
    parentURL: import.meta.url,
    tsconfig: WEB_TSCONFIG,
  });
  productionLookupWeek = (fixture, clock = CLOCK) => {
    const events = fixture.events.map((event) => ({
      eventId: event.eventId,
      title: event.title,
      startsAt: new Date(event.startsAt),
      endsAt: event.endsAt ? new Date(event.endsAt) : null,
      location: event.location ?? null,
      childId: null,
      source: 'parent',
      teen: false,
      sensitive: false,
    }));
    const reader = {
      timeZone: async () => clock.timeZone,
      weekPlanSummary: async () => null,
      eventsInWeek: async (_familyId, start, end) =>
        events.filter(
          (event) =>
            event.startsAt <= end &&
            (event.startsAt >= start || (event.endsAt !== null && event.endsAt > start)),
        ),
      resolveEvent: async () => null,
      connectedWeek: async () => ({
        calendarSync: 'not_connected',
        blocks: [],
        mailSync: 'not_connected',
        processedCount: 0,
        since: null,
        activities: [],
        trips: [],
      }),
    };
    return buildChannelCoachTools({
      familyId: 'fixture-family',
      familyCountry: 'CA',
      reader,
      draftPort: { draft: async () => ({ actionId: 'unused' }) },
      villageTool: null,
      activity: null,
      spots: null,
      now: new Date(clock.now),
    }).find((tool) => tool.name === 'lookup_week');
  };
}, 60_000);

describe('the coach-bubbles lookup_week stub', () => {
  it('reads en-busy-week as nothing this week and all six events next week', async () => {
    // Now is Thu Nov 12 in Toronto, so this week is Mon Nov 9 to Sun Nov 15, and every
    // event in the case falls between Mon Nov 16 and Sat Nov 21.
    const { events } = COACH_BUBBLES_FIXTURES.find((fixture) => fixture.id === 'en-busy-week');
    expect(ids((await fixtureWeek(events, {}, CLOCK)).events)).toEqual([]);
    expect(ids((await fixtureWeek(events, { weekOffset: 1 }, CLOCK)).events)).toEqual([
      'evt-1',
      'evt-2',
      'evt-3',
      'evt-4',
      'evt-5',
      'evt-6',
    ]);
  });

  it('agrees with the production tool on every case with a calendar, this week to eight ahead', async () => {
    const withCalendar = COACH_BUBBLES_FIXTURES.filter((fixture) => fixture.events);
    expect(withCalendar.map((fixture) => fixture.id)).toContain('fr-move-swim');
    for (const fixture of withCalendar) {
      const lookupWeek = productionLookupWeek(fixture);
      for (const input of [{}, { weekOffset: 0 }, { weekOffset: 1 }, { weekOffset: 8 }]) {
        const stub = await fixtureWeek(fixture.events, input, CLOCK);
        const real = await lookupWeek.handler(lookupWeek.inputSchema.parse(input), {});
        expect(
          { weekStart: stub.weekStart, events: ids(stub.events) },
          `${fixture.id} ${JSON.stringify(input)}`,
        ).toEqual({ weekStart: real.weekStart, events: ids(real.events) });
      }
    }
  });

  it('refuses a week the production tool refuses', async () => {
    const lookupWeek = productionLookupWeek({ events: [] });
    for (const input of [{ weekOffset: 9 }, { weekOffset: -1 }, { weekOffset: '1' }]) {
      expect(lookupWeek.inputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
      await expect(fixtureWeek([], input, CLOCK), JSON.stringify(input)).rejects.toThrow();
    }
  });

  it('reads a stay that began the weekend before into the week it runs through, dated (VIL-688)', async () => {
    const clock = { now: FIXTURE_NOW, timeZone: FIXTURE_TIMEZONE };
    const lookupWeek = productionLookupWeek({ events: FIXTURE_FAR_EVENTS }, clock);
    const begunBefore = FIXTURE_FAR_EVENTS.find((event) => event.eventId === 'evt-dads-week');
    expect(Date.parse(begunBefore.startsAt)).toBeLessThan(Date.parse('2026-09-14T04:00:00.000Z'));
    for (const weekOffset of [5, 6]) {
      const stub = await fixtureWeek(FIXTURE_FAR_EVENTS, { weekOffset }, clock);
      const real = await lookupWeek.handler({ weekOffset }, {});
      expect(stub.events.map((event) => event.eventId)).toContain('evt-dads-week');
      expect(
        stub.events.map((event) => ({
          eventId: event.eventId,
          ...fixtureEventWhen(event, FIXTURE_TIMEZONE),
        })),
        `week ${weekOffset}`,
      ).toEqual(
        real.events.map(({ eventId, when, until }) => ({
          eventId,
          when,
          ...(until ? { until } : {}),
        })),
      );
    }
  });
});
