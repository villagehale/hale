import type { AgentClient } from '@hale/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dutyNightFacts } from './asks';
import type { CadenceLine, DutyOccasion } from './cadence';
import {
  type DutyNightFacts,
  checkDutyNight,
  composeDutyNight,
  dutyNightRefusals,
} from './night-compose';

const forceToolJson = vi.hoisted(() => vi.fn());
vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: vi.fn(async (name: string) => ({
    meta: { task: name === 'duty-night-check' ? 'review' : 'speak' },
    instructions: name,
  })),
}));

const CLIENT = {} as AgentClient;
const NIGHT: DutyNightFacts = {
  language: 'en',
  now: { date: 'Sunday, September 27, 2026', time: '7:00pm' },
  handoff: {
    name: 'Sam',
    kid: 'Maya',
    event: 'swim',
    time: '3:00pm',
    endTime: '4:00pm',
    date: 'Monday, September 28, 2026',
    venue: { name: 'Pan Am Centre', address: '875 Morningside Ave' },
  },
  unowned: null,
  quiet: null,
};

beforeEach(() => forceToolJson.mockReset());

describe('duty night refusals', () => {
  it('refuses an empty draft and any link', () => {
    expect(dutyNightRefusals('  ')).toEqual(['empty']);
    expect(dutyNightRefusals('See https://evil.example/phish')).toEqual(['other_link']);
  });
});

describe('duty night fact check', () => {
  const booked = 'Sam has Maya at swim tomorrow 3 to 4pm, Pan Am Centre. It is booked.';
  const clean = 'Sam has Maya at swim tomorrow 3 to 4pm, Pan Am Centre, 875 Morningside Ave.';

  it('blocks a draft the check says claims something the facts do not', async () => {
    const check = vi.fn(async () => ({ supported: false, unsupported: ['booked'] }));
    forceToolJson.mockResolvedValue({ value: { text: booked } });
    await expect(composeDutyNight(CLIENT, NIGHT, 'fam', { check })).resolves.toBeNull();
    expect(check).toHaveBeenCalledWith(CLIENT, NIGHT, booked, 'fam');
  });

  it('sends a draft the check passes', async () => {
    const check = vi.fn(async () => ({ supported: true, unsupported: [] }));
    forceToolJson.mockResolvedValue({ value: { text: clean } });
    await expect(composeDutyNight(CLIENT, NIGHT, 'fam', { check })).resolves.toBe(clean);
  });

  it('sends a later draft that passes after one that did not', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ supported: false, unsupported: ['booked'] })
      .mockResolvedValueOnce({ supported: true, unsupported: [] });
    forceToolJson
      .mockResolvedValueOnce({ value: { text: booked } })
      .mockResolvedValueOnce({ value: { text: clean } });
    await expect(composeDutyNight(CLIENT, NIGHT, 'fam', { check })).resolves.toBe(clean);
  });

  it('fails closed when the check itself fails or contradicts itself', async () => {
    forceToolJson.mockRejectedValueOnce(new Error('timeout'));
    await expect(checkDutyNight(CLIENT, NIGHT, clean, 'fam')).resolves.toMatchObject({
      supported: false,
    });
    forceToolJson.mockResolvedValueOnce({ value: { supported: true, unsupported: ['booked'] } });
    await expect(checkDutyNight(CLIENT, NIGHT, booked, 'fam')).resolves.toMatchObject({
      supported: false,
    });
  });

  it('hands the check the facts and the draft', async () => {
    forceToolJson.mockResolvedValueOnce({ value: { supported: true, unsupported: [] } });
    await checkDutyNight(CLIENT, NIGHT, clean, 'fam');
    const call = forceToolJson.mock.calls[0]?.[0];
    expect(JSON.parse(call.userMessage)).toEqual({ facts: NIGHT, draft: clean });
    expect(call.toolName).toBe('duty_night_check');
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
    occasions: [occasion({ endsAt: new Date('2026-09-28T20:30:00.000Z') })],
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
      handoff: {
        name: 'Sam',
        kid: null,
        event: 'swim',
        time: '3:00pm',
        endTime: '4:30pm',
        venue: null,
      },
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
