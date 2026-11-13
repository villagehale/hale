import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { LiveRegistrationReading, VerifiedRegistrationReading } from '../live-reading';
import type { RegistrationReader, RegistrationTarget } from '../read';
import { ownCityRegistrationContext, postalOwnCityOpens } from './context';
import { OWN_CITY_REGISTRATION_ENABLED_ENV } from './flag';
import type { CityLookupDeps } from './lookup';
import { RECHECK_FOUND_MS, cachedOfficialSite } from './official-site';
import type { CityPlace } from './place';
import type { PageSearch } from './search';
import { REVERIFY_NOT_FOUND_MS, REVERIFY_VERIFIED_MS } from './store';
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

const OFFICIAL_HOSTS: Record<string, string> = {
  'Greater Sudbury': 'greatersudbury.ca',
  Toronto: 'toronto.ca',
};

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
    'truncate table families, users, city_registration_readings, city_official_sites, registration_windows cascade',
  );
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => 'America/Toronto',
});

function verified(
  url: string,
  day: string,
  time: string | null,
  evidence = [`${day} ${time}`],
): LiveRegistrationReading {
  return {
    sourceUrl: url,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates: [{ kind: 'unclassified_open', date: day, time, evidence }],
    partialDates: [],
  };
}

interface Script {
  searches: Array<{ city: string; cycleLabel: string }>;
  reads: RegistrationTarget[];
  search: (place: CityPlace) => PageSearch;
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
        : verified(TORONTO_PAGE, '2026-12-09', '07:00', [
            'Wednesday, December 9, 7 a.m.',
            'Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m.',
          ]),
    ...over,
  };
  const read: RegistrationReader = async (target) => {
    script.reads.push(target);
    return script.read(target);
  };
  return {
    searches: script.searches,
    reads: script.reads,
    officialSite: async (place) => ({
      status: 'found',
      host: OFFICIAL_HOSTS[place.city] ?? 'example.ca',
      website: `https://www.${OFFICIAL_HOSTS[place.city] ?? 'example.ca'}/`,
      source: 'wikidata:Q1',
    }),
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
    ...defaultCityRegistrationSweepDeps(null, db.database),
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
  id?: string,
): Promise<{ familyId: string; parentIds: string[] }> {
  const [family] = await db.database
    .insert(schema.families)
    // Intake writes both: the full code and its FSA as the coarse area.
    .values({
      ...(id === undefined ? {} : { id }),
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

/** The stored readings' statuses, without the rows that only say when to look again. */
async function readingStatuses(): Promise<string[]> {
  return (await db.database.select().from(schema.cityRegistrationReadings))
    .filter((row) => row.status !== 'retry')
    .map((row) => row.status);
}

describe('the own-city registration sweep', () => {
  it('reads nothing while the switch is off', async () => {
    vi.stubEnv(OWN_CITY_REGISTRATION_ENABLED_ENV, 'false');
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
      what: 'Greater Sudbury Winter 2027 registration opens Dec 16, 8:00 a.m.',
      sourceUrl: SUDBURY_PAGE,
      worthlessAfter: opensAt,
      parentRequested: false,
      dedupeKey: registrationOpeningDedupeKey({
        familyId: two.familyId,
        parentUserId: two.parentIds[0] as string,
        place: {
          city: 'Greater Sudbury',
          provinceOrState: 'Ontario',
          country: 'Canada',
          district: null,
        },
        cycleLabel: 'Winter 2027',
        openingDate: '2026-12-16',
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
    expect(
      await ownCityRegistrationContext(db.database, two.familyId, two.parentIds[0] as string, NOW),
    ).toEqual([
      {
        town: 'Greater Sudbury',
        programs: 'Winter 2027',
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
    expect(tell?.what).toBe('Toronto Winter 2027 registration opens Dec 9, 7:00 a.m.');
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
    expect(
      await ownCityRegistrationContext(
        db.database,
        family.familyId,
        family.parentIds[0] as string,
        stale,
      ),
    ).toEqual([]);
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
    expect(
      await ownCityRegistrationContext(
        db.database,
        family.familyId,
        family.parentIds[0] as string,
        NOW,
      ),
    ).toEqual([]);
  });

  it('stores no reading when the lookup did not finish, so a busy hour is not "not found"', async () => {
    await seedFamily('P3A 1A1');
    const failed = scripted({
      search: () => ({ outcome: 'failed', reason: 'stopped:pause_turn' }),
    });
    const result = await runCityRegistrationSweep(db.database, deps(failed), NOW);
    expect(result).toMatchObject({ lookedUp: 1, retry: 1, notKnown: 1 });
    // Only when to look again: the next sweep.
    expect(
      (await db.database.select().from(schema.cityRegistrationReadings)).map((row) => ({
        status: row.status,
        reason: row.reason,
        reverifyAt: row.reverifyAt,
      })),
    ).toEqual([
      {
        status: 'retry',
        reason: 'stopped:pause_turn',
        reverifyAt: new Date(NOW.getTime() + 3_600_000),
      },
    ]);
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
      search: async (place: CityPlace, cycleLabel: string, today: string) => {
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

  it("names the programs the way the page does, never as all of the city's recreation", async () => {
    const family = await seedFamily('P3A 1A1');
    const swim = scripted({
      read: () => ({
        ...(verified(SUDBURY_PAGE, '2026-12-16', '08:00') as VerifiedRegistrationReading),
        programOnPage: 'Winter Session 2027 – ten-week session',
      }),
    });
    await runCityRegistrationSweep(db.database, deps(swim), NOW);
    const [tell] = await tells(family.familyId);
    expect(tell?.what).toBe(
      'Greater Sudbury Winter Session 2027 – ten-week session registration opens Dec 16, 8:00 a.m.',
    );
  });
});

describe('each family is told the date for its own residency and district', () => {
  const MARKHAM_PAGE = 'https://www.markham.ca/recreation/registration';
  const VAUGHAN_PAGE = 'https://www.vaughan.ca/recreation/registration';
  /** Sorts first and last by id: the sweep loads families in id order. */
  const FIRST = '00000000-0000-4000-8000-000000000001';
  const LAST = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const HOSTS: Record<string, string> = { Markham: 'markham.ca', Vaughan: 'vaughan.ca' };

  type PageDate = LiveRegistrationReading extends infer R
    ? R extends { status: 'verified'; dates: Array<infer D> }
      ? D
      : never
    : never;
  const page = (url: string, dates: PageDate[]): LiveRegistrationReading => ({
    sourceUrl: url,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates,
    partialDates: [],
  });
  /** Markham's Winter 2027 page as read 2026-11-12: residents Dec 1, non-residents Dec 2. */
  const residents: PageDate = {
    kind: 'resident_open',
    date: '2026-12-01',
    time: '06:30',
    evidence: ['2027 Winter Registration for residents: December 1, 2026, at 6:30 AM'],
  };
  const nonResidents: PageDate = {
    kind: 'general_open',
    date: '2026-12-02',
    time: '06:30',
    evidence: ['2027 Winter Registration for non-residents: December 2, 2026, at 6:30 AM'],
  };
  const vaughan: PageDate = {
    kind: 'unclassified_open',
    date: '2026-12-03',
    time: '09:00',
    evidence: ['Winter 2027 registration opens December 3, 2026 at 9 a.m.'],
  };

  function york(markham: PageDate[]): CityLookupDeps & { reads: RegistrationTarget[] } {
    const reads: RegistrationTarget[] = [];
    return {
      reads,
      officialSite: async (place) => ({
        status: 'found',
        host: HOSTS[place.city] ?? 'example.ca',
        website: `https://www.${HOSTS[place.city] ?? 'example.ca'}/`,
        source: 'wikidata:Q1',
      }),
      search: async (place) =>
        place.city === 'Markham'
          ? { outcome: 'pages', municipality: 'City of Markham', urls: [MARKHAM_PAGE] }
          : { outcome: 'pages', municipality: 'City of Vaughan', urls: [VAUGHAN_PAGE] },
      read: async (target) => {
        reads.push(target);
        return target.sourceUrl === MARKHAM_PAGE
          ? page(MARKHAM_PAGE, markham)
          : page(VAUGHAN_PAGE, [vaughan]);
      },
    };
  }

  const whatOf = async (familyId: string) => (await tells(familyId)).map((row) => row.what);
  const coachOf = async (family: { familyId: string; parentIds: string[] }) =>
    ownCityRegistrationContext(db.database, family.familyId, family.parentIds[0] as string, NOW);

  for (const order of ['resident first', 'residency in doubt first'] as const) {
    it(`Markham: a resident, a family whose residency is in doubt and a Vaughan family each hear their own date (${order})`, async () => {
      const resident = await seedFamily('L3P 1A1', 1, order === 'resident first' ? FIRST : LAST);
      // L3T (Thornhill) straddles Markham and Vaughan: residency is in doubt.
      const inDoubt = await seedFamily('L3T 1A1', 1, order === 'resident first' ? LAST : FIRST);
      // Lives in Vaughan: a Markham non-resident, whose own city is Vaughan.
      const vaughanFamily = await seedFamily('L6A 1A1');
      const lookup = york([residents, nonResidents]);

      const result = await runCityRegistrationSweep(db.database, deps(lookup), NOW);

      expect(result).toMatchObject({ lookedUp: 2, verified: 2, queued: 3, notKnown: 0 });
      expect(lookup.reads.map((target) => target.sourceUrl).sort()).toEqual([
        MARKHAM_PAGE,
        VAUGHAN_PAGE,
      ]);
      expect(await whatOf(resident.familyId)).toEqual([
        'Markham Winter 2027 registration opens Dec 1, 6:30 a.m.; everyone else Dec 2, 6:30 a.m.',
      ]);
      // Never told Dec 1 is theirs: both mornings, each with who it is for.
      expect(await whatOf(inDoubt.familyId)).toEqual([
        'Markham Winter 2027 registration opens Dec 1, 6:30 a.m. if they live in Markham, otherwise Dec 2, 6:30 a.m.',
      ]);
      expect(await whatOf(vaughanFamily.familyId)).toEqual([
        'Vaughan Winter 2027 registration opens Dec 3, 9:00 a.m.',
      ]);
      // The tell waits until the earliest morning it may be for.
      expect((await tells(inDoubt.familyId))[0]?.worthlessAfter).toEqual(
        new Date('2026-12-01T11:30:00Z'),
      );

      // The coach reads the same date for each family as its tell.
      expect(await coachOf(resident)).toMatchObject([
        {
          town: 'Markham',
          opensFor: 'Dec 1, 6:30 a.m.',
          residentsFirst: true,
          generalOpens: 'Dec 2, 6:30 a.m.',
        },
      ]);
      expect(await coachOf(inDoubt)).toMatchObject([
        {
          town: 'Markham',
          opensFor: 'Dec 1, 6:30 a.m. if they live in Markham, otherwise Dec 2, 6:30 a.m.',
          residentsFirst: false,
          generalOpens: null,
        },
      ]);
      expect(await coachOf(vaughanFamily)).toMatchObject([
        { town: 'Vaughan', opensFor: 'Dec 3, 9:00 a.m.', generalOpens: null },
      ]);
    });
  }

  it('a family whose residency is in doubt hears one date when it is the same for both', async () => {
    const inDoubt = await seedFamily('L3T 1A1');
    const same = { ...residents, date: '2026-12-02' };
    await runCityRegistrationSweep(db.database, deps(york([same, nonResidents])), NOW);
    expect(await whatOf(inDoubt.familyId)).toEqual([
      'Markham Winter 2027 registration opens Dec 2, 6:30 a.m.',
    ]);
  });

  it("a page with no date for everyone keeps the residents' date for residents, and names nothing for a family in doubt", async () => {
    // The family whose residency is in doubt loads first: it must not decide the city.
    const inDoubt = await seedFamily('L3T 1A1', 1, FIRST);
    const resident = await seedFamily('L3P 1A1', 1, LAST);
    const unlabelled: PageDate = {
      kind: 'unclassified_open',
      date: '2026-12-03',
      time: '06:30',
      evidence: ['Winter Registration: December 3, 2026, at 6:30 AM'],
    };

    const result = await runCityRegistrationSweep(
      db.database,
      deps(york([residents, unlabelled])),
      NOW,
    );

    expect(await readingStatuses()).toEqual(['verified']);
    expect(result).toMatchObject({ verified: 1, notFound: 0, queued: 1, notKnown: 1, past: 0 });
    expect(await whatOf(resident.familyId)).toEqual([
      'Markham Winter 2027 registration opens Dec 1, 6:30 a.m.',
    ]);
    expect(await coachOf(resident)).toMatchObject([{ opensFor: 'Dec 1, 6:30 a.m.' }]);
    expect(await whatOf(inDoubt.familyId)).toEqual([]);
    expect(await coachOf(inDoubt)).toEqual([]);
  });

  it('Toronto: each district hears its own morning, and none hears the Free Centres one', async () => {
    const districts = {
      toronto_east_york: await seedFamily('M4C 1A1'),
      etobicoke_york: await seedFamily('M9A 1A1'),
      north_york: await seedFamily('M2N 0A1'),
      scarborough: await seedFamily('M1B 1A1'),
    };
    // Toronto's Winter 2027 table as read 2026-11-12, one passage per row.
    const toronto = scripted({
      read: () =>
        page(TORONTO_PAGE, [
          {
            kind: 'unclassified_open',
            date: '2026-12-01',
            time: '07:00',
            evidence: ['Tuesday, December 1, 7 a.m.', 'Free Centres Tuesday, December 1, 7 a.m.'],
          },
          {
            kind: 'unclassified_open',
            date: '2026-12-08',
            time: '07:00',
            evidence: [
              'Tuesday, December 8, 7 a.m.',
              'Toronto, East York and Etobicoke Tuesday, December 8, 7 a.m.',
            ],
          },
          {
            kind: 'unclassified_open',
            date: '2026-12-09',
            time: '07:00',
            evidence: [
              'Wednesday, December 9, 7 a.m.',
              'North York and Scarborough Wednesday, December 9, 7 a.m.',
            ],
          },
        ]),
    });

    // Four districts, three lookups a run: the fourth is reached the next hour.
    await runCityRegistrationSweep(db.database, deps(toronto), NOW);
    await runCityRegistrationSweep(db.database, deps(toronto), new Date(NOW.getTime() + 3_600_000));

    expect(toronto.reads.map((target) => target.cycleLabel).sort()).toEqual([
      'Winter 2027 (etobicoke york)',
      'Winter 2027 (north york)',
      'Winter 2027 (scarborough)',
      'Winter 2027 (toronto east york)',
    ]);
    const heard = Object.fromEntries(
      await Promise.all(
        Object.entries(districts).map(async ([district, family]) => [
          district,
          await whatOf(family.familyId),
        ]),
      ),
    );
    expect(heard).toEqual({
      toronto_east_york: ['Toronto Winter 2027 registration opens Dec 8, 7:00 a.m.'],
      etobicoke_york: ['Toronto Winter 2027 registration opens Dec 8, 7:00 a.m.'],
      north_york: ['Toronto Winter 2027 registration opens Dec 9, 7:00 a.m.'],
      scarborough: ['Toronto Winter 2027 registration opens Dec 9, 7:00 a.m.'],
    });
  });
});

describe('one transient failure never cancels a known date or a waiting tell', () => {
  const stale = new Date(NOW.getTime() + REVERIFY_VERIFIED_MS + 60_000);
  const unread = (reason: 'timeout' | 'network_error' | 'http_server_error' | 'extract_failed') =>
    scripted({
      read: (): LiveRegistrationReading => ({
        sourceUrl: SUDBURY_PAGE,
        checkedAt: stale,
        reader: 'ai',
        status: 'unreadable',
        reason,
      }),
    });

  it('a held tell survives a re-read that timed out, and the coach keeps the date', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    await db.database
      .update(schema.proactiveCandidates)
      .set({ status: 'held', holdUntil: new Date('2026-12-09T14:00:00Z') })
      .where(eq(schema.proactiveCandidates.familyId, family.familyId));

    // Each failure a turn later: a lookup that did not finish waits before the next.
    let at = stale;
    for (const reason of [
      'timeout',
      'network_error',
      'http_server_error',
      'extract_failed',
    ] as const) {
      const failing = unread(reason);
      at = new Date(at.getTime() + REVERIFY_NOT_FOUND_MS);
      const result = await runCityRegistrationSweep(db.database, deps(failing), at);
      expect({ reason, result }).toMatchObject({
        reason,
        result: { retry: 1, notFound: 0, superseded: 0 },
      });
      // The known page did not answer: no fresh search on the strength of that.
      expect(failing.searches).toEqual([]);
    }
    expect(await readingStatuses()).toEqual(['verified']);
    const [held] = await tells(family.familyId);
    expect(held).toMatchObject({ status: 'held' });
    expect(
      await ownCityRegistrationContext(
        db.database,
        family.familyId,
        family.parentIds[0] as string,
        at,
      ),
    ).toMatchObject([{ town: 'Greater Sudbury', opensFor: 'Dec 16, 8:00 a.m.' }]);

    // The page reads fine again: the same tell stands, nothing new is queued.
    const again = await runCityRegistrationSweep(
      db.database,
      deps(scripted()),
      new Date(at.getTime() + REVERIFY_NOT_FOUND_MS),
    );
    expect(again).toMatchObject({ verified: 1, queued: 0, duplicate: 1, superseded: 0 });
    expect((await tells(family.familyId)).map((row) => row.status)).toEqual(['held']);
  });

  it('a page that could not be verified (not "says later") keeps the known date', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    const shaky = scripted({
      read: () => ({
        sourceUrl: SUDBURY_PAGE,
        checkedAt: stale,
        reader: 'ai',
        status: 'unverified',
        reason: 'low_confidence',
        partialDates: [],
      }),
    });
    const result = await runCityRegistrationSweep(db.database, deps(shaky), stale);
    expect(result).toMatchObject({ superseded: 0, notFound: 0, retry: 1 });
    expect((await tells(family.familyId)).map((row) => row.status)).toEqual(['queued']);
    expect(
      await ownCityRegistrationContext(
        db.database,
        family.familyId,
        family.parentIds[0] as string,
        stale,
      ),
    ).toHaveLength(1);
  });

  it('only the known page saying "later" takes a date back: no sibling page, no page that said nothing, no reading with no date for this family', async () => {
    const EARLY_LOCAL = 'https://www.toronto.ca/explore-enjoy/early-local-registration/';
    const SUDBURY_FALL = 'https://www.greatersudbury.ca/play/recreation/fall-programs/';
    const unverified = (url: string, reason: string): LiveRegistrationReading =>
      ({
        sourceUrl: url,
        checkedAt: stale,
        reader: 'ai',
        status: 'unverified',
        reason,
        partialDates: [],
      }) as LiveRegistrationReading;
    const cases: Array<{
      name: string;
      postal: string;
      town: string;
      lookup: () => ReturnType<typeof scripted>;
    }> = [
      {
        name: 'known page unconfirmed + a residents-only page for a district family',
        postal: 'M2N 0A1',
        town: 'Toronto',
        lookup: () =>
          scripted({
            search: () => ({
              outcome: 'pages',
              municipality: 'City of Toronto',
              urls: [TORONTO_PAGE, EARLY_LOCAL],
            }),
            read: (target) =>
              target.sourceUrl === TORONTO_PAGE
                ? unverified(TORONTO_PAGE, 'uncorroborated')
                : {
                    ...(verified(
                      EARLY_LOCAL,
                      '2026-12-01',
                      '07:00',
                    ) as VerifiedRegistrationReading),
                    dates: [
                      {
                        kind: 'resident_open',
                        date: '2026-12-01',
                        time: '07:00',
                        evidence: ['Tuesday, December 1, at 7 a.m. for eligible residents'],
                      },
                    ],
                  },
          }),
      },
      {
        name: 'known page low confidence + a sibling page about another season',
        postal: 'P3A 1A1',
        town: 'Greater Sudbury',
        lookup: () =>
          scripted({
            search: () => ({
              outcome: 'pages',
              municipality: 'City of Greater Sudbury',
              urls: [SUDBURY_PAGE, SUDBURY_FALL],
            }),
            read: (target) =>
              target.sourceUrl === SUDBURY_PAGE
                ? unverified(SUDBURY_PAGE, 'low_confidence')
                : unverified(SUDBURY_FALL, 'different_cycle_only'),
          }),
      },
      {
        name: 'known page said nothing + a search that did not finish',
        postal: 'P3A 1A1',
        town: 'Greater Sudbury',
        lookup: () =>
          scripted({
            search: () => ({ outcome: 'failed', reason: 'stopped:pause_turn' }),
            read: () => unverified(SUDBURY_PAGE, 'no_dates_for_cycle'),
          }),
      },
      {
        name: 'known page read the same date as a preview this time',
        postal: 'P3A 1A1',
        town: 'Greater Sudbury',
        lookup: () =>
          scripted({
            read: () => ({
              ...(verified(SUDBURY_PAGE, '2026-12-16', '08:00') as VerifiedRegistrationReading),
              dates: [{ kind: 'preview', date: '2026-12-16', time: '08:00', evidence: ['x'] }],
            }),
          }),
      },
    ];
    for (const { name, postal, town, lookup } of cases) {
      const family = await seedFamily(postal);
      await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
      await db.database
        .update(schema.proactiveCandidates)
        .set({ status: 'held', holdUntil: new Date('2026-12-01T14:00:00Z') })
        .where(eq(schema.proactiveCandidates.familyId, family.familyId));

      const result = await runCityRegistrationSweep(db.database, deps(lookup()), stale);

      expect({ name, result }).toMatchObject({ name, result: { superseded: 0, notFound: 0 } });
      expect({ name, statuses: (await tells(family.familyId)).map((row) => row.status) }).toEqual({
        name,
        statuses: ['held'],
      });
      expect({ name, readings: await readingStatuses() }).toEqual({
        name,
        readings: ['verified'],
      });
      expect(
        await ownCityRegistrationContext(
          db.database,
          family.familyId,
          family.parentIds[0] as string,
          stale,
        ),
      ).toMatchObject([{ town }]);
      await db.exec('truncate table families, users, city_registration_readings cascade');
    }
  });

  it('a date the page confirms again after it said "later" is queued again', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    const later = scripted({
      read: () => ({
        sourceUrl: SUDBURY_PAGE,
        checkedAt: stale,
        reader: 'ai',
        status: 'unverified',
        reason: 'announced_later',
        partialDates: [],
      }),
    });
    await runCityRegistrationSweep(db.database, deps(later), stale);
    expect((await tells(family.familyId)).map((row) => row.status)).toEqual(['dropped']);

    const back = new Date(stale.getTime() + 3 * 86_400_000);
    const result = await runCityRegistrationSweep(db.database, deps(scripted()), back);
    expect(result).toMatchObject({ verified: 1, queued: 1, duplicate: 0 });
    const [tell] = await tells(family.familyId);
    expect(tell).toMatchObject({
      status: 'queued',
      reason: null,
      what: 'Greater Sudbury Winter 2027 registration opens Dec 16, 8:00 a.m.',
    });
  });

  it('a re-read that drops the printed time is the same opening: no second tell', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    await db.database
      .update(schema.proactiveCandidates)
      .set({ status: 'sent' })
      .where(eq(schema.proactiveCandidates.familyId, family.familyId));
    const noTime = scripted({ read: () => verified(SUDBURY_PAGE, '2026-12-16', null) });
    const result = await runCityRegistrationSweep(db.database, deps(noTime), stale);
    expect(result).toMatchObject({ verified: 1, queued: 0, duplicate: 1 });
    expect((await tells(family.familyId)).map((row) => row.status)).toEqual(['sent']);
  });

  it('tells the coach a text is coming only for the parent whose own tell is waiting', async () => {
    const family = await seedFamily('P3A 1A1', 2);
    const [first, second] = family.parentIds as [string, string];
    const onlyFirst = (): OutboundGatePorts => ({
      ...openGate(),
      channelEnrolled: async (parentUserId) => parentUserId === first,
    });
    await runCityRegistrationSweep(db.database, deps(scripted(), { buildGate: onlyFirst }), NOW);
    expect((await tells(family.familyId)).map((row) => row.parentUserId)).toEqual([first]);
    expect(
      await ownCityRegistrationContext(db.database, family.familyId, first, NOW),
    ).toMatchObject([{ watching: true }]);
    expect(
      await ownCityRegistrationContext(db.database, family.familyId, second, NOW),
    ).toMatchObject([{ watching: false }]);
  });
});

describe("a lookup that writes no reading still moves the city's next turn", () => {
  const HOUR = 3_600_000;
  const failingSearch = () =>
    scripted({ search: () => ({ outcome: 'failed', reason: 'stopped:pause_turn' }) });

  it('a city whose opening has passed is not looked up again, so it never holds a turn', async () => {
    const family = await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    // After the doors opened, the page's yearless row no longer pins a year: every re-read
    // would come back unconfirmed, for the rest of the season.
    const yearless = scripted({
      read: (): LiveRegistrationReading => ({
        sourceUrl: SUDBURY_PAGE,
        checkedAt: NOW,
        reader: 'ai',
        status: 'unverified',
        reason: 'incomplete_date',
        partialDates: [{ kind: 'unclassified_open', quote: 'Wednesday, December 16, 8 a.m.' }],
      }),
    });
    for (const at of ['2026-12-20T15:00:00Z', '2026-12-20T16:00:00Z', '2027-01-10T15:00:00Z']) {
      const result = await runCityRegistrationSweep(db.database, deps(yearless), new Date(at));
      expect({ at, result }).toMatchObject({ at, result: { lookedUp: 0, retry: 0, past: 1 } });
    }
    expect(yearless.reads).toEqual([]);
    expect(yearless.searches).toEqual([]);
    expect((await tells(family.familyId)).map((row) => row.status)).toEqual(['queued']);
  });

  it('a lookup that did not finish is asked again next hour, then less often, never every hour', async () => {
    await seedFamily('P3A 1A1');
    const failing = failingSearch();
    const looked: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const result = await runCityRegistrationSweep(
        db.database,
        deps(failing),
        new Date(NOW.getTime() + hour * HOUR),
      );
      if (result.lookedUp > 0) looked.push(hour);
    }
    // The next sweep first, then each wait twice the last.
    expect(looked).toEqual([0, 1, 3, 7, 15]);
    // Still not a reading: the coach has nothing, and nothing says "not found".
    expect(
      (await db.database.select().from(schema.cityRegistrationReadings)).filter(
        (row) => row.status !== 'retry',
      ),
    ).toEqual([]);
  });

  it('the wait between unfinished lookups stops growing at the "not found" interval', async () => {
    await seedFamily('P3A 1A1');
    const failing = failingSearch();
    let at = NOW.getTime();
    const gaps: number[] = [];
    let last = at;
    for (let step = 0; step < 400; step++) {
      const result = await runCityRegistrationSweep(db.database, deps(failing), new Date(at));
      if (result.lookedUp > 0) {
        if (at !== NOW.getTime()) gaps.push(at - last);
        last = at;
      }
      at += HOUR;
      if (gaps.length >= 8) break;
    }
    expect(Math.max(...gaps)).toBe(REVERIFY_NOT_FOUND_MS);
  });

  it('cities whose lookups keep failing never starve a city that is due', async () => {
    // The three busiest cities fail every time; the quiet one must still be read.
    for (let i = 0; i < 3; i++) await seedFamily('M2N 0A1');
    for (let i = 0; i < 3; i++) await seedFamily('M1B 1A1');
    for (let i = 0; i < 3; i++) await seedFamily('M4C 1A1');
    const quiet = await seedFamily('P3A 1A1');
    const lookup = scripted({
      search: (place) =>
        place.city === 'Toronto'
          ? { outcome: 'failed', reason: 'stopped:pause_turn' }
          : { outcome: 'pages', municipality: 'City of Greater Sudbury', urls: [SUDBURY_PAGE] },
    });
    for (let hour = 0; hour < 6; hour++) {
      await runCityRegistrationSweep(
        db.database,
        deps(lookup),
        new Date(NOW.getTime() + hour * HOUR),
      );
    }
    expect(lookup.searches.map((s) => s.city)).toContain('Greater Sudbury');
    expect(await tells(quiet.familyId)).toHaveLength(1);
  });
});

describe("a parent mid-signup: does their postal code's town have its own opening", () => {
  it('reads the town off the code, and answers only from a verified opening still ahead', async () => {
    // No reading for the town yet.
    expect(await postalOwnCityOpens(db.database, 'P3A', NOW)).toBe(false);
    await seedFamily('P3A 1A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    expect(await postalOwnCityOpens(db.database, 'P3A', NOW)).toBe(true);
    expect(await postalOwnCityOpens(db.database, 'P3A 1A1', NOW)).toBe(true);
    // Another town, and the same town once its doors have opened.
    expect(await postalOwnCityOpens(db.database, 'K2P', NOW)).toBe(false);
    expect(await postalOwnCityOpens(db.database, 'P3A', new Date('2026-12-17T15:00:00Z'))).toBe(
      false,
    );
    // The kill switch.
    vi.stubEnv(OWN_CITY_REGISTRATION_ENABLED_ENV, 'false');
    expect(await postalOwnCityOpens(db.database, 'P3A', NOW)).toBe(false);
  });

  it("reads a Toronto code's own district", async () => {
    await seedFamily('M2N 0A1');
    await runCityRegistrationSweep(db.database, deps(scripted()), NOW);
    expect(await postalOwnCityOpens(db.database, 'M2N', NOW)).toBe(true);
    // Toronto, East York: a district with no reading of its own.
    expect(await postalOwnCityOpens(db.database, 'M4C', NOW)).toBe(false);
  });
});

describe("the cache of each city's official site", () => {
  const TORONTO = { city: 'Toronto', provinceOrState: 'Ontario', country: 'Canada' };
  /** Wikidata for Toronto, as it answered 2026-11-12. */
  const wikidata = (asked: string[] = []) => ({
    search: async () => {
      asked.push('search');
      return { search: [{ id: 'Q172', label: 'Toronto' }] };
    },
    sparql: async () => {
      asked.push('sparql');
      return {
        results: {
          bindings: [
            {
              item: { value: 'http://www.wikidata.org/entity/Q172' },
              site: { value: 'https://www.toronto.ca/' },
            },
          ],
        },
      };
    },
  });

  it('asks the source once per municipality while fresh, and keeps its source', async () => {
    const asked: string[] = [];
    const source = wikidata(asked);
    const first = await cachedOfficialSite(db.database, source, TORONTO, NOW);
    const again = await cachedOfficialSite(
      db.database,
      source,
      TORONTO,
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(first).toEqual({
      status: 'found',
      host: 'toronto.ca',
      website: 'https://www.toronto.ca/',
      source: 'wikidata:Q172',
    });
    expect(again).toEqual(first);
    expect(asked).toEqual(['search', 'sparql']);
    const [row] = await db.database.select().from(schema.cityOfficialSites);
    expect(row).toMatchObject({
      municipalityKey: 'toronto|ontario|canada|',
      source: 'wikidata:Q172',
    });
  });

  it('a source that does not answer leaves the last answer standing, and is a retry with none', async () => {
    const down = {
      search: async () => {
        throw new TypeError('fetch failed');
      },
      sparql: async () => ({}),
    };
    expect(await cachedOfficialSite(db.database, down, TORONTO, NOW)).toEqual({
      status: 'retry',
      reason: 'source_failed:TypeError',
    });
    expect(await db.database.select().from(schema.cityOfficialSites)).toEqual([]);

    await cachedOfficialSite(db.database, wikidata(), TORONTO, NOW);
    const stale = new Date(NOW.getTime() + RECHECK_FOUND_MS + 60_000);
    expect(await cachedOfficialSite(db.database, down, TORONTO, stale)).toMatchObject({
      status: 'found',
      host: 'toronto.ca',
    });
  });
});
