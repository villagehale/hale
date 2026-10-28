import { describe, expect, it } from 'vitest';
import type { CalendarBlockView, ScheduleEvent } from '~/lib/channel/coach/tools';
import { attachKidClashes } from './tools';

// Fake test family: Maya has Saturday swim 10:00–11:00 Toronto (14:00–15:00Z).
const MAYA = '00000000-0000-4000-8000-00000000a001';
const SWIM: ScheduleEvent = {
  eventId: 'ev-swim',
  title: 'Saturday swim',
  startsAt: new Date('2026-10-31T14:00:00.000Z'),
  endsAt: new Date('2026-10-31T15:00:00.000Z'),
  location: null,
  childId: MAYA,
  source: 'channel',
  teen: false,
  sensitive: false,
};
const ADULT: CalendarBlockView = {
  startsAt: new Date('2026-10-31T13:00:00.000Z'),
  endsAt: new Date('2026-10-31T18:00:00.000Z'),
  allDay: false,
  title: null,
};
let reads = 0;
const reader = async () => ({
  async eventsInWeek() {
    reads += 1;
    return [SWIM];
  },
  async connectedWeek() {
    return { blocks: [ADULT] };
  },
});

describe('search_village · kid clash facts only on a structured session (VIL-79)', () => {
  it('a structured session overlapping a kid event carries the clash fact', async () => {
    const [c] = await attachKidClashes(reader, 'fam', [
      {
        title: 'Art',
        session: { startsAt: '2026-10-31T14:30:00.000Z', endsAt: '2026-10-31T15:30:00.000Z' },
      },
    ]);
    expect(c?.clashes?.map((f) => [f.what, f.childId])).toEqual([['Saturday swim', MAYA]]);
  });

  it('back-to-back gives an empty list; the adult block never appears', async () => {
    const [c] = await attachKidClashes(reader, 'fam', [
      {
        title: 'Art',
        session: { startsAt: '2026-10-31T15:00:00.000Z', endsAt: '2026-10-31T16:00:00.000Z' },
      },
    ]);
    expect(c?.clashes).toEqual([]);
  });

  it('a find with only free-text when gets NO clashes field and no read', async () => {
    reads = 0;
    const [c] = await attachKidClashes(reader, 'fam', [
      { title: 'Art', when: 'Saturdays 10am' } as {
        title: string;
        when: string;
        session?: undefined;
      },
    ]);
    expect(c).not.toHaveProperty('clashes');
    expect(reads).toBe(0);
  });
});
