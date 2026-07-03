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
  agentRuns: Record<string, unknown>[];
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

  // The agent_runs telemetry insert runs at the top level (outside the candidate
  // transaction), so route it here by table identity.
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.agentRuns) {
      return {
        values: (row: Record<string, unknown>) => ({
          returning: async () => {
            args.capture.agentRuns.push(row);
            return [{ id: 'run-1' }];
          },
        }),
      };
    }
    throw new Error('unexpected insert target');
  });

  // families needs an areaCoarse=null row to exist for the no_area path; an
  // absent family row is a thrown error, so we always return one row when
  // areaCoarse is provided OR explicitly null (vs. a truly missing family).
  return { select, transaction, insert } as never;
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

function deps(
  client: DiscoveryAnthropicClient,
  geocode: DiscoverDeps['geocode'] = async () => null,
  geocodeArea: DiscoverDeps['geocodeArea'] = async () => null,
): DiscoverDeps {
  return {
    client,
    loadPrompt: async () => 'DISCOVERY SYSTEM PROMPT',
    loadModel: async () => 'claude-test-model',
    geocode,
    geocodeArea,
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
    sourceUrl: 'https://toronto.ca/parks',
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
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
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
        // No Places website in this test → the sane model url is kept.
        sourceUrl: 'https://toronto.ca/parks',
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

    // Exactly one agent_runs row, family-scoped, real model + token counts +
    // latency, marked completed (observability gap closed).
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('discovery');
    expect(run.modelUsed).toBe('claude-test-model');
    expect(run.promptTokens).toBe(10);
    expect(run.completionTokens).toBe(20);
    expect(typeof run.latencyMs).toBe('number');
    expect(run.status).toBe('completed');
  });

  it('records a FAILED agent_runs row and rethrows when the model returns no tool call (rule #8)', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    // The forced tool came back with only text — a failed discovery run that still
    // billed input/output tokens.
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'no.' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const client = { messages: { create } } as unknown as DiscoveryAnthropicClient;

    await expect(discoverForFamily(FAMILY_ID, db, deps(client))).rejects.toThrow(
      'submit_candidates',
    );

    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('discovery');
    expect(run.status).toBe('failed');
    // No candidates persisted on the failure path.
    expect(capture.villageCandidates).toEqual([]);
  });

  it('passes the model ONLY the coarse area + stage + interests — no precise location, no DOB', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
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

  it('never stores the family location: coords are PUBLIC venue only, no DOB/precise-home field', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        title: 'Toddler swim',
        description: 'a class at a municipal pool',
        confidence: 0.5,
        coverageNote: 'serves your area',
      },
    ]);
    // The geocode resolves a PUBLIC venue (a pool) — its location is a public
    // place, never the family's home. Capture what reaches Google to assert only
    // the coarse area is sent (rule #1).
    const geoCalls: Array<{ title: string; area: string }> = [];
    const geocode: DiscoverDeps['geocode'] = async (title, area) => {
      geoCalls.push({ title, area });
      return { lat: 43.6, lng: -79.4, venueName: 'Public Pool', venueAddress: '1 Pool Rd' };
    };

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode));

    for (const row of capture.villageCandidates as Record<string, unknown>[]) {
      // The persisted row carries exactly the village_candidates columns — the
      // lat/lng/venue columns hold the PUBLIC venue, and there is still NO column
      // for a child DOB or the precise family home (rule #1).
      expect(Object.keys(row).sort()).toEqual(
        [
          'childId',
          'confidence',
          'coverageNote',
          'familyId',
          'kind',
          'lat',
          'lng',
          'source',
          'sourceUrl',
          'summary',
          'title',
          'venueAddress',
          'venueName',
        ].sort(),
      );
      expect(row).not.toHaveProperty('dateOfBirth');
      // Coords are the public venue's, set from the geocode.
      expect(row.lat).toBe(43.6);
      expect(row.venueName).toBe('Public Pool');
    }

    // The geocode received ONLY the candidate title + the coarse area — no precise
    // location ever leaves the server (rule #1).
    expect(geoCalls).toEqual([{ title: 'Toddler swim', area: 'L7G' }]);
  });

  it('resolves the coarse-area centre ONCE and biases every venue lookup to it (rule #1)', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const center = { lat: 43.6285, lng: -79.9618 }; // coarse-area centre, not a home
    const areaCalls: string[] = [];
    const geocodeArea: DiscoverDeps['geocodeArea'] = async (area) => {
      areaCalls.push(area);
      return center;
    };
    const biasArgs: Array<unknown> = [];
    const geocode: DiscoverDeps['geocode'] = async (_title, _area, bias) => {
      biasArgs.push(bias);
      return null;
    };

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode, geocodeArea));

    // The coarse area is geocoded exactly once (not once per candidate).
    expect(areaCalls).toEqual(['L7G']);
    // Every venue lookup is biased to that single coarse-area centre.
    expect(biasArgs).toEqual([center, center]);
  });

  it('falls back to an undefined bias when the coarse-area centre can not be resolved', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const biasArgs: Array<unknown> = [];
    const geocode: DiscoverDeps['geocode'] = async (_title, _area, bias) => {
      biasArgs.push(bias);
      return null;
    };
    const geocodeArea: DiscoverDeps['geocodeArea'] = async () => null;

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode, geocodeArea));

    expect(biasArgs).toEqual([undefined, undefined]);
  });

  it('prefers the verified Places website over a model-supplied url (the model url is often a guess)', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        // No sourceUrl from the model → adopts the Places website.
        title: 'Toddler swim',
        description: 'a class at a municipal pool',
        confidence: 0.5,
        coverageNote: 'serves your area',
      },
      {
        // The model supplied a url, BUT Places resolved the real venue site →
        // the verified Places site must win (the model url is often hallucinated).
        title: 'Neighbourhood park',
        description: 'outdoor play',
        sourceUrl: 'https://example.org/park',
        confidence: 0.8,
        coverageNote: 'public parks exist everywhere',
      },
    ]);
    // Both venues resolve a public website via Places.
    const geocode: DiscoverDeps['geocode'] = async (title) => ({
      lat: 43.6,
      lng: -79.4,
      venueName: 'Public Venue',
      venueAddress: '1 Venue Rd',
      website: `https://places.example/${encodeURIComponent(title)}`,
    });

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode));

    const rows = capture.villageCandidates as Record<string, unknown>[];
    // No LLM url → adopts the Places website.
    expect(rows[0]?.sourceUrl).toBe('https://places.example/Toddler%20swim');
    // LLM url present but Places has the real site → Places WINS (not the model url).
    expect(rows[1]?.sourceUrl).toBe('https://places.example/Neighbourhood%20park');
  });

  it('adopts a model url only when Places has no website AND the url passes a sanity check', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        // Valid absolute https url + no Places website → kept as-is.
        title: 'Real venue',
        description: 'x',
        sourceUrl: 'https://realvenue.ca/register',
        confidence: 0.6,
        coverageNote: 'serves your area',
      },
      {
        // A placeholder host the model guessed + no Places website → rejected → null
        // (register link falls back to a coarse-area Google search, correct-by-construction).
        title: 'Guessed venue',
        description: 'y',
        sourceUrl: 'https://example.com/activity',
        confidence: 0.4,
        coverageNote: 'serves your area',
      },
      {
        // Not an absolute http(s) url → rejected → null.
        title: 'Bare host',
        description: 'z',
        sourceUrl: 'realvenue.ca/register',
        confidence: 0.4,
        coverageNote: 'serves your area',
      },
    ]);
    // No venue resolves a Places website (coords only, or none).
    const geocode: DiscoverDeps['geocode'] = async () => null;

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode));

    const rows = capture.villageCandidates as Record<string, unknown>[];
    expect(rows[0]?.sourceUrl).toBe('https://realvenue.ca/register');
    expect(rows[1]?.sourceUrl ?? null).toBeNull();
    expect(rows[2]?.sourceUrl ?? null).toBeNull();
  });

  it('leaves source_url null when the model gave none and the venue has no website (Google-search fallback)', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        title: 'Toddler swim',
        description: 'a class at a municipal pool',
        confidence: 0.5,
        coverageNote: 'serves your area',
      },
    ]);
    // Venue resolves coords but Places has no website.
    const geocode: DiscoverDeps['geocode'] = async () => ({
      lat: 43.6,
      lng: -79.4,
      venueName: 'Public Pool',
      venueAddress: '1 Pool Rd',
    });

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode));

    const row = (capture.villageCandidates as Record<string, unknown>[])[0];
    expect(row?.sourceUrl ?? null).toBeNull();
  });

  it('leaves coords null for a candidate the geocode can not resolve (list-only, no pin)', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        title: 'online newborn webinar',
        description: 'a virtual session, no venue',
        confidence: 0.5,
        coverageNote: 'online',
      },
    ]);

    // geocode returns null for an online / no-venue activity (deps default).
    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    const row = (capture.villageCandidates as Record<string, unknown>[])[0];
    expect(row?.lat).toBeNull();
    expect(row?.lng).toBeNull();
    expect(row?.venueName).toBeNull();
  });

  it('returns no_area and does NOT call the model when the family has no coarse area', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
    const db = fakeDb({ areaCoarse: null, children: [], capture });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const result = await discoverForFamily(FAMILY_ID, db, deps(c.client));

    expect(result).toEqual({ status: 'no_area' });
    expect(c.create).not.toHaveBeenCalled();
    expect(capture.villageCandidates).toEqual([]);
    expect(capture.auditLog).toEqual([]);
  });

  it('returns no_non_teen_children (no spend) for a teen-only family', async () => {
    const capture: InsertCapture = { villageCandidates: [], auditLog: [], agentRuns: [] };
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
