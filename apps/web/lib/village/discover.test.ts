import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  type DiscoverDeps,
  type DiscoveryAnthropicClient,
  discoverForFamily,
  selectDiscoveryInputs,
} from './discover.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

/** A fixed "now" so DOB → stage is deterministic across machines/dates. */
const NOW = new Date('2026-06-17T00:00:00Z');

// DOBs relative to NOW (2026-06): stage boundaries are [12, 48, 156] months.
const TODDLER_DOB = '2024-06-01'; // ~24mo → toddler
const CHILD_DOB = '2018-06-01'; // ~96mo → child
const TEEN_DOB = '2010-06-01'; // ~192mo → teenager

interface ChildRow {
  dateOfBirth: string;
  interests: string[];
}

interface InsertCapture {
  villageCandidates: unknown[];
  auditLog: unknown[];
}

/**
 * Fakes the exact Drizzle chains discoverForFamily runs, with NO real db:
 *   1. select(area).from(families).where().limit(1)  → [{ areaCoarse }]
 *   2. select(...).from(children).where()            → child rows
 *   3. transaction(cb) where tx.insert(table).values(rows) captures by table.
 * The table object identity is used to route captured inserts.
 */
function fakeDb(args: {
  areaCoarse: string | null;
  children: ChildRow[];
  capture: InsertCapture;
}) {
  let selectCall = 0;

  const select = vi.fn().mockImplementation(() => {
    const call = selectCall++;
    if (call === 0) {
      // families lookup: .from().where().limit() → [{ areaCoarse }]. The family
      // row always exists in these tests (a missing family is a thrown error,
      // not a tested path); areaCoarse may be null to exercise the no_area branch.
      return {
        from: () => ({
          where: () => ({
            limit: async () => [{ areaCoarse: args.areaCoarse }],
          }),
        }),
      };
    }
    // children lookup: .from().where() → rows (no .limit)
    return {
      from: () => ({
        where: async () => args.children,
      }),
    };
  });

  function tableName(table: unknown): keyof InsertCapture | null {
    if (table === schema.villageCandidates) return 'villageCandidates';
    if (table === schema.auditLog) return 'auditLog';
    return null;
  }

  const tx = {
    insert: (table: unknown) => ({
      values: async (rows: unknown) => {
        const name = tableName(table);
        if (!name) throw new Error('unexpected insert target');
        const list = Array.isArray(rows) ? rows : [rows];
        args.capture[name].push(...list);
      },
    }),
  };

  const transaction = vi.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => {
    return cb(tx);
  });

  // families needs an areaCoarse=null row to exist for the no_area path; an
  // absent family row is a thrown error, so we always return one row when
  // areaCoarse is provided OR explicitly null (vs. a truly missing family).
  return { select, transaction } as never;
}

/** A fake Anthropic client returning a forced submit_candidates tool_use. */
function fakeClient(candidates: unknown[]) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_candidates', input: { candidates } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  const client = { messages: { create } } as unknown as DiscoveryAnthropicClient;
  return { client, create };
}

function deps(client: DiscoveryAnthropicClient): DiscoverDeps {
  return {
    client,
    loadPrompt: async () => 'DISCOVERY SYSTEM PROMPT',
    loadModel: async () => 'claude-test-model',
  };
}

const SAMPLE_CANDIDATES = [
  {
    title: 'Parent-and-tot swim',
    description: 'A water-comfort class for toddlers at a municipal pool.',
    confidence: 0.65,
    coverageNote: 'municipal pools commonly offer this; sessions are seasonal.',
  },
  {
    title: 'Neighbourhood park and playground',
    description: 'Unstructured outdoor play at a local park.',
    sourceUrl: 'https://example.org/park',
    confidence: 0.8,
    coverageNote: 'public parks exist in essentially every area.',
  },
];

