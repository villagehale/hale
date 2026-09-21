import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuardDeps } from '@hale/agent';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { productionChannelCoachPorts } from './runtime';
import { createTurnOfferLedger } from './tools';

/**
 * THE TWO PRODUCTION LINES NO OTHER TEST CAN REACH.
 *
 * A texted "add that one" records which find it was because the search verb tells the
 * turn's ledger what it offered and the add verb reads that ledger back —
 * `searchVillageTool(database, offered.record)` and `offeredThisTurn: offered.read` in
 * `productionChannelCoachPorts`. Both are OPTIONAL on the other side, so a wiring with
 * either half missing compiles, every unit test still passes, and provenance is simply
 * never written. That is the shape of the dead founder ping (#521), and a fake port
 * cannot fail on it — only the real one can.
 *
 * The draft itself is not what is under test: it needs the reviewer and a live model.
 * `fetch` is cut so nothing leaves the machine, and the assertion is the ROW the mint
 * writes before it reaches the reviewer — `actions.payload`, which is exactly what the
 * capture pass's resolver reads back.
 */

const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const TITLE = 'Riverdale storytime';
const NOW = new Date('2026-09-15T16:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec('truncate table families, users cascade');
});

interface Seeded {
  familyId: string;
  parentUserId: string;
  candidateId: string;
}

async function seed(): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON', areaCoarse: 'M4K' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:ledger-${familyId}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [candidate] = await db.database
    .insert(schema.villageCandidates)
    .values({
      familyId,
      title: TITLE,
      kind: 'class',
      summary: 'a warm local option',
      source: 'civic_registry',
      confidence: 0.9,
      venueName: 'Riverdale branch',
      eventDate: '2030-07-13',
      cadence: 'one-time',
      placeId: 'places/riverdale-library',
    })
    .returning({ id: schema.villageCandidates.id });
  return { familyId, parentUserId, candidateId: candidate?.id as string };
}

const noop = () => {};

/** The production guard too — `propose_calendar_add` is a child-content verb and the
 * real invoker refuses one without the teen check (rule #1/#5). */
let guardDeps: GuardDeps;

function productionTools(seeded: Seeded, ledger: ReturnType<typeof createTurnOfferLedger>) {
  // Constructed, never called: the draft port builds its Anthropic client eagerly, and
  // `fetch` below is what guarantees this test talks to nothing.
  vi.stubEnv('ANTHROPIC_API_KEY', 'not-used-by-this-test');
  vi.stubGlobal('fetch', async () => {
    throw new Error('offer-ledger.pglite.test: this test makes no network calls');
  });
  const ports = productionChannelCoachPorts(db.database);
  guardDeps = ports.guardDeps;
  return ports.buildTools(
    {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      conversationId: CONVERSATION_ID,
      body: 'what is on this weekend?',
      now: NOW,
      standingQuestions: [],
    },
    noop,
    noop,
    noop,
    noop,
    noop,
    ledger,
  );
}

function toolNamed(tools: ReturnType<typeof productionTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no ${name} tool`);
  return tool;
}

async function addThatOne(
  tools: ReturnType<typeof productionTools>,
  seeded: Seeded,
  title: string,
): Promise<void> {
  // The mint writes the row and THEN asks the reviewer, which is the call that fails
  // here. What the parent's approval would act on is already on disk by then.
  await invokeTool(
    toolNamed(tools, 'propose_calendar_add'),
    { title, date: '2030-07-13', time: '10:30', weekday: 'sat' },
    { familyId: seeded.familyId, actor: seeded.parentUserId },
    guardDeps,
  ).catch(() => undefined);
}

async function draftedPayload(familyId: string): Promise<Record<string, unknown> | undefined> {
  const [action] = await db.database
    .select({ payload: schema.actions.payload })
    .from(schema.actions)
    .where(eq(schema.actions.familyId, familyId));
  return action?.payload as Record<string, unknown> | undefined;
}

describe('the turn offer ledger, through the production ports', () => {
  it('records what the real search verb offered', async () => {
    const seeded = await seed();
    const ledger = createTurnOfferLedger();
    const tools = productionTools(seeded, ledger);

    await invokeTool(
      toolNamed(tools, 'search_village'),
      {},
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      guardDeps,
    );

    expect(ledger.read()).toEqual([
      {
        title: TITLE,
        candidateId: seeded.candidateId,
        placeId: 'places/riverdale-library',
        civicVenueId: null,
      },
    ]);
  });

  it('stamps the drafted add with the candidate the same turn offered', async () => {
    const seeded = await seed();
    const ledger = createTurnOfferLedger();
    const tools = productionTools(seeded, ledger);

    await invokeTool(
      toolNamed(tools, 'search_village'),
      {},
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      guardDeps,
    );
    await addThatOne(tools, seeded, TITLE);

    expect((await draftedPayload(seeded.familyId))?.sourceRef).toEqual({
      table: 'village_candidates',
      id: seeded.candidateId,
    });
  });

  it('stamps nothing on a title the turn never offered — the control', async () => {
    const seeded = await seed();
    const ledger = createTurnOfferLedger();
    const tools = productionTools(seeded, ledger);

    await invokeTool(
      toolNamed(tools, 'search_village'),
      {},
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      guardDeps,
    );
    await addThatOne(tools, seeded, 'Dentist');

    const payload = await draftedPayload(seeded.familyId);
    expect(payload?.title).toBe('Dentist');
    expect(payload?.sourceRef).toBeUndefined();
  });
});
