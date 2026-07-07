import { schema, type Database } from '@hale/db';
import { GuardrailError, defineTool, invokeTool } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildGuardDeps } from './guards';
import { buildConciergeTools } from './tools';

/**
 * The guard rails + family-scoping, exercised through the REAL GuardDeps and the
 * REAL tool handlers against a focused fake db. These are the hard rules made
 * mechanical: every tool call audits (rule #6), a monetary tool over the cap
 * throws (rule #7), a teenager's profile is refused (rule #1/#5), and a tool only
 * ever touches the caller's family (rule #1). The harness loop itself is covered
 * in packages/agent; here we assert the wiring the web call site provides.
 *
 * The fake db serves a QUEUE of result-sets per table (FIFO), so each test states
 * exactly what the (family, child)-scoped children lookup returns — an empty
 * result models a child that isn't in the caller's family, which is how Postgres
 * fails closed for a cross-family request.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

const TEEN_DOB = '2010-06-01'; // teenager regardless of exact run date
const TODDLER_DOB = '2024-06-01'; // toddler regardless of exact run date

interface ChildRow {
  id: string;
  name: string;
  dateOfBirth: string;
  gestationalWeeks: number | null;
  parentingStyleOverrides: Record<string, unknown>;
}

interface FactRow {
  childId: string | null;
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
}

interface EpisodeRow {
  childId: string | null;
  occurredAt: Date;
  episodeType: string;
  summary: string;
}

interface FakeDbState {
  /** FIFO queue of children-select results — one entry consumed per children query. */
  childrenResults: ChildRow[][];
  /** Rows the memory_facts / memory_episodes selects return (search_memory). */
  facts: FactRow[];
  episodes: EpisodeRow[];
  audits: unknown[];
  insertedFacts: unknown[];
}

function fakeDb(state: FakeDbState): Database {
  const nextChildren = () => state.childrenResults.shift() ?? [];

  const rowsForTable = (table: unknown): unknown[] => {
    if (table === schema.children) return nextChildren();
    if (table === schema.familyMemoryFacts) return state.facts;
    if (table === schema.familyMemoryEpisodes) return state.episodes;
    return [];
  };

  const db = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          const rows = rowsForTable(table);
          return Object.assign(Promise.resolve(rows), {
            limit: async (n?: number) => (n === 1 ? rows.slice(0, 1) : rows),
            orderBy: () =>
              Object.assign(Promise.resolve(rows), { limit: async () => rows }),
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        if (table === schema.auditLog) {
          state.audits.push(rows);
          return Promise.resolve(undefined);
        }
        if (table === schema.familyMemoryFacts) {
          state.insertedFacts.push(rows);
          return { returning: async () => [{ id: 'fact-new' }] };
        }
        throw new Error('unexpected insert target');
      },
    }),
    update: (_table: unknown) => ({
      set: () => ({ where: async () => undefined }),
    }),
  };
  return db as unknown as Database;
}

