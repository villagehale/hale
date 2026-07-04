import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRankTools } from './rank-tools';

/**
 * The ranking tools are READ-ONLY signal providers, but they still run through the
 * guarded invoker (an audit row per call, rule #6) and must be teen-safe BY
 * CONSTRUCTION (rule #1): a teen-attributed candidate reaches the model
 * category-only, and the endorsement signal is a COUNT, never a family identity.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TODDLER_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';

const TODDLER_DOB = '2024-06-01'; // ~24mo → toddler (vs a fixed-ish "now")
const TEEN_DOB = '2010-06-01'; // ~16y → teenager

/** Minimal db serving the reads each tool runs, routed by table identity. */
function fakeDb(args: {
  children: Array<{ id: string; dateOfBirth: string }>;
  candidates: Array<Record<string, unknown>>;
}) {
  const build = (rows: unknown[]) => {
    // `.where()` is both awaitable (the children/families/facts reads await it
    // directly) AND chainable into .limit/.orderBy/.groupBy (the candidate read).
    // `.innerJoin()` is chainable so the timezone read's join resolves.
    const whereResult = Object.assign(Promise.resolve(rows), {
      limit: async () => rows.slice(0, 1),
      orderBy: () => ({ limit: async () => rows }),
      groupBy: async () => rows,
    });
    const chain = { where: () => whereResult, innerJoin: () => chain };
    return chain;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.children) return build(args.children);
        if (table === schema.villageCandidates) return build(args.candidates);
        if (table === schema.villageEndorsements) return build([]);
        return build([]);
      },
    }),
  };
  return db as unknown as import('@hale/db').Database;
}

/** Guard deps that capture audit writes; no monetary / child-content gates fire
 * because these tools are not monetary and name no childId. */
function captureGuardDeps(audits: Array<{ actionTaken: string }>): GuardDeps {
  return {
    writeAudit: async (entry) => {
      audits.push({ actionTaken: entry.actionTaken });
    },
  };
}

function toolByName(database: import('@hale/db').Database, name: string) {
  const tool = buildRankTools(database).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe('list_village_candidates — teen-safe by construction (rule #1)', () => {
  // The tool visibility-filters against the wall clock, so pin it to the fixtures'
  // discovery day to keep both rows in the current, unexpired run.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('redacts a teen-attributed candidate to category only and audits the read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T12:00:00Z'));
    const candidates = [
      {
        id: 'cand-toddler',
        childId: TODDLER_ID,
        title: 'Storytime at the library',
        kind: 'class',
        summary: 'A gentle weekly drop-in.',
        cadence: 'ongoing',
        seasons: null,
        eventDate: null,
        coverageNote: 'serves your area',
        sourceUrl: null,
        supersededAt: null,
        discoveredAt: new Date('2026-07-04T12:00:00Z'),
      },
      {
        id: 'cand-teen',
        childId: TEEN_ID,
        title: 'A teen-only program with sensitive details',
        kind: 'program',
        summary: 'raw teen content that must not leak',
        cadence: 'ongoing',
        seasons: null,
        eventDate: null,
        coverageNote: 'serves your area',
        sourceUrl: null,
        supersededAt: null,
        discoveredAt: new Date('2026-07-04T12:00:00Z'),
      },
    ];
    const db = fakeDb({
      children: [
        { id: TODDLER_ID, dateOfBirth: TODDLER_DOB },
        { id: TEEN_ID, dateOfBirth: TEEN_DOB },
      ],
      candidates,
    });
    const audits: Array<{ actionTaken: string }> = [];

    const result = (await invokeTool(
      toolByName(db, 'list_village_candidates'),
      {},
      { familyId: FAMILY_ID, actor: 'system' },
      captureGuardDeps(audits),
    )) as { candidates: Array<{ id: string; title: string; summary: string; teenAttributed: boolean }> };

    const teen = result.candidates.find((c) => c.id === 'cand-teen');
    const toddler = result.candidates.find((c) => c.id === 'cand-toddler');

    // The teen candidate is redacted: its raw title/summary never reach the model.
    expect(teen?.teenAttributed).toBe(true);
    expect(teen?.title).not.toContain('sensitive');
    expect(teen?.summary).toBe('');
    // The non-teen candidate is surfaced in full so it can be ranked.
    expect(toddler?.teenAttributed).toBe(false);
    expect(toddler?.title).toBe('Storytime at the library');

    // Rule #6: the read was audited.
    expect(audits).toEqual([{ actionTaken: 'tool:list_village_candidates' }]);
  });
});

describe('get_family_fit_context — excludes teens from the fit signal (rule #1)', () => {
  it('derives non-teen stages only', async () => {
    const db = fakeDb({
      children: [
        { id: TODDLER_ID, dateOfBirth: TODDLER_DOB },
        { id: TEEN_ID, dateOfBirth: TEEN_DOB },
      ],
      candidates: [],
    });
    const audits: Array<{ actionTaken: string }> = [];

    const result = (await invokeTool(
      toolByName(db, 'get_family_fit_context'),
      {},
      { familyId: FAMILY_ID, actor: 'system' },
      captureGuardDeps(audits),
    )) as { childStages: string[] };

    expect(result.childStages).toContain('toddler');
    expect(result.childStages).not.toContain('teenager');
  });
});

describe('list_village_candidates — only surfaces the current, in-season, unexpired run', () => {
  // A fixed "now": a fresh summer weekday (season = summer), matching the
  // visibility test fixtures so the season/date gates are deterministic.
  const NOW = new Date('2026-07-04T12:00:00Z');
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a superseded, a past one-time, and an out-of-season seasonal candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const candidates = [
      {
        id: 'live-ongoing',
        childId: TODDLER_ID,
        title: 'EarlyON drop-in',
        kind: 'drop_in',
        summary: 'A warm weekday drop-in.',
        cadence: 'ongoing',
        seasons: null,
        eventDate: null,
        supersededAt: null,
        discoveredAt: NOW,
      },
      {
        id: 'superseded',
        childId: TODDLER_ID,
        title: 'Replaced by a newer run',
        kind: 'class',
        summary: 'stale',
        cadence: 'ongoing',
        seasons: null,
        eventDate: null,
        supersededAt: new Date('2026-07-03T12:00:00Z'),
        discoveredAt: NOW,
      },
      {
        id: 'past-onetime',
        childId: TODDLER_ID,
        title: 'A workshop that already happened',
        kind: 'event',
        summary: 'over',
        cadence: 'one-time',
        seasons: null,
        eventDate: '2026-07-03',
        supersededAt: null,
        discoveredAt: NOW,
      },
      {
        id: 'winter-camp',
        childId: TODDLER_ID,
        title: 'Winter skating camp',
        kind: 'class',
        summary: 'out of season',
        cadence: 'seasonal',
        seasons: ['winter'],
        eventDate: null,
        supersededAt: null,
        discoveredAt: NOW,
      },
    ];
    const db = fakeDb({
      children: [{ id: TODDLER_ID, dateOfBirth: TODDLER_DOB }],
      candidates,
    });
    const audits: Array<{ actionTaken: string }> = [];

    const result = (await invokeTool(
      toolByName(db, 'list_village_candidates'),
      {},
      { familyId: FAMILY_ID, actor: 'system' },
      captureGuardDeps(audits),
    )) as { candidates: Array<{ id: string }> };

    expect(result.candidates.map((c) => c.id)).toEqual(['live-ongoing']);
  });
});