describe('selectDiscoveryInputs — teen exclusion (rule #1)', () => {
  it('drops teenagers, keeps non-teen stages childhood-ordered and deduped', () => {
    const { stages, interests } = selectDiscoveryInputs(
      [
        { dateOfBirth: CHILD_DOB, interests: ['soccer'] },
        { dateOfBirth: TODDLER_DOB, interests: ['water', 'soccer'] },
        { dateOfBirth: TEEN_DOB, interests: ['driving'] },
      ],
      NOW,
    );

    expect(stages).toEqual(['toddler', 'child']);
    // The teen's "driving" interest must NOT enter the pool.
    expect(interests).not.toContain('driving');
    expect([...interests].sort()).toEqual(['soccer', 'water']);
  });

  it('returns no stages for a teen-only family', () => {
    const { stages } = selectDiscoveryInputs([{ dateOfBirth: TEEN_DOB, interests: ['x'] }], NOW);
    expect(stages).toEqual([]);
  });
});

describe('discoverForFamily', () => {
  it('inserts candidates scoped to the family with the right shape + ONE audit row', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const result = await discoverForFamily(FAMILY_ID, db, deps(c.client));

    expect(result).toEqual({ status: 'discovered', insertedCount: 2 });

    // Exactly one model call (spend bound).
    expect(c.create).toHaveBeenCalledTimes(1);

    // Candidate insert shape: family-scoped, child-agnostic, honest source/kind.
    expect(capture.villageCandidates).toEqual([
      expect.objectContaining({
        familyId: FAMILY_ID,
        childId: null,
        title: 'Parent-and-tot swim',
        kind: 'activity',
        summary: 'A water-comfort class for toddlers at a municipal pool.',
        source: 'llm_only',
        confidence: 0.65,
        coverageNote: 'municipal pools commonly offer this; sessions are seasonal.',
      }),
      expect.objectContaining({
        familyId: FAMILY_ID,
        childId: null,
        title: 'Neighbourhood park and playground',
        kind: 'activity',
        sourceUrl: 'https://example.org/park',
      }),
    ]);

    // Rule #6: exactly one immutable audit row for the discovery transition.
    expect(capture.auditLog).toEqual([
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: 'system',
        actionTaken: 'village.discovery.recorded',
        targetTable: 'village_candidates',
        after: { areaCoarse: 'L7G', provider: 'llm_only', count: 2 },
      }),
    ]);
  });

  it('passes the model ONLY the coarse area + stage + interests — no precise location, no DOB', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    const sentUser = c.create.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    const sent = JSON.parse(sentUser);
    // Only the coarse area + stage + interests + limit reach the model.
    expect(sent).toEqual({
      area_coarse: 'L7G',
      stage: 'toddler',
      interests: ['water'],
      limit: 8,
    });
    // The full postal code / DOB must never be in the request payload.
    expect(sentUser).not.toContain(TODDLER_DOB);
    expect(sentUser).not.toContain(FAMILY_ID);
  });

  it('never stores a precise location: no row field carries the child DOB or a finer area', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    // A model that tries to smuggle a precise address into a candidate still only
    // populates the coarse columns the row schema has — there is no precise-
    // location column to write to.
    const c = fakeClient([
      {
        title: '123 Main St toddler swim',
        description: 'at 123 Main Street',
        confidence: 0.5,
        coverageNote: 'serves your area',
      },
    ]);

    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    for (const row of capture.villageCandidates as Record<string, unknown>[]) {
      // The persisted row has exactly the coarse village_candidates columns —
      // no latitude/longitude/address field exists to leak a precise location.
      expect(Object.keys(row).sort()).toEqual(
        [
          'childId',
          'confidence',
          'coverageNote',
          'familyId',
          'kind',
          'source',
          'sourceUrl',
          'summary',
          'title',
        ].sort(),
      );
      expect(row).not.toHaveProperty('dateOfBirth');
    }
  });

  it('returns no_area and does NOT call the model when the family has no coarse area', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [] };
    const db = fakeDb({ areaCoarse: null, children: [], capture });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const result = await discoverForFamily(FAMILY_ID, db, deps(c.client));

    expect(result).toEqual({ status: 'no_area' });
    expect(c.create).not.toHaveBeenCalled();
    expect(capture.villageCandidates).toEqual([]);
    expect(capture.auditLog).toEqual([]);
  });

  it('returns no_non_teen_children (no spend) for a teen-only family', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TEEN_DOB, interests: ['driving'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const result = await discoverForFamily(FAMILY_ID, db, deps(c.client));

    expect(result).toEqual({ status: 'no_non_teen_children' });
    expect(c.create).not.toHaveBeenCalled();
    expect(capture.villageCandidates).toEqual([]);
  });
});
