import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { LiveRegistrationReading } from '../live-reading';
import type { RegistrationReader, RegistrationTarget } from '../read';
import { ownCityRegistrationContext } from './context';
import { OWN_CITY_REGISTRATION_ENABLED_ENV } from './flag';
import type { CityLookupDeps } from './lookup';
import type { OwnCity } from './place';
import type { PageSearch } from './search';
import { REVERIFY_VERIFIED_MS } from './store';
import {
  type CityRegistrationSweepDeps,
  MAX_CITY_LOOKUPS_PER_RUN,
  defaultCityRegistrationSweepDeps,
  registrationOpeningDedupeKey,
  runCityRegistrationSweep,
} from './sweep';

/**
 * The own-city sweep against real Postgres: the per-city cache, the decider queue, the
 * audit rows and the hand radar's own reader are the real ones. The search and the page
 * reader are scripted ports (their model work is the city-registration eval's, hard rule
 * #8), and the gate's consent reads are a port (outbound-gate.test.ts owns them).
 */

/** Thursday Nov 12, 10:00 in Ontario. */
const NOW = new Date('2026-11-12T15:00:00Z');
const SUDBURY_PAGE =
  'https://www.greatersudbury.ca/play/pools/swimming-lessons/program-registration-dates/';
const TORONTO_PAGE =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/register-for-recreation-activities/';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(OWN_CITY_REGISTRATION_ENABLED_ENV, 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec(
    'truncate table families, users, city_registration_readings, registration_windows cascade',
  );
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => 'America/Toronto',
});

function verified(url: string, day: string, time: string | null): LiveRegistrationReading {
  return {
    sourceUrl: url,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates: [{ kind: 'unclassified_open', date: day, time, evidence: [`${day} ${time}`] }],
    partialDates: [],
  };
}

interface Script {
  searches: Array<{ city: string; cycleLabel: string }>;
  reads: RegistrationTarget[];
  search: (place: OwnCity) => PageSearch;
  read: (target: RegistrationTarget) => LiveRegistrationReading;
}

function scripted(
  over: Partial<Pick<Script, 'search' | 'read'>> = {},
): Pick<Script, 'searches' | 'reads'> & CityLookupDeps {
  const script: Script = {
    searches: [],
    reads: [],
    search: (place) =>
      place.city === 'Greater Sudbury'
        ? { outcome: 'pages', municipality: 'City of Greater Sudbury', urls: [SUDBURY_PAGE] }
        : place.city === 'Toronto'
          ? { outcome: 'pages', municipality: 'City of Toronto', urls: [TORONTO_PAGE] }
          : { outcome: 'none', reason: 'no_official_page' },
    read: (target) =>
      target.sourceUrl === SUDBURY_PAGE
        ? verified(SUDBURY_PAGE, '2026-12-16', '08:00')
        : verified(TORONTO_PAGE, '2026-12-09', '07:00'),
    ...over,
  };
  const read: RegistrationReader = async (target) => {
    script.reads.push(target);
    return script.read(target);
  };
  return {
    searches: script.searches,
    reads: script.reads,
    search: async (place, cycleLabel) => {
      script.searches.push({ city: place.city, cycleLabel });
      return script.search(place);
    },
    read,
  };
}

function deps(
  lookup: CityLookupDeps | null,
  over: Partial<CityRegistrationSweepDeps> = {},
): CityRegistrationSweepDeps {
  return {
    ...defaultCityRegistrationSweepDeps(null),
    lookup,
    buildGate: openGate,
    queueCandidate: queueCheckInForDecider,
    f14For: () => true,
    // Every parent seat: the channel join is loadFamilyTextRecipients' own test.
    recipients: async (database, familyId) =>
      (
        await database
          .select({ parentUserId: schema.familyMembers.userId, role: schema.familyMembers.role })
          .from(schema.familyMembers)
          .where(eq(schema.familyMembers.familyId, familyId))
      ).map((row) => ({
        parentUserId: row.parentUserId,
        timeZone: 'America/Toronto',
        role: row.role as 'primary_parent' | 'co_parent',
      })),
    ...over,
  };
}

