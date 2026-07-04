import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAskHaleTools } from './tools';

/**
 * search_village must recall only the CURRENT, in-season, unexpired discovery run:
 * a superseded/replaced pick, a past one-time event, and an out-of-season seasonal
 * activity must never surface to Ask Hale (they'd otherwise send a parent to a
 * class that already happened or a camp that isn't running).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-04T12:00:00Z'); // fresh summer weekday

function fakeDb(candidates: Array<Record<string, unknown>>) {
  const build = (rows: unknown[]) => {
    const whereResult = Object.assign(Promise.resolve(rows), {
      limit: async () => rows,
      orderBy: () => ({ limit: async () => rows }),
    });
    const chain = { where: () => whereResult, innerJoin: () => chain };
    return chain;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.children) return build([]);
        if (table === schema.villageCandidates) return build(candidates);
        return build([]);
      },
    }),
  };
  return db as unknown as import('@hale/db').Database;
}

function toolByName(database: import('@hale/db').Database, name: string) {
  const tool = buildAskHaleTools(database).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

const guardDeps: GuardDeps = { writeAudit: async () => {} };

function candidate(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    childId: null,
    kind: 'class',
    summary: 'a warm local option',
    cadence: 'ongoing',
    seasons: null,
    eventDate: null,
    supersededAt: null,
    discoveredAt: NOW,
    ...overrides,
  };
}

describe('search_village — recalls only the current, in-season, unexpired run', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a superseded, a past one-time, and an out-of-season seasonal candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const candidates = [
      candidate({ id: 'live', title: 'EarlyON drop-in' }),
      candidate({ id: 'superseded', title: 'Replaced pick', supersededAt: new Date('2026-07-03T12:00:00Z') }),
      candidate({ id: 'past', title: 'Past workshop', cadence: 'one-time', eventDate: '2026-07-03' }),
      candidate({ id: 'winter', title: 'Winter skating camp', cadence: 'seasonal', seasons: ['winter'] }),
    ];

    const result = (await invokeTool(
      toolByName(fakeDb(candidates), 'search_village'),
      {},
      { familyId: FAMILY_ID, actor: 'user-1' },
      guardDeps,
    )) as { candidates: Array<{ title: string }> };

    expect(result.candidates.map((c) => c.title)).toEqual(['EarlyON drop-in']);
  });
});
