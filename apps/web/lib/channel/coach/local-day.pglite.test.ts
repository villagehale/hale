import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type WeatherPort, fakeWeather } from '~/lib/weather/open-meteo';
import { forecastFacts, loadCoachForecast, loadCoachTimeZone } from './local-day';

let db: TestDb;
let family: { familyId: string; parentUserId: string };

const WET_MONDAY = { date: '2026-10-12', precipitationChancePct: 80, highTempC: 9 };
const DRY_TUESDAY = { date: '2026-10-13', precipitationChancePct: 5, highTempC: 16 };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setZone(timezone: string) {
  await db.database
    .update(schema.users)
    .set({ timezone })
    .where(eq(schema.users.id, family.parentUserId));
}

async function setArea(areaCoarse: string | null) {
  await db.database
    .update(schema.families)
    .set({ areaCoarse })
    .where(eq(schema.families.id, family.familyId));
}

describe('loadCoachTimeZone (VIL-435)', () => {
  it("reads the primary parent's own zone", async () => {
    await setZone('America/Chicago');
    expect(await loadCoachTimeZone(db.database, family.familyId)).toBe('America/Chicago');
  });

  it('is null, not Toronto, when the zone was never set (UTC is the column default)', async () => {
    await setZone('UTC');
    expect(await loadCoachTimeZone(db.database, family.familyId)).toBeNull();
  });

  it('is null for a family with no primary parent', async () => {
    const stranger = '99999999-9999-4999-8999-999999999999';
    expect(await loadCoachTimeZone(db.database, stranger)).toBeNull();
  });
});

describe('loadCoachForecast (VIL-435)', () => {
  it("returns the area's outlook with each day's weekday named", async () => {
    await setArea('K1A');
    const asked: string[] = [];
    const weather: WeatherPort = {
      async getDailyOutlook(area, days) {
        asked.push(area);
        return fakeWeather([WET_MONDAY, DRY_TUESDAY]).getDailyOutlook(area, days);
      },
    };

    const forecast = await loadCoachForecast(db.database, family.familyId, weather);

    expect(asked).toEqual(['K1A']);
    expect(forecast).toEqual([
      { ...WET_MONDAY, weekday: 'Monday' },
      { ...DRY_TUESDAY, weekday: 'Tuesday' },
    ]);
  });

  it('asks no provider and returns nothing when no area is on file', async () => {
    await setArea(null);
    const getDailyOutlook = vi.fn(async () => [WET_MONDAY]);

    expect(await loadCoachForecast(db.database, family.familyId, { getDailyOutlook })).toEqual([]);
    expect(getDailyOutlook).not.toHaveBeenCalled();
  });

  it('goes without, and says so, when the provider is slower than the turn waits', async () => {
    await setArea('K1A');
    const slow: WeatherPort = {
      getDailyOutlook: () => new Promise(() => {}),
    };

    expect(await loadCoachForecast(db.database, family.familyId, slow, 5)).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      { timeoutMs: 5 },
      expect.stringContaining('forecast slower'),
    );
  });
});

describe('forecastFacts', () => {
  it('names the weekday of the calendar date itself, whatever the server zone', () => {
    expect(
      forecastFacts([{ date: '2026-11-26', precipitationChancePct: 0, highTempC: 3 }]),
    ).toEqual([
      { date: '2026-11-26', precipitationChancePct: 0, highTempC: 3, weekday: 'Thursday' },
    ]);
  });
});