async function seedFamily(
  postalCode: string,
  parents = 1,
): Promise<{ familyId: string; parentIds: string[] }> {
  const [family] = await db.database
    .insert(schema.families)
    // Intake writes both: the full code and its FSA as the coarse area.
    .values({
      displayName: 'Test household',
      country: 'Canada',
      postalCode,
      areaCoarse: postalCode.slice(0, 3),
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentIds: string[] = [];
  for (let i = 0; i < parents; i++) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ name: `Parent ${i}`, timezone: 'America/Toronto' })
      .returning({ id: schema.users.id });
    parentIds.push(user?.id as string);
    await db.database.insert(schema.familyMembers).values({
      familyId,
      userId: user?.id as string,
      role: i === 0 ? 'primary_parent' : 'co_parent',
    });
  }
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Robin', dateOfBirth: '2021-03-01' });
  return { familyId, parentIds };
}

async function tells(familyId: string) {
  return db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
}

describe('the own-city registration sweep', () => {
  it('reads nothing while the switch is off', async () => {
    vi.stubEnv(OWN_CITY_REGISTRATION_ENABLED_ENV, '');
    await seedFamily('P3A 1A1');
    const lookup = scripted();
    const result = await runCityRegistrationSweep(db.database, deps(lookup), NOW);
    expect(result.skipped).toBe('flag_off');
    expect(lookup.searches).toEqual([]);
    expect(await db.database.select().from(schema.cityRegistrationReadings)).toEqual([]);
  });

  it('looks a city up once for every family there, and queues one tell per parent', async () => {
    const one = await seedFamily('P3A 1A1', 2);
    const two = await seedFamily('P3B 2B2');
    const lookup = scripted();

    const result = await runCityRegistrationSweep(db.database, deps(lookup), NOW);

    expect(lookup.searches).toEqual([{ city: 'Greater Sudbury', cycleLabel: 'Winter 2027' }]);
    expect(result).toMatchObject({ lookedUp: 1, verified: 1, queued: 3, held: 0 });

    const [stored] = await db.database.select().from(schema.cityRegistrationReadings);
    expect(stored).toMatchObject({
      city: 'Greater Sudbury',
      provinceOrState: 'Ontario',
      country: 'Canada',
      district: null,
      cycleLabel: 'Winter 2027',
      status: 'verified',
      municipality: 'City of Greater Sudbury',
      sourceUrl: SUDBURY_PAGE,
    });
    expect(stored?.reverifyAt.getTime()).toBe(NOW.getTime() + REVERIFY_VERIFIED_MS);

    const opensAt = new Date('2026-12-16T13:00:00Z');
    const [tell] = await tells(two.familyId);
    expect(tell).toMatchObject({
      parentUserId: two.parentIds[0],
      kind: 'registration_opening',
      category: 'nudge',
      status: 'queued',
      what: 'Greater Sudbury Winter 2027 recreation programs registration opens Dec 16, 8:00 a.m.',
      sourceUrl: SUDBURY_PAGE,
      worthlessAfter: opensAt,
      parentRequested: false,
      dedupeKey: registrationOpeningDedupeKey({
        familyId: two.familyId,
        parentUserId: two.parentIds[0] as string,
        cycleLabel: 'Winter 2027',
        opensAt,
      }),
    });
    expect((await tells(one.familyId)).map((row) => row.parentUserId).sort()).toEqual(
      [...one.parentIds].sort(),
    );
    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, two.familyId));
    expect(audit.map((row) => row.actionTaken)).toEqual(['proactive_cadence_queued']);

    // The coach now has the date, and knows a text is coming.
    expect(await ownCityRegistrationContext(db.database, two.familyId, NOW)).toEqual([
      {
        town: 'Greater Sudbury',
        programs: 'Winter 2027 recreation programs',
        opensFor: 'Dec 16, 8:00 a.m.',
        residentsFirst: false,
        generalOpens: null,
        ageApproximate: false,
        watching: true,
      },
    ]);
  });

  it("asks for a Toronto family's own district morning", async () => {
    const north = await seedFamily('M2N 0A1');
    const lookup = scripted();
    await runCityRegistrationSweep(db.database, deps(lookup), NOW);
    expect(lookup.reads.map((target) => target.cycleLabel)).toEqual(['Winter 2027 (north york)']);
    const [tell] = await tells(north.familyId);
    expect(tell?.what).toBe(
      'Toronto Winter 2027 recreation programs registration opens Dec 9, 7:00 a.m.',
    );
  });

  it('does not look up or tell again inside the cache window', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    const later = scripted();
    const result = await runCityRegistrationSweep(
      db.database,
      deps(later),
      new Date(NOW.getTime() + 3_600_000),
    );
    expect(later.searches).toEqual([]);
    expect(later.reads).toEqual([]);
    expect(result).toMatchObject({ lookedUp: 0, queued: 0, duplicate: 1 });
    expect(await tells(family.familyId)).toHaveLength(1);
  });

  it('re-reads the known page when stale, and a moved date replaces the waiting tell', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);

    const moved = scripted({ read: () => verified(SUDBURY_PAGE, '2026-12-17', '08:00') });
    const stale = new Date(NOW.getTime() + REVERIFY_VERIFIED_MS + 60_000);
    const result = await runCityRegistrationSweep(db.database, deps(moved), stale);

    // The page Hale had is read again; no new search.
    expect(moved.searches).toEqual([]);
    expect(moved.reads.map((target) => target.sourceUrl)).toEqual([SUDBURY_PAGE]);
    expect(result).toMatchObject({ lookedUp: 1, verified: 1, superseded: 1, queued: 1 });

    const rows = await tells(family.familyId);
    const old = rows.find((row) => row.status === 'dropped');
    expect(old).toMatchObject({ reason: 'date_changed', what: '' });
    const fresh = rows.find((row) => row.status === 'queued');
    expect(fresh?.what).toContain('Dec 17, 8:00 a.m.');
  });

  it('takes back a waiting tell when the page no longer confirms the date', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    const gone = scripted({
      read: () => ({
        sourceUrl: SUDBURY_PAGE,
        checkedAt: NOW,
        reader: 'ai',
        status: 'unverified',
        reason: 'announced_later',
        partialDates: [],
      }),
    });
    const stale = new Date(NOW.getTime() + REVERIFY_VERIFIED_MS + 60_000);
    const result = await runCityRegistrationSweep(db.database, deps(gone), stale);
    expect(result).toMatchObject({ notFound: 1, notKnown: 1, superseded: 1, queued: 0 });
    const [dropped] = await tells(family.familyId);
    expect(dropped).toMatchObject({ status: 'dropped', reason: 'date_unconfirmed', what: '' });
    expect(await ownCityRegistrationContext(db.database, family.familyId, stale)).toEqual([]);
  });

  it('stores "not found" for a city with no official page, and tells nobody', async () => {
    const family = await seedFamily('R3C 1A1');
    const result = await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    expect(result).toMatchObject({ lookedUp: 1, notFound: 1, notKnown: 1, queued: 0 });
    const [stored] = await db.database.select().from(schema.cityRegistrationReadings);
    expect(stored).toMatchObject({
      city: 'Winnipeg',
      status: 'not_found',
      reason: 'no_official_page',
      sourceUrl: null,
      reading: null,
    });
    expect(await tells(family.familyId)).toEqual([]);
    expect(await ownCityRegistrationContext(db.database, family.familyId, NOW)).toEqual([]);
  });

  it('stores nothing when the lookup did not finish, so a busy hour is not "not found"', async () => {
    await seedFamily('P3A 1A1');
    const failed = scripted({
      search: () => ({ outcome: 'failed', reason: 'stopped:pause_turn' }),
    });
    const result = await runCityRegistrationSweep(db.database, deps(failed), NOW);
    expect(result).toMatchObject({ lookedUp: 1, retry: 1, notKnown: 1 });
    expect(await db.database.select().from(schema.cityRegistrationReadings)).toEqual([]);
  });

  it('leaves a family the hand-verified radar covers to the radar', async () => {
    const king = await seedFamily('L7B 1A1');
    await db.database.insert(schema.registrationWindows).values({
      municipality: 'king',
      programDomain: 'rec_program',
      cycleLabel: 'Winter 2027',
      openAt: new Date('2026-12-07T05:00:00Z'),
      sourceUrl: 'https://www.king.ca/recreation',
      verifiedAt: NOW,
    });
    const lookup = scripted();
    const result = await runCityRegistrationSweep(db.database, deps(lookup), NOW);
    expect(result).toMatchObject({ handRadar: 1, lookedUp: 0 });
    expect(lookup.searches).toEqual([]);
    expect(await tells(king.familyId)).toEqual([]);
  });

  it('holds a parent the gate refuses now, so the next hour can ask again', async () => {
    const family = await seedFamily('P3A 1A1');
    const quiet = (): OutboundGatePorts => ({ ...openGate(), channelEnrolled: async () => false });
    const result = await runCityRegistrationSweep(
      db.database,
      deps(scripted(), { buildGate: quiet }),
      NOW,
    );
    expect(result).toMatchObject({ held: 1, queued: 0 });
    expect(await tells(family.familyId)).toEqual([]);
  });

  it('looks up at most the bound per run, and counts the rest as deferred', async () => {
    for (const postal of ['P3A 1A1', 'M2N 0A1', 'M1B 1A1', 'K2P 1A1']) await seedFamily(postal);
    const lookup = scripted();
    const result = await runCityRegistrationSweep(db.database, deps(lookup), NOW);
    expect(result.lookedUp).toBe(MAX_CITY_LOOKUPS_PER_RUN);
    expect(result.deferred).toBe(4 - MAX_CITY_LOOKUPS_PER_RUN);
  });

  it('counts a city whose lookup threw, and still reaches the next city', async () => {
    const sudbury = await seedFamily('P3A 1A1');
    const toronto = await seedFamily('M2N 0A1');
    const lookup = scripted();
    const broken = {
      ...lookup,
      search: async (place: OwnCity, cycleLabel: string, today: string) => {
        if (place.city === 'Greater Sudbury') throw new TypeError('reader bug');
        return lookup.search(place, cycleLabel, today);
      },
    };
    const result = await runCityRegistrationSweep(db.database, deps(broken), NOW);
    expect(result).toMatchObject({ failed: 1, verified: 1, queued: 1 });
    expect(await tells(sudbury.familyId)).toEqual([]);
    expect(await tells(toronto.familyId)).toHaveLength(1);
  });

  it('names a deploy with no model client, and looks nothing up', async () => {
    await seedFamily('P3A 1A1');
    const result = await runCityRegistrationSweep(db.database, deps(null), NOW);
    expect(result).toMatchObject({ noClient: 1, lookedUp: 0, queued: 0 });
  });

  it('says nothing once the doors have opened', async () => {
    const family = await seedFamily('P3A 1A1');
    const after = new Date('2026-12-16T14:00:00Z');
    const result = await runCityRegistrationSweep(db.database, deps(scripted()), after);
    expect(result).toMatchObject({ verified: 1, past: 1, queued: 0 });
    expect(await tells(family.familyId)).toEqual([]);
    const [stored] = await db.database
      .select()
      .from(schema.cityRegistrationReadings)
      .where(and(eq(schema.cityRegistrationReadings.city, 'Greater Sudbury')));
    expect(stored?.status).toBe('verified');
  });
});
