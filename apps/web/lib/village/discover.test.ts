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
  /** Each supersede UPDATE run in the transaction, capturing its `.set(...)`
   * payload so a test can assert the prior run was soft-retired (superseded_at
   * stamped) and nothing else (shareToken never cleared). */
  supersededUpdates: Record<string, unknown>[];
}

/**
 * Fakes the exact Drizzle chains discoverForFamily runs, with NO real db, routed by
 * TABLE identity (order-independent):
 *   1. resolveActiveAreaCoarse:
 *        select(...).from(familyAreas).where().limit(1) → [`activeArea`] | []
 *        (fallback) select(area).from(families).where().limit(1) → [{ areaCoarse }]
 *   2. select(...).from(children).where()             → child rows
 *   3. transaction(cb) where tx.insert(table).values(rows) captures by table.
 * `activeArea` present → the ACTIVE saved area drives content; absent → the legacy
 * families.area_coarse is used (back-compat).
 */
function fakeDb(args: {
  areaCoarse: string | null;
  children: ChildRow[];
  capture: InsertCapture;
  activeArea?: { city: string; province: string | null; postalCode: string | null };
}) {
  const select = vi.fn().mockImplementation(() => {
    let tbl: unknown;
    return {
      from: (table: unknown) => {
        tbl = table;
        if (tbl === schema.children) {
          // children lookup: .from().where() → rows (no .limit)
          return { where: async () => args.children };
        }
        // familyAreas (active row) + families (legacy) both: .where().limit(1).
        return {
          where: () => ({
            limit: async () => {
              if (tbl === schema.familyAreas) return args.activeArea ? [args.activeArea] : [];
              return [{ areaCoarse: args.areaCoarse }];
            },
          }),
        };
      },
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
    // The supersede step: .update(villageCandidates).set({supersededAt}).where(...).
    // Capture the `.set` payload; `.where` is a no-op thenable (nothing to delete
    // in the fake — the point is to prove the prior set is SOFT-retired, not
    // removed, so an endorsed/shared row would survive).
    update: (table: unknown) => {
      if (tableName(table) !== 'villageCandidates') {
        throw new Error('unexpected update target');
      }
      return {
        set: (payload: Record<string, unknown>) => {
          args.capture.supersededUpdates.push(payload);
          return { where: async () => undefined };
        },
      };
    },
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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

  it('honors the ACTIVE saved area over the legacy family field (region switch drives content)', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    // The family's ACTIVE saved area is Ottawa (K1P …); the legacy families field is
    // a DIFFERENT area (L7G). Discovery must use the active area's coarse prefix.
    const db = fakeDb({
      areaCoarse: 'L7G',
      activeArea: { city: 'Ottawa', province: 'ON', postalCode: 'K1P 1J1' },
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    // The model receives the ACTIVE area's coarse prefix, not the legacy 'L7G'.
    const sentUser = c.create.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(JSON.parse(sentUser).area_coarse).toBe('K1P');
    // And the audit records the active coarse area.
    expect(capture.auditLog[0]).toEqual(
      expect.objectContaining({
        after: { areaCoarse: 'K1P', provider: 'llm_only', count: 2 },
      }),
    );
  });

  it('REPLACES the active set: soft-supersedes the prior run BEFORE inserting the new one', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient(SAMPLE_CANDIDATES);

    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    // Exactly one supersede UPDATE runs for the run, and it stamps ONLY
    // superseded_at — never clears shareToken (rule: shared/endorsed rows keep
    // their public /a/:token page alive) and never touches any other column.
    expect(capture.supersededUpdates).toHaveLength(1);
    const setPayload = capture.supersededUpdates[0] as Record<string, unknown>;
    expect(Object.keys(setPayload)).toEqual(['supersededAt']);
    expect(setPayload.supersededAt).toBeInstanceOf(Date);

    // The new run's candidates land with superseded_at unset (they ARE the active
    // set now) — the insert never carries a supersededAt value.
    for (const row of capture.villageCandidates as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('supersededAt');
    }
  });

  it('persists event_date and seasons the model supplied (freshness fields), null when absent', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        // A dated one-time event → event_date set, seasons null.
        title: 'Library author visit',
        description: 'a one-day author reading',
        cadence: 'one-time',
        eventDate: '2026-09-12',
        confidence: 0.7,
        coverageNote: 'a grounded listing named the date',
      },
      {
        // A seasonal activity → seasons set, event_date null.
        title: 'Summer splash-pad drop-in',
        description: 'outdoor water play in the warm months',
        cadence: 'seasonal',
        seasons: ['summer'],
        confidence: 0.6,
        coverageNote: 'splash pads run in summer',
      },
      {
        // An ongoing option with neither → both null (graceful default).
        title: 'Library storytime',
        description: 'weekly rolling storytime',
        cadence: 'ongoing',
        confidence: 0.65,
        coverageNote: 'libraries run rolling storytimes',
      },
    ]);

    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    const rows = capture.villageCandidates as Record<string, unknown>[];
    expect(rows[0]?.eventDate).toBe('2026-09-12');
    expect(rows[0]?.seasons).toBeNull();
    expect(rows[1]?.eventDate).toBeNull();
    expect(rows[1]?.seasons).toEqual(['summer']);
    expect(rows[2]?.eventDate).toBeNull();
    expect(rows[2]?.seasons).toBeNull();
  });

  it('persists the VERIFIED Places rating/count/place_id (fixed-point string), null when absent', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      { title: 'Rated venue', description: 'x', confidence: 0.6, coverageNote: 'serves area' },
      { title: 'Unrated venue', description: 'y', confidence: 0.5, coverageNote: 'serves area' },
    ]);
    // First venue has a real Places rating; second resolves coords but no rating.
    const geocode: DiscoverDeps['geocode'] = async (title) =>
      title === 'Rated venue'
        ? {
            lat: 43.6,
            lng: -79.4,
            venueName: 'Rated venue',
            venueAddress: '1 Rd',
            placeId: 'places/ABC',
            rating: 4.6,
            ratingCount: 128,
          }
        : { lat: 43.7, lng: -79.5, venueName: 'Unrated venue', venueAddress: '2 Rd' };

    await discoverForFamily(FAMILY_ID, db, deps(c.client, geocode));

    const rows = capture.villageCandidates as Record<string, unknown>[];
    // numeric(2,1) takes a fixed-point STRING on insert (mirrors costUsd).
    expect(rows[0]?.rating).toBe('4.6');
    expect(rows[0]?.ratingCount).toBe(128);
    expect(rows[0]?.placeId).toBe('places/ABC');
    // No Places rating → null (the card renders NO stars, never a fabricated 0).
    expect(rows[1]?.rating).toBeNull();
    expect(rows[1]?.ratingCount).toBeNull();
    expect(rows[1]?.placeId).toBeNull();
  });

  it('persists the honest model attribute hints (price/age/indoor), null when the model omitted them', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        title: 'Free outdoor splash pad',
        description: 'x',
        priceBand: 'free',
        ageRange: '2–6 years',
        indoorOutdoor: 'outdoor',
        confidence: 0.7,
        coverageNote: 'serves area',
      },
      {
        // The model expressed unknown as explicit null — must persist as null, not error.
        title: 'Unclassified group',
        description: 'y',
        priceBand: null,
        ageRange: null,
        indoorOutdoor: null,
        confidence: 0.5,
        coverageNote: 'serves area',
      },
    ]);

    await discoverForFamily(FAMILY_ID, db, deps(c.client));

    const rows = capture.villageCandidates as Record<string, unknown>[];
    expect(rows[0]?.priceLevel).toBe('free');
    expect(rows[0]?.ageRange).toBe('2–6 years');
    expect(rows[0]?.indoorOutdoor).toBe('outdoor');
    expect(rows[1]?.priceLevel).toBeNull();
    expect(rows[1]?.ageRange).toBeNull();
    expect(rows[1]?.indoorOutdoor).toBeNull();
  });

  it('records a FAILED agent_runs row and rethrows when the model returns no tool call (rule #8)', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    const db = fakeDb({
      areaCoarse: 'L7G',
      children: [{ dateOfBirth: TODDLER_DOB, interests: ['water'] }],
      capture,
    });
    const c = fakeClient([
      {
        title: 'Toddler swim',
        description: 'a class at a municipal pool',
        cadence: 'seasonal',
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
          'ageRange',
          'cadence',
          'childId',
          'confidence',
          'coverageNote',
          'eventDate',
          'familyId',
          'indoorOutdoor',
          'kind',
          'lat',
          'lng',
          'placeId',
          'priceLevel',
          'rating',
          'ratingCount',
          'runType',
          'searchSeason',
          'seasons',
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

    // The model's cadence persists as-is (the chip's source of truth).
    const persistedCadences = (capture.villageCandidates as Record<string, unknown>[]).map(
      (r) => r.cadence,
    );
    expect(persistedCadences).toEqual(['seasonal']);

    // The geocode received ONLY the candidate title + the coarse area — no precise
    // location ever leaves the server (rule #1).
    expect(geoCalls).toEqual([{ title: 'Toddler swim', area: 'L7G' }]);
  });

  it('resolves the coarse-area centre ONCE and biases every venue lookup to it (rule #1)', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
    const db = fakeDb({ areaCoarse: null, children: [], capture });
    const c = fakeClient(SAMPLE_CANDIDATES);

    const result = await discoverForFamily(FAMILY_ID, db, deps(c.client));

    expect(result).toEqual({ status: 'no_area' });
    expect(c.create).not.toHaveBeenCalled();
    expect(capture.villageCandidates).toEqual([]);
    expect(capture.auditLog).toEqual([]);
  });

  it('returns no_non_teen_children (no spend) for a teen-only family', async () => {
    const capture: InsertCapture = {
      villageCandidates: [],
      auditLog: [],
      agentRuns: [],
      supersededUpdates: [],
    };
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

describe('candidatesSchema — model null tolerance (season-search 500)', () => {
  // The tool schema declares eventDate/seasons/cadence/sourceUrl as optional, and
  // Claude routinely expresses "none" as an explicit null (a year-round pick in a
  // season search has no eventDate and no seasons). The parse must accept exactly
  // what the tool contract permits — a null here killed the whole run with a 500.
  it('accepts explicit nulls for the optional candidate fields', async () => {
    const { candidatesSchema } = await import('./discover.js');
    const parsed = candidatesSchema.parse({
      candidates: [
        {
          title: 'Public library toddler time',
          description: 'Weekly story time, year-round.',
          cadence: null,
          eventDate: null,
          seasons: null,
          sourceUrl: null,
          priceBand: null,
          ageRange: null,
          indoorOutdoor: null,
          confidence: 0.8,
          coverageNote: 'library site',
        },
      ],
    });
    expect(parsed.candidates[0]?.eventDate ?? null).toBeNull();
    expect(parsed.candidates[0]?.seasons ?? null).toBeNull();
    // The new attribute fields accept an explicit null too (season-search lesson).
    expect(parsed.candidates[0]?.priceBand ?? null).toBeNull();
    expect(parsed.candidates[0]?.ageRange ?? null).toBeNull();
    expect(parsed.candidates[0]?.indoorOutdoor ?? null).toBeNull();
  });

  it('degrades an out-of-vocab attribute token to null instead of killing the run', async () => {
    // The attribute-level season-search lesson: the model inventing 'cheap-ish'
    // or 'mixed' must cost that FIELD, not the whole discovery run (which would
    // bypass recordRun('failed') entirely).
    const { candidatesSchema } = await import('./discover.js');
    const parsed = candidatesSchema.parse({
      candidates: [
        {
          title: 'Community centre open gym',
          description: 'drop-in play',
          priceBand: 'cheap-ish',
          indoorOutdoor: 'mixed',
          confidence: 0.6,
          coverageNote: 'city site',
        },
      ],
    });
    expect(parsed.candidates[0]?.priceBand ?? null).toBeNull();
    expect(parsed.candidates[0]?.indoorOutdoor ?? null).toBeNull();
  });

  it('accepts the attribute fields when the model DID supply them', async () => {
    const { candidatesSchema } = await import('./discover.js');
    const parsed = candidatesSchema.parse({
      candidates: [
        {
          title: 'Outdoor splash pad',
          description: 'free summer water play',
          priceBand: 'free',
          ageRange: '2–6 years',
          indoorOutdoor: 'outdoor',
          confidence: 0.7,
          coverageNote: 'city site',
        },
      ],
    });
    expect(parsed.candidates[0]?.priceBand).toBe('free');
    expect(parsed.candidates[0]?.ageRange).toBe('2–6 years');
    expect(parsed.candidates[0]?.indoorOutdoor).toBe('outdoor');
  });

  it('never lets an out-of-vocab price band SURVIVE the parse (degrade, not persist)', async () => {
    // The honesty property the old reject-semantics guarded, restated for the
    // degrade behavior: the invented token must not reach the vocabulary — it
    // becomes null (chip hidden), never a rendered raw string.
    const { candidatesSchema } = await import('./discover.js');
    const parsed = candidatesSchema.parse({
      candidates: [
        {
          title: 'x',
          description: 'y',
          priceBand: 'cheap-ish',
          confidence: 0.5,
          coverageNote: 'z',
        },
      ],
    });
    expect(parsed.candidates[0]?.priceBand ?? null).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('cheap-ish');
  });
});
