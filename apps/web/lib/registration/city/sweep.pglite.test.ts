import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { LiveRegistrationReading, VerifiedRegistrationReading } from '../live-reading';
import type { RegistrationReader, RegistrationTarget } from '../read';
import { ownCityRegistrationContext } from './context';
import { OWN_CITY_REGISTRATION_ENABLED_ENV } from './flag';
import type { CityLookupDeps } from './lookup';
import { RECHECK_FOUND_MS, cachedOfficialSite } from './official-site';
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

    for (const reason of [
      'timeout',
      'network_error',
      'http_server_error',
      'extract_failed',
    ] as const) {
      const failing = unread(reason);
      const result = await runCityRegistrationSweep(db.database, deps(failing), stale);
      expect({ reason, result }).toMatchObject({
        reason,
        result: { retry: 1, notFound: 0, superseded: 0 },
      });
      // The known page did not answer: no fresh search on the strength of that.
      expect(failing.searches).toEqual([]);
    }
    expect(
      (await db.database.select().from(schema.cityRegistrationReadings)).map((row) => row.status),
    ).toEqual(['verified']);
    const [held] = await tells(family.familyId);
    expect(held).toMatchObject({ status: 'held' });
    expect(
      await ownCityRegistrationContext(
        db.database,
        family.familyId,
        family.parentIds[0] as string,
        stale,
      ),
    ).toMatchObject([{ town: 'Greater Sudbury', opensFor: 'Dec 16, 8:00 a.m.' }]);

    // The page reads fine again: the same tell stands, nothing new is queued.
    const again = await runCityRegistrationSweep(
      db.database,
      deps(scripted()),
      new Date(stale.getTime() + 3_600_000),
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
      expect(
        (await db.database.select().from(schema.cityRegistrationReadings)).map((r) => r.status),
      ).toEqual(['verified']);
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
