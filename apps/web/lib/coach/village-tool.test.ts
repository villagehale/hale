import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAskHaleTools } from './tools';

/**
 * search_village must recall only the CURRENT, in-season, unexpired discovery run:
 * a superseded/replaced pick, a past one-time event, and an out-of-season seasonal
 * activity must never surface to Ask Hale (they'd otherwise send a parent to a
 * class that already happened or a camp that isn't running).
 *
 * On top of that it must only OFFER what it can name in full. A candidate reaches
 * the model as an offer only when its venue and its date are both real fields on
 * the row; anything short of that is a COUNT, never a described maybe. That is
 * the structural half of "a chief of staff never hands a parent a half-find" —
 * the model cannot hedge about a candidate it was never shown.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-04T12:00:00Z'); // fresh summer weekday

function fakeDb(
  candidates: Array<Record<string, unknown>>,
  children: Array<Record<string, unknown>> = [],
) {
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
        if (table === schema.children) return build(children);
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

/** A fully offerable row by default — venue AND date present, both in the future. A
 * test that wants the unverified shape drops one of them explicitly. */
function candidate(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    childId: null,
    kind: 'class',
    summary: 'a warm local option',
    cadence: 'one-time',
    seasons: null,
    eventDate: '2026-07-11',
    venueName: 'Wychwood Barns',
    supersededAt: null,
    discoveredAt: NOW,
    ...overrides,
  };
}

interface VillageToolResult {
  candidates: Array<{ title: string; venue: string; when: string }>;
  inVerification: number;
}

async function search(
  candidates: Array<Record<string, unknown>>,
  children: Array<Record<string, unknown>> = [],
): Promise<VillageToolResult> {
  return (await invokeTool(
    toolByName(fakeDb(candidates, children), 'search_village'),
    {},
    { familyId: FAMILY_ID, actor: 'user-1' },
    guardDeps,
  )) as VillageToolResult;
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
      candidate({ id: 'past', title: 'Past workshop', eventDate: '2026-07-03' }),
      candidate({
        id: 'winter',
        title: 'Winter skating camp',
        cadence: 'seasonal',
        seasons: ['winter'],
        eventDate: null,
      }),
    ];

    const result = await search(candidates);

    expect(result.candidates.map((c) => c.title)).toEqual(['EarlyON drop-in']);
  });
});

/**
 * The offer boundary (founder, launch day: "you find a legit activity but not able
 * to verify the location and time"). The model hedged because the tool handed it a
 * title and a blurb and nothing else — it could not name a place or a day without
 * inventing one, and its own honesty rules then made it say so out loud. The fix is
 * structural: only a candidate carrying both fields is describable at all.
 */
describe('search_village — offers only what it can name in full', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries the verified venue and a family-readable day onto each offer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await search([
      candidate({
        id: 'storytime',
        title: 'Central Library story time',
        venueName: 'Bloor/Gladstone branch',
        eventDate: '2026-07-11',
      }),
    ]);

    expect(result.candidates).toEqual([
      expect.objectContaining({
        title: 'Central Library story time',
        venue: 'Bloor/Gladstone branch',
        // 2026-07-11 is a Saturday. Rendered in UTC so a bare calendar day never
        // slips back to the Friday for a family west of it.
        when: 'Sat, Jul 11',
      }),
    ]);
    expect(result.inVerification).toBe(0);
  });

  it('withholds a candidate missing a venue or a date, and counts it instead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await search([
      candidate({ id: 'ok', title: 'Riverdale Farm visit' }),
      candidate({ id: 'no-venue', title: 'Somewhere sunny', venueName: null }),
      candidate({ id: 'blank-venue', title: 'Geocode missed', venueName: '  ' }),
      candidate({ id: 'no-date', title: 'Sometime soon', eventDate: null, cadence: 'ongoing' }),
    ]);

    expect(result.candidates.map((c) => c.title)).toEqual(['Riverdale Farm visit']);
    expect(result.inVerification).toBe(3);
  });

  it('leaves a teen-attributed candidate out of BOTH the offers and the count (rule #1)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    // 16 at NOW → teenager by the @hale/types boundary, derived from DOB.
    const teen = { id: 'kid-teen', dateOfBirth: '2010-03-04' };

    const result = await search(
      [
        candidate({ id: 'ok', title: 'Riverdale Farm visit' }),
        candidate({ id: 'teen-row', title: 'Climbing gym', childId: teen.id }),
      ],
      [teen],
    );

    // The teen row is redacted to a placeholder with no venue and no date, so it can
    // never be offered — and it is not "in verification" either. Counting it would
    // have Hale promise to come back about a find it may never mention.
    expect(result.candidates.map((c) => c.title)).toEqual(['Riverdale Farm visit']);
    expect(result.inVerification).toBe(0);
  });
});
