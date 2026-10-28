import { describe, expect, it } from 'vitest';
import { dutyNightFacts } from './asks';
import type { CadenceLine, DutyOccasion } from './cadence';
import { dutyNightRefusals } from './night-compose';

describe('duty night refusals', () => {
  it('refuses an empty draft and any link', () => {
    expect(dutyNightRefusals('  ')).toEqual(['empty']);
    expect(dutyNightRefusals('See https://evil.example/phish')).toEqual(['other_link']);
  });

  it('does not score wording', () => {
    expect(dutyNightRefusals('Sam has the swim. It is booked.')).toEqual([]);
  });
});

function occasion(over: Partial<DutyOccasion> = {}): DutyOccasion {
  return {
    eventKey: 'evt-swim',
    role: 'pickup',
    startsAt: new Date('2026-09-28T19:00:00.000Z'),
    hasOwner: true,
    conflict: false,
    needsWhichKid: false,
    cancelled: false,
    hasDutyRecord: true,
    reasked: false,
    source: 'calendar',
    spokenName: 'Sam',
    kid: null,
    eventLabel: 'swim',
    ...over,
  };
}

function line(
  mode: CadenceLine['mode'],
  eventKey: string,
  role: DutyOccasion['role'],
): CadenceLine {
  return {
    mode,
    eventKey,
    role,
    opensQuestion: mode === 'reask_48h',
    namesSilentParent: mode === 'silent_parent',
    discretionary: true,
  };
}

describe('duty night facts', () => {
  const ctx = {
    now: new Date('2026-09-27T23:00:00.000Z'),
    timeZone: 'America/Toronto',
    language: 'fr' as const,
    occasions: [occasion()],
    parentIds: ['p1', 'p2'],
    parentNames: { p1: 'Sam', p2: 'Barton' },
    childFirstNames: ['Maya'],
    speakerName: null,
    open: null,
  };

  it('passes the handoff and leaves a nameless child unnamed', () => {
    const facts = dutyNightFacts([line('night_before', 'evt-swim', 'pickup')], ctx);
    expect(facts).toMatchObject({
      language: 'fr',
      handoff: { name: 'Sam', kid: null, event: 'swim', time: '3:00pm' },
      unowned: null,
      quiet: null,
    });
    expect(facts?.handoff?.date).toContain('September');
  });

  it('passes an unowned event on the same note', () => {
    const piano = occasion({
      eventKey: 'evt-piano',
      role: 'dropoff',
      spokenName: null,
      hasOwner: false,
      eventLabel: 'piano',
      kid: 'Maya',
      startsAt: new Date('2026-09-29T14:00:00.000Z'),
    });
    const facts = dutyNightFacts(
      [line('night_before', 'evt-swim', 'pickup'), line('reask_48h', 'evt-piano', 'dropoff')],
      { ...ctx, occasions: [occasion(), piano] },
    );
    expect(facts?.unowned).toEqual({
      kid: 'Maya',
      event: 'piano',
      day: 'Tuesday',
      time: '10:00am',
    });
  });
});
