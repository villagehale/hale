import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { DISCOVERY_TARGETS } from './discovery-targets';
import {
  DISCOVERY_ESCALATE_AFTER_MS,
  type DiscoveryReadingInsert,
  type RegistrationVerifyDeps,
  discoveryPageHash,
  loadPriorPublishedDiscoveries,
  recordDiscoveryReadings,
  runRegistrationVerifySweep,
} from './verify-sweep';
import type { ExtractedWindow } from './verify-window';

/**
 * VIL-360. The weekly sweep used to email a count and forget the page. A fixture
 * news release that publishes a date must land in registration_discovery_readings,
 * and the digest must name it. The same target, still unpublished in the dataset
 * a week later, escalates.
 */

const NEWS = fileURLToPath(new URL('./fixtures/toronto-winter-2027-news.html', import.meta.url));
const NEWS_PAGE = readFileSync(NEWS, 'utf8');
const NEWS_URL = 'https://www.toronto.ca/news/';
const REGISTER_PAGE = 'Registration dates will be announced at a later date.';
const QUOTE = 'Winter 2027 recreation registration opens Wednesday, December 9, 2027 at 7 a.m.';

const FIRST_RUN = new Date('2026-11-02T15:00:00.000Z');

const TORONTO = DISCOVERY_TARGETS.find(
  (target) => target.municipality === 'toronto' && target.programDomain === 'rec_program',
);
if (!TORONTO) throw new Error('fixture drift: no Toronto rec discovery target');

function publishedReading(): ExtractedWindow {
  return {
    found: true,
    reason: null,
    cycleOnPage: 'Winter 2027',
    yearEvidence: QUOTE,
    preview: null,
    residentOpen: { date: '2027-12-09', time: '07:00' },
    generalOpen: null,
    evidence: QUOTE,
    confidence: 0.95,
  };
}

function emptyReading(): ExtractedWindow {
  return {
    found: false,
    reason: 'announced_later',
    cycleOnPage: null,
    yearEvidence: null,
    preview: null,
    residentOpen: null,
    generalOpen: null,
    evidence: null,
    confidence: 0.2,
  };
}

describe('discovery readings persist and escalate (VIL-360)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('records the news page and re-reads it seven days later without duplicating', async () => {
    expect(NEWS_PAGE).toContain(QUOTE);
    const deps = {
      client: {} as never,
      fetchPage: vi.fn(async (url: string) => (url === NEWS_URL ? NEWS_PAGE : REGISTER_PAGE)),
      extract: vi.fn(async (_cycle: unknown, pageText: string) =>
        pageText.includes(QUOTE) ? publishedReading() : emptyReading(),
      ),
      loadWindows: async () => [],
      markVerified: async () => {},
      claimWeek: async () => true,
      recordRun: async () => {},
      recordDiscoveries: (
        database: TestDb['database'],
        readings: readonly DiscoveryReadingInsert[],
      ) => recordDiscoveryReadings(database, readings),
      loadDiscoveryHistory: (database: TestDb['database'], now: Date) =>
        loadPriorPublishedDiscoveries(database, now),
      preflight: (async () => ({
        proceed: true,
        health: null,
      })) as RegistrationVerifyDeps['preflight'],
      discoveryTargets: [TORONTO],
    };

    await runRegistrationVerifySweep(db.database, deps, FIRST_RUN);

    const stored = await db.database
      .select()
      .from(schema.registrationDiscoveryReadings)
      .where(eq(schema.registrationDiscoveryReadings.cycleLabel, 'Winter 2027'));
    expect(stored).toHaveLength(2);
    const news = stored.find((row) => row.sourceUrl === NEWS_URL);
    const register = stored.find((row) => row.sourceUrl !== NEWS_URL);
    expect(news).toMatchObject({
      municipality: 'toronto',
      programDomain: 'rec_program',
      published: true,
      pageHash: discoveryPageHash(NEWS_PAGE),
    });
    expect(news?.readAt).toEqual(FIRST_RUN);
    expect(news?.reading).toMatchObject({ evidence: QUOTE, found: true });
    expect(register).toMatchObject({
      published: false,
      pageHash: discoveryPageHash(REGISTER_PAGE),
    });

    const weekLater = new Date(FIRST_RUN.getTime() + DISCOVERY_ESCALATE_AFTER_MS);
    await runRegistrationVerifySweep(db.database, deps, weekLater);

    const history = await loadPriorPublishedDiscoveries(db.database, weekLater);
    expect(history.length).toBeGreaterThan(0);
  });
});
