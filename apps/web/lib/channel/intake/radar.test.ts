import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { type DailyOutlook, fakeWeather } from '~/lib/weather/open-meteo';
import { WATCH_OFFER } from './copy.js';
import { makeFakeDb } from './fakes.js';
import { createRadarComposer } from './radar.js';

/**
 * The radar composer's IO seam: read what Hale knows about this family, decide, and
 * render. The model is NOT exercised here — `client: null` is the real production path
 * when voice is unavailable, and it lands on the deterministic render, so these tests
 * assert the grounded facts rather than a mocked model's words (rule #8).
 *
 * The fake database does not evaluate WHERE clauses (see fakes.ts), so the family
 * scoping and the superseded/standing predicates are SQL-side and not asserted here;
 * what IS asserted is the wiring — which tables are read, what reaches the weather
 * port, and that nothing ungrounded reaches the parent.
 */

const NOW = new Date('2026-07-31T15:00:00.000Z'); // a Friday
const FAMILY_ID = 'fam-1';

function seedCandidate(db: ReturnType<typeof makeFakeDb>, overrides: Record<string, unknown> = {}) {
  db.db
    .insert(schema.villageCandidates)
    .values({
      familyId: FAMILY_ID,
      title: 'Library story time',
      kind: 'activity',
      summary: 'A weekly drop-in for little ones.',
      source: 'llm_only',
      confidence: 0.8,
      priceLevel: 'free',
      indoorOutdoor: 'indoor',
      ageRange: '3-5 years',
      childId: null,
      eventDate: null,
      seasons: null,
      venueName: null,
      ...overrides,
    } as never);
}

function seedWindow(db: ReturnType<typeof makeFakeDb>) {
  db.db
    .insert(schema.registrationWindows)
    .values({
      municipality: 'toronto',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
      previewAt: null,
      residentOpenAt: null,
      openAt: new Date('2026-08-11T10:30:00.000Z'),
      residentPriorityDays: null,
      waitlistResponseHours: null,
      ageMinMonths: 36,
      ageMaxMonths: 72,
      sourceUrl: 'https://www.toronto.ca/example',
      verifiedAt: new Date('2026-07-30T00:00:00.000Z'),
      notes: null,
    } as never);
}

function composer(db: ReturnType<typeof makeFakeDb>) {
  return createRadarComposer({
    database: db.db,
    weather: fakeWeather([]),
    client: null,
    now: () => NOW,
  });
}

const MAYA = { name: 'Maya', ageMonths: 48, agePrecision: 'years' } as const;

describe('createRadarComposer', () => {
  it('names a real candidate and a real registration window it read for this family', async () => {
    const db = makeFakeDb();
    seedCandidate(db);
    seedWindow(db);

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: 'M5V',
    });

    expect(payload.message).toContain('Library story time');
    expect(payload.message).toContain('Aug 11');
    expect(payload.itemCount).toBe(2);
    expect(payload.followUpNeeded).toBe(false);
  });

  it('never writes the watch question — the state machine appends it', async () => {
    const db = makeFakeDb();
    seedCandidate(db);

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: 'M5V',
    });

    expect(payload.message).not.toContain(WATCH_OFFER);
  });

  it('is honest, and asks for a follow-up, when it knows nothing yet', async () => {
    const db = makeFakeDb();

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: 'M5V',
    });

    // No candidates, no windows, and no children on file to key a checkpoint to: the
    // one shape where all three rungs are empty. It maps, and it says when the first
    // find lands — it does not shrug.
    expect(payload.message).toContain('Your first weekend find lands in a day or two.');
    expect(payload.itemCount).toBe(0);
    expect(payload.followUpNeeded).toBe(true);
  });

  it('reaches for the age checkpoint when this family has no window and no candidate', async () => {
    const db = makeFakeDb();
    const [mia] = (await db.db
      .insert(schema.children)
      .values({ familyId: FAMILY_ID, name: 'Mia', dateOfBirth: '2025-01-31' } as never)
      .returning()) as Array<{ id: string }>;

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [{ name: 'Mia', ageMonths: 18, agePrecision: 'months' }],
      areaCoarse: 'L7G',
    });

    // Halton Hills: no civic adapter, no registration windows, nothing discovered yet.
    // The child is 18 months old, and Ontario publishes a calendar against that.
    expect(payload.message).toContain('Mia');
    expect(payload.message).toContain('18 months');
    expect(payload.itemCount).toBe(1);
    // And the message SAYS it, so the caller can mark it told for every other surface
    // (lib/health/told.ts) — the 48h nudge is two days behind this one.
    expect(payload.checkpointTold).toBe(`immunization_18_months:${mia?.id}:0`);
  });

  it('tells no checkpoint when the two leads already fill the message', async () => {
    const db = makeFakeDb();
    seedCandidate(db);
    seedWindow(db);
    // Four years old in Toronto: three Ontario rows admit her, and none of them fits.
    db.db
      .insert(schema.children)
      .values({ familyId: FAMILY_ID, name: 'Maya', dateOfBirth: '2022-07-31' } as never);

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: 'M5V',
    });

    expect(payload.itemCount).toBe(2);
    // Nothing was told, so nothing may be marked told: a checkpoint suppressed off the
    // back of a message that never carried it is a reminder this family never gets.
    expect(payload.checkpointTold).toBeNull();
  });

  it('sends only the COARSE area to the weather port — never a postal code (rule #1)', async () => {
    const db = makeFakeDb();
    seedCandidate(db);
    const getDailyOutlook = vi.fn(async (_area: string, _days: number): Promise<DailyOutlook[]> => []);

    await createRadarComposer({
      database: db.db,
      weather: { getDailyOutlook },
      client: null,
      now: () => NOW,
    }).compose({ familyId: FAMILY_ID, children: [MAYA], areaCoarse: 'M5V' });

    expect(getDailyOutlook).toHaveBeenCalledTimes(1);
    expect(getDailyOutlook.mock.calls[0]?.[0]).toBe('M5V');
  });

  it('never surfaces a candidate belonging to a 13+ child (rule #1)', async () => {
    const db = makeFakeDb();
    const [teen] = (await db.db
      .insert(schema.children)
      .values({ familyId: FAMILY_ID, name: 'Ava', dateOfBirth: '2011-01-01' } as never)
      .returning()) as Array<{ id: string }>;
    seedCandidate(db, { title: 'Teen climbing night', childId: teen?.id, ageRange: 'all ages' });

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [{ name: 'Ava', ageMonths: 180, agePrecision: 'years' }],
      areaCoarse: 'M5V',
    });

    expect(payload.message).not.toContain('Teen climbing night');
    // The checkpoint block is the one thing a 13+ child's household still hears, and it
    // hears it in the GENERIC wording with no name attached (rule #1).
    expect(payload.message).toContain('A routine vaccine record check is due');
    expect(payload.message).not.toContain('Ava');
    expect(payload.itemCount).toBe(1);
  });

  it('still composes when the family has no postal-derived area at all', async () => {
    const db = makeFakeDb();

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: null,
    });

    expect(payload.message.length).toBeGreaterThan(0);
    expect(payload.followUpNeeded).toBe(true);
  });

  it('never lets a weather outage fail the intake', async () => {
    const db = makeFakeDb();
    seedCandidate(db);

    const payload = await createRadarComposer({
      database: db.db,
      weather: {
        getDailyOutlook: async () => {
          throw new Error('open-meteo is down');
        },
      },
      client: null,
      now: () => NOW,
    }).compose({ familyId: FAMILY_ID, children: [MAYA], areaCoarse: 'M5V' });

    expect(payload.message).toContain('Library story time');
  });
});
