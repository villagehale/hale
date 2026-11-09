import type { Skill } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import type { LatLng } from '~/lib/village/geocode';
import {
  type DailyOutlook,
  type WeatherPort,
  createOpenMeteoWeather,
  defaultOpenMeteoDeps,
} from '~/lib/weather/open-meteo';
import type { LocalNow } from './local-now';

/**
 * THE DAY AS THE FAMILY LIVES IT (VIL-435): their local date and weekday, and the
 * forecast for their coarse area. Facts for the model to reason over (is today a holiday
 * there, is it a day for indoors), never a filter and never copy. Holidays have no table
 * here on purpose (Barton, 2026-10-25; lib/seasonal/moments.ts): the model is handed the
 * date and the place and works out what that day is.
 */

/** Today and the days after it. Enough for "this weekend" asked on a Monday. */
export const COACH_FORECAST_DAYS = 7;

/** A forecast read waits this long on the hot SMS path, then the turn goes without it. */
export const COACH_FORECAST_TIMEOUT_MS = 2500;

export interface ForecastDay extends DailyOutlook {
  weekday: string;
}

/** The outlook with each date's weekday named, so the model never does that sum. */
export function forecastFacts(outlooks: readonly DailyOutlook[]): ForecastDay[] {
  const weekday = new Intl.DateTimeFormat('en-CA', { weekday: 'long', timeZone: 'UTC' });
  return outlooks.map((day) => ({
    ...day,
    weekday: weekday.format(new Date(`${day.date}T12:00:00Z`)),
  }));
}

/** The context keys, each absent when unknown, so a turn without them keeps its bytes. */
export function localDayContext(
  localNow: LocalNow | null,
  forecast: readonly ForecastDay[],
): { localNow?: LocalNow; forecast?: ForecastDay[] } {
  return {
    ...(localNow ? { localNow } : {}),
    ...(forecast.length > 0 ? { forecast: [...forecast] } : {}),
  };
}

/** `null` returns the same skill object: the addendum rides only when a fact does. */
export function augmentCoachSkillForLocalDay(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
}

function fault(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** The family's own zone, or null. A failed read is logged by fault class and is null. */
export async function loadCoachTimeZone(
  database: Database,
  familyId: string,
): Promise<string | null> {
  try {
    return await knownHouseholdTimezone(database, familyId);
  } catch (err) {
    console.error({ fault: fault(err) }, 'coach: family time zone unavailable');
    return null;
  }
}

/**
 * Area centres already resolved by this process. The geocode is a paid Places call and a
 * family's coarse area does not move between texts, so it is asked once per instance.
 * Only a resolved centre is kept: a miss is asked again next turn.
 */
const centres = new Map<string, LatLng>();

let coachWeather: WeatherPort | undefined;

function productionCoachWeather(): WeatherPort {
  if (coachWeather) return coachWeather;
  const base = defaultOpenMeteoDeps();
  coachWeather = createOpenMeteoWeather({
    ...base,
    resolveCenter: async (area) => {
      const known = centres.get(area);
      if (known) return known;
      const centre = await base.resolveCenter(area);
      if (centre) centres.set(area, centre);
      return centre;
    },
  });
  return coachWeather;
}

/**
 * The forecast for the family's coarse area (rule #1: only the FSA's rounded centre ever
 * leaves, see open-meteo.ts), or empty. Empty when no area is on file, when the provider
 * is down (the port logs that), or when it is slower than the turn can wait (logged here).
 */
export async function loadCoachForecast(
  database: Database,
  familyId: string,
  weather: WeatherPort = productionCoachWeather(),
  timeoutMs: number = COACH_FORECAST_TIMEOUT_MS,
): Promise<ForecastDay[]> {
  try {
    const [family] = await database
      .select({ areaCoarse: schema.families.areaCoarse })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);
    const area = family?.areaCoarse?.trim();
    if (!area) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      weather.getDailyOutlook(area, COACH_FORECAST_DAYS),
      timedOut,
    ]).finally(() => clearTimeout(timer));
    if (outcome === 'timeout') {
      console.error({ timeoutMs }, 'coach: forecast slower than the turn waits - going without');
      return [];
    }
    return forecastFacts(outcome);
  } catch (err) {
    console.error({ fault: fault(err) }, 'coach: forecast unavailable');
    return [];
  }
}
