import { describe, expect, it } from 'vitest';
import { kidClashFacts } from './kid-clash';
import type { CalendarBlockView, ScheduleEvent } from './tools';

// A fake test family: one kid (Maya) with Saturday swim, plus a parent's own Google block.
const MAYA = '00000000-0000-4000-8000-00000000a001';
const at = (iso: string) => new Date(iso);

function event(
  title: string,
  start: string,
  end: string | null,
  childId: string | null = MAYA,
): ScheduleEvent {
  return {
    eventId: `ev-${title}`,
    title,
    startsAt: at(start),
    endsAt: end ? at(end) : null,
    location: null,
    childId,
    source: 'channel',
    teen: false,
    sensitive: false,
  };
}
function block(title: string | null, start: string, end: string | null): CalendarBlockView {
  return { startsAt: at(start), endsAt: end ? at(end) : null, allDay: false, title };
}

const SWIM = event('Saturday swim', '2026-10-31T14:00:00.000Z', '2026-10-31T15:00:00.000Z');

describe('kidClashFacts (VIL-79)', () => {
  it('a Saturday class that overlaps a kid event is a clash fact', () => {
    const facts = kidClashFacts(
      { startsAt: at('2026-10-31T14:30:00.000Z'), endsAt: at('2026-10-31T15:30:00.000Z') },
      [SWIM],
      [],
    );
    expect(facts).toEqual([
      {
        childId: MAYA,
        what: 'Saturday swim',
        startsAt: '2026-10-31T14:00:00.000Z',
        endsAt: '2026-10-31T15:00:00.000Z',
        allDay: false,
      },
    ]);
  });

  it('a start with no end inside a kid span is a clash; no end is ever invented', () => {
    expect(
      kidClashFacts({ startsAt: at('2026-10-31T14:30:00.000Z'), endsAt: null }, [SWIM], []),
    ).toHaveLength(1);
    const point = event('Pickup', '2026-10-31T14:30:00.000Z', null);
    expect(
      kidClashFacts({ startsAt: at('2026-10-31T14:30:00.000Z'), endsAt: null }, [point], []),
    ).toEqual([]);
  });

  it('back-to-back or no overlap gives no clash', () => {
    const backToBack = {
      startsAt: at('2026-10-31T15:00:00.000Z'),
      endsAt: at('2026-10-31T16:00:00.000Z'),
    };
    expect(kidClashFacts(backToBack, [SWIM], [])).toEqual([]);
    expect(
      kidClashFacts({ startsAt: at('2026-10-31T15:00:00.000Z'), endsAt: null }, [SWIM], []),
    ).toEqual([]);
    const later = {
      startsAt: at('2026-10-31T18:00:00.000Z'),
      endsAt: at('2026-10-31T19:00:00.000Z'),
    };
    expect(kidClashFacts(later, [SWIM], [])).toEqual([]);
  });

  it('an adult Google block never surfaces, even when it overlaps', () => {
    const adult = block(null, '2026-10-31T14:00:00.000Z', '2026-10-31T16:00:00.000Z');
    const facts = kidClashFacts(
      { startsAt: at('2026-10-31T14:30:00.000Z'), endsAt: at('2026-10-31T15:30:00.000Z') },
      [],
      [adult],
    );
    expect(facts).toEqual([]);
  });

  it('a kid-judged Google block does surface', () => {
    const kid = block(
      'Maya birthday party',
      '2026-10-31T14:00:00.000Z',
      '2026-10-31T16:00:00.000Z',
    );
    const facts = kidClashFacts(
      { startsAt: at('2026-10-31T15:00:00.000Z'), endsAt: null },
      [],
      [kid],
    );
    expect(facts.map((f) => f.what)).toEqual(['Maya birthday party']);
  });

  it('a moved event never clashes with itself', () => {
    expect(
      kidClashFacts(
        {
          startsAt: at('2026-10-31T14:30:00.000Z'),
          endsAt: at('2026-10-31T15:30:00.000Z'),
          eventId: SWIM.eventId,
        },
        [SWIM],
        [],
      ),
    ).toEqual([]);
  });
});
