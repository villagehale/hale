import { describe, expect, it, vi } from 'vitest';
import {
  handleDigestFanout,
  handleDiscoveryFanout,
  localIsoDate,
  weekMonday,
} from './retention-fanout.js';

const FAMILY_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

/** Fakes the single `select(...).from(families).where(...)` chain selectActiveFamilyIds runs. */
function fakeDb(ids: string[]) {
  const where = vi.fn().mockResolvedValue(ids.map((id) => ({ id })));
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as never;
}

function makeDeps(ids: string[], now: Date) {
  return {
    boss: { send: vi.fn().mockResolvedValue('job-id') },
    database: fakeDb(ids),
    log: { info: vi.fn() },
    now: () => now,
  };
}

describe('localIsoDate / weekMonday (America/Toronto)', () => {
  it('derives the local ISO date, crossing the day boundary in Toronto', () => {
    // 2026-06-17T03:00:00Z is 2026-06-16 23:00 EDT — still the 16th locally.
    expect(localIsoDate(new Date('2026-06-17T03:00:00.000Z'))).toBe('2026-06-16');
    expect(localIsoDate(new Date('2026-06-17T16:00:00.000Z'))).toBe('2026-06-17');
  });

  it('snaps to the Monday of the local week', () => {
    // 2026-06-17 is a Wednesday → Monday is 2026-06-15.
    expect(weekMonday(new Date('2026-06-17T16:00:00.000Z'))).toBe('2026-06-15');
    // 2026-06-15 (Monday) → itself.
    expect(weekMonday(new Date('2026-06-15T16:00:00.000Z'))).toBe('2026-06-15');
    // 2026-06-21 (Sunday) → still the same week's Monday, 2026-06-15.
    expect(weekMonday(new Date('2026-06-21T16:00:00.000Z'))).toBe('2026-06-15');
  });
});

describe('handleDigestFanout', () => {
  it('enqueues one digest.daily.due per active family with today’s digestDate', async () => {
    const deps = makeDeps(FAMILY_IDS, new Date('2026-06-17T16:00:00.000Z'));

    await handleDigestFanout(deps);

    expect(deps.boss.send).toHaveBeenCalledTimes(3);
    for (const familyId of FAMILY_IDS) {
      expect(deps.boss.send).toHaveBeenCalledWith('digest.daily.due', {
        familyId,
        digestDate: '2026-06-17',
      });
    }
  });

  it('enqueues nothing when there are no active families', async () => {
    const deps = makeDeps([], new Date('2026-06-17T16:00:00.000Z'));

    await handleDigestFanout(deps);

    expect(deps.boss.send).not.toHaveBeenCalled();
  });
});

describe('handleDiscoveryFanout', () => {
  it('enqueues one village.discovery.due per active family with the week’s Monday', async () => {
    const deps = makeDeps(FAMILY_IDS, new Date('2026-06-17T16:00:00.000Z'));

    await handleDiscoveryFanout(deps);

    expect(deps.boss.send).toHaveBeenCalledTimes(3);
    for (const familyId of FAMILY_IDS) {
      expect(deps.boss.send).toHaveBeenCalledWith('village.discovery.due', {
        familyId,
        weekOf: '2026-06-15',
      });
    }
  });
});