function toolByName(db: Database, name: string) {
  const tool = buildConciergeTools(db).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

function emptyState(): FakeDbState {
  return { childrenResults: [], facts: [], episodes: [], audits: [], insertedFacts: [] };
}

describe('Concierge guard rails + family scoping', () => {
  it('writes an audit row for every tool call (rule #6)', async () => {
    const state = emptyState();
    // The teen guard's children lookup, then the handler's children lookup.
    const toddler: ChildRow = {
      id: 'kid-1',
      name: 'Mei',
      dateOfBirth: TODDLER_DOB,
      gestationalWeeks: 40,
      parentingStyleOverrides: {},
    };
    state.childrenResults = [[toddler], [toddler]];
    const db = fakeDb(state);

    await invokeTool(
      toolByName(db, 'get_child_profile'),
      { childId: 'kid-1' },
      { familyId: FAMILY_ID, actor: 'user-1' },
      buildGuardDeps(db),
    );

    expect(state.audits).toEqual([
      {
        familyId: FAMILY_ID,
        actor: 'user-1',
        actionTaken: 'tool:get_child_profile',
        after: { childId: 'kid-1' },
      },
    ]);
  });

  it("refuses a teenager's profile and NEVER runs the handler (rule #1/#5)", async () => {
    const state = emptyState();
    // The teen guard's children lookup returns the teen → refusal before the handler.
    state.childrenResults = [
      [
        {
          id: 'teen-1',
          name: 'Noa',
          dateOfBirth: TEEN_DOB,
          gestationalWeeks: null,
          parentingStyleOverrides: {},
        },
      ],
    ];
    const db = fakeDb(state);

    await expect(
      invokeTool(
        toolByName(db, 'get_child_profile'),
        { childId: 'teen-1' },
        { familyId: FAMILY_ID, actor: 'user-1' },
        buildGuardDeps(db),
      ),
    ).rejects.toBeInstanceOf(GuardrailError);

    // Refused at the gate → no audit row, no handler side effect (rule #1).
    expect(state.audits).toEqual([]);
  });

  it('refuses a child not in the caller family — fails closed (rule #1)', async () => {
    const state = emptyState();
    // The family-scoped lookup returns nothing (child belongs to another family).
    state.childrenResults = [[]];
    const db = fakeDb(state);

    await expect(
      invokeTool(
        toolByName(db, 'get_child_profile'),
        { childId: 'kid-x' },
        { familyId: FAMILY_ID, actor: 'user-1' },
        buildGuardDeps(db),
      ),
    ).rejects.toThrow(/not found in this family/);

    expect(state.audits).toEqual([]);
  });

  it('blocks a monetary tool over the per-action cap and never audits (rule #7)', async () => {
    const state = emptyState();
    const db = fakeDb(state);
    const monetaryTool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      inputSchema: z.object({ amountUsd: z.number(), category: z.string() }),
      monetary: true,
      handler: async () => ({ ordered: true }),
    });

    await expect(
      invokeTool(
        monetaryTool,
        { amountUsd: 5000, category: 'supplies' },
        { familyId: FAMILY_ID, actor: 'user-1' },
        buildGuardDeps(db),
      ),
    ).rejects.toThrow(/exceeds per-action cap/);

    expect(state.audits).toEqual([]);
  });

  it('allows a monetary tool within the cap, audits it, and runs the handler (rule #6/#7)', async () => {
    const state = emptyState();
    const db = fakeDb(state);
    const monetaryTool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      inputSchema: z.object({ amountUsd: z.number(), category: z.string() }),
      monetary: true,
      handler: async () => ({ ordered: true }),
    });

    const result = await invokeTool(
      monetaryTool,
      { amountUsd: 12, category: 'supplies' },
      { familyId: FAMILY_ID, actor: 'user-1' },
      buildGuardDeps(db),
    );

    expect(result).toEqual({ ordered: true });
    expect(state.audits).toHaveLength(1);
  });

  it('search_memory excludes facts/episodes attributed to a teenager, keeps under-13 and family-wide (rule #1)', async () => {
    const state = emptyState();
    const teen: ChildRow = {
      id: 'teen-1',
      name: 'Noa',
      dateOfBirth: TEEN_DOB,
      gestationalWeeks: null,
      parentingStyleOverrides: {},
    };
    const toddler: ChildRow = {
      id: 'kid-1',
      name: 'Mei',
      dateOfBirth: TODDLER_DOB,
      gestationalWeeks: 40,
      parentingStyleOverrides: {},
    };
    // The handler's single teen-id lookup returns BOTH children.
    state.childrenResults = [[teen, toddler]];
    state.facts = [
      { childId: 'teen-1', factType: 'medical', factKey: 'teen-private', factValue: 'x', confidence: 1 },
      { childId: 'kid-1', factType: 'routine', factKey: 'nap', factValue: '1pm', confidence: 1 },
      { childId: null, factType: 'logistic', factKey: 'address', factValue: 'home', confidence: 1 },
    ];
    state.episodes = [
      { childId: 'teen-1', occurredAt: new Date('2026-06-01T12:00:00Z'), episodeType: 'note', summary: 'bedtime story for teen' },
      { childId: 'kid-1', occurredAt: new Date('2026-06-02T12:00:00Z'), episodeType: 'note', summary: 'bedtime story for toddler' },
    ];
    const db = fakeDb(state);

    const result = (await invokeTool(
      toolByName(db, 'search_memory'),
      { query: 'bedtime' },
      { familyId: FAMILY_ID, actor: 'user-1' },
      buildGuardDeps(db),
    )) as { facts: Array<{ factKey: string }>; episodes: Array<{ summary: string }> };

    expect(result.facts.map((f) => f.factKey)).toEqual(['nap', 'address']);
    expect(result.facts.map((f) => f.factKey)).not.toContain('teen-private');
    expect(result.episodes.map((e) => e.summary)).toEqual(['bedtime story for toddler']);
  });

  it('save_memory persists a family-scoped fact through the guarded invoker (rule #6)', async () => {
    const state = emptyState();
    const db = fakeDb(state);

    const result = await invokeTool(
      toolByName(db, 'save_memory'),
      { factType: 'routine', factKey: 'bedtime', factValue: '7:30pm' },
      { familyId: FAMILY_ID, actor: 'user-1' },
      buildGuardDeps(db),
    );

    expect(result).toEqual({ saved: true, factId: 'fact-new' });
    expect(state.insertedFacts).toEqual([
      expect.objectContaining({ familyId: FAMILY_ID, factType: 'routine', factKey: 'bedtime' }),
    ]);
    expect(state.audits).toHaveLength(1);
  });
});
