import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { TORONTO_FIRST_REC } from '~/lib/channel/rec-morning';
import { type DailyOutlook, fakeWeather } from '~/lib/weather/open-meteo';
import { WATCH_OFFER } from './copy.js';
import { makeFakeDb } from './fakes.js';
import { checkpointSurvivedCompose, createRadarComposer } from './radar.js';

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

  it('is honest, and asks for a follow-up, when it knows nothing yet in an unpinned town', async () => {
    const db = makeFakeDb();

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: 'L7G',
    });

    // Halton Hills: no civic adapter, no windows, no Toronto pin. Leftover mapping
    // plus the first-find beat — it does not shrug, and it does not steal the 555 pin.
    expect(payload.message).toContain('Your first weekend find lands in a day or two.');
    expect(payload.message).not.toBe(TORONTO_FIRST_REC);
    expect(payload.message).not.toContain('toronto.ca/OnlineReg');
    expect(payload.itemCount).toBe(0);
    expect(payload.followUpNeeded).toBe(true);
  });

  it('VIL-334: M1B still sends the Toronto pin when live lookup is empty', async () => {
    const db = makeFakeDb();

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [
        { name: 'Theo', ageMonths: 36, agePrecision: 'years' },
        { name: 'Cruz', ageMonths: 18, agePrecision: 'months' },
      ],
      areaCoarse: 'M1B',
    });

    expect(payload.message).toBe(TORONTO_FIRST_REC);
    expect(payload.message).not.toMatch(/still mapping|mapping what's near you/i);
    expect(payload.message).not.toContain('Your first weekend find lands in a day or two.');
    expect(payload.message).not.toContain(WATCH_OFFER);
    expect(payload.firstFindPromised).toBe(false);
    expect(payload.followUpNeeded).toBe(true);
  });

  it('VIL-334: other Toronto FSAs pin the same way — leftover mapping is not the Toronto first-hello', async () => {
    const db = makeFakeDb();

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [MAYA],
      areaCoarse: 'M5V',
    });

    expect(payload.message).toBe(TORONTO_FIRST_REC);
    expect(payload.message).not.toMatch(/still mapping|mapping what's near you/i);
  });

  it('never lets a health checkpoint ride the pre-consent first find (ads-week audit, 2026-08-28)', async () => {
    const db = makeFakeDb();
    db.db
      .insert(schema.children)
      .values({ familyId: FAMILY_ID, name: 'Mia', dateOfBirth: '2025-01-31' } as never);
    seedCandidate(db, { ageRange: '6-24 months' });

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [{ name: 'Mia', ageMonths: 18, agePrecision: 'months' }],
      areaCoarse: 'L7G',
    });

    // The first find IS the pre-consent message — the watch offer rides on it. An
    // 18-month-old is inside two reviewed vaccine windows, and neither may be said
    // before the parent has consented to being watched. The activity still goes.
    expect(payload.message).toContain('Library story time');
    expect(payload.message).not.toMatch(/vaccine|18 month|well-baby/i);
    // Nothing was told, so nothing is marked told: the post-consent 48h nudge is the
    // surface that raises it, and a told-marker here would silence that surface too.
    expect(payload.checkpointTold).toBeNull();
  });

  it('stays checkpoint-free even when the checkpoint is the only rung (pre-consent, ads-week audit)', async () => {
    const db = makeFakeDb();
    await db.db
      .insert(schema.children)
      .values({ familyId: FAMILY_ID, name: 'Mia', dateOfBirth: '2025-01-31' } as never)
      .returning();

    const payload = await composer(db).compose({
      familyId: FAMILY_ID,
      children: [{ name: 'Mia', ageMonths: 18, agePrecision: 'months' }],
      areaCoarse: 'L7G',
    });

    // Halton Hills: no civic adapter, no registration windows, nothing discovered yet.
    // The child is 18 months old and inside a reviewed window — but this message is the
    // PRE-CONSENT first find, so the honest empty-handed answer goes out instead, with
    // the first-find promise on it. The 48h nudge raises the checkpoint post-consent.
    expect(payload.message).not.toMatch(/vaccine|18 month|well-baby/i);
    expect(payload.message).toContain('Your first weekend find lands in a day or two.');
    expect(payload.itemCount).toBe(0);
    expect(payload.checkpointTold).toBeNull();
    expect(payload.firstFindPromised).toBe(true);
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
    // The checkpoint block used to be the one thing a 13+ household still heard here.
    // It no longer rides the pre-consent first find (ads-week audit, 2026-08-28) — the
    // post-consent nudge carries it in the generic wording. M5V is a Toronto FSA, so
    // the empty-lookup first-hello is the VIL-320 pin (VIL-334), still with no teen
    // name in it (rule #1).
    expect(payload.message).toBe(TORONTO_FIRST_REC);
    expect(payload.message).not.toContain('A routine vaccine record check is due');
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

describe('checkpointSurvivedCompose — the told-marker is earned by the text (review P0, 2026-08-11)', () => {
  const TASK = 'Book the Enhanced 18-month well-baby visit with your doctor';

  it('passes when a distinctive task word survives composition', () => {
    expect(
      checkpointSurvivedCompose(
        'While I map your area: the Enhanced well-baby visit is worth booking now.',
        TASK,
      ),
    ).toBe(true);
  });

  it('passes on the age phrase alone — a legitimate paraphrase', () => {
    expect(
      checkpointSurvivedCompose(
        'At 18 months Ontario does its big checkup - clinics book out fast.',
        TASK,
      ),
    ).toBe(true);
  });

  it('fails when the compose dropped the checkpoint entirely', () => {
    expect(
      checkpointSurvivedCompose(
        'Got it - I am mapping what is near you now. Your first weekend find lands in a day or two.',
        TASK,
      ),
    ).toBe(false);
  });

  it('generic words alone cannot fake a tell', () => {
    expect(
      checkpointSurvivedCompose('I will text you about your kids this month.', TASK),
    ).toBe(false);
  });
});
