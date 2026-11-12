import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { armWatchedSpot } from '~/lib/channel/spots/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { productionChannelCoachPorts } from './runtime';
import { createTurnOfferLedger } from './tools';

/**
 * VIL-337 · the stop-watching verb through the PRODUCTION ports: the skill lists it only
 * for a parent with a live watch, and the registered verb ends that parent's watch in the
 * real table.
 */

const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-08T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function productionPorts() {
  vi.stubEnv('ANTHROPIC_API_KEY', 'not-used-by-this-test');
  vi.stubGlobal('fetch', async () => {
    throw new Error('stop-watching.pglite.test: this test makes no network calls');
  });
  return productionChannelCoachPorts(db.database);
}

async function watchedFamily() {
  const family = await seedFamily(db.database);
  const armed = await armWatchedSpot(db.database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    intent: {
      url: 'https://cityofexample.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=00000000-1111-2222-3333-444444444444&courseId=55555555-6666-7777-8888-999999999999',
      host: 'cityofexample.perfectmind.com',
      portalLabel: "Riverton's portal",
      label: 'Tuesday preschool swim',
      instant: false,
      lastState: 'full',
      sessionStartsAt: null,
      sessionAnchor: null,
    },
    channelMessageId: 'CM-ack',
    now: NOW,
  });
  if (armed.status !== 'armed') throw new Error(`seed: the arm was ${armed.status}`);
  return { ...family, spotId: armed.spotId };
}

describe('stop_watching — production wiring', () => {
  it('is listed for a parent with a live watch and not for one without', async () => {
    const ports = productionPorts();
    const watching = await watchedFamily();
    const idle = await seedFamily(db.database);

    const offered = await ports.loadSkill(watching.parentUserId, watching.familyId);
    const withheld = await ports.loadSkill(idle.parentUserId, idle.familyId);

    expect(offered.meta.tools).toContain('stop_watching');
    expect(withheld.meta.tools).not.toContain('stop_watching');
  });

  it("ends the parent's watch in the real table", async () => {
    const ports = productionPorts();
    const family = await watchedFamily();
    const noop = () => {};
    const tool = ports
      .buildTools(
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          conversationId: CONVERSATION_ID,
          body: 'we got in, you can stop watching it',
          now: NOW,
          standingQuestions: [],
          audience: 'direct',
        },
        noop,
        noop,
        noop,
        noop,
        noop,
        createTurnOfferLedger(),
        undefined,
        undefined,
        'CA',
        noop,
      )
      .find((candidate) => candidate.name === 'stop_watching');
    if (!tool) throw new Error('production buildTools registers no stop_watching');

    await expect(
      tool.handler({}, { familyId: family.familyId, actor: family.parentUserId }),
    ).resolves.toEqual({ stopped: ['Tuesday preschool swim'] });

    const [row] = await db.database
      .select({
        releasedAt: schema.watchedSpots.releasedAt,
        releasedReason: schema.watchedSpots.releasedReason,
      })
      .from(schema.watchedSpots)
      .where(eq(schema.watchedSpots.id, family.spotId));
    expect(row).toEqual({ releasedAt: NOW, releasedReason: 'parent_stopped' });
  });
});
