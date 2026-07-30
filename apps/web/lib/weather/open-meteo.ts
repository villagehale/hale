import { type LatLng, geocodeArea } from '~/lib/village/geocode';

/**
 * The weather adapter (VIL-238 · M3, absorbing F13's V1b).
 *
 * Weather is an INPUT to a decision, never a claim Hale makes on its own: the radar
 * uses it to place an outdoor pick on the day it will not be rained out, and to prefer
 * indoors when the weekend is wet. Two consequences shape this module:
 *
 * 1. RULE #1 — only COARSE coordinates ever leave the process. The lookup takes an FSA
 *    (the first three characters of a postal code, ~7 km across), resolves it to that
 *    area's CENTROID, and rounds to {@link COARSE_COORD_DECIMALS} decimal places
 *    (~1 km) before it is sent. A family's address, their postal code, and their
 *    precise coordinates never reach a weather provider — the provider learns only
 *    "somewhere in this part of the city", which is what a forecast needs anyway.
 *
 * 2. It DEGRADES, never throws. A missing centroid, a provider outage, a body that
 *    isn't a forecast — all yield an empty outlook. A parent mid-intake gets a
 *    season-appropriate pick with no weather claim attached; they never get an error,
 *    and the radar is never blocked on a free weather API being up.
 *
 * Provider: Open-Meteo's public forecast API — keyless, no account, no attribution
 * requirement, and it takes coordinates directly (so nothing but the rounded centroid
 * is ever sent). It publishes no Canadian AQHI, so air quality is deliberately NOT
 * modelled here rather than approximated with a foreign index.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Coordinate precision sent to the provider. Two decimals is ~1.1 km — enough to
 * place a forecast, far too coarse to place a home (rule #1). */
export const COARSE_COORD_DECIMALS = 2;

/** Above this chance of precipitation, an outdoor plan is a bad suggestion. */
const WET_THRESHOLD_PCT = 50;
/** Outside this band an outdoor plan stops being kind: deep cold at one end, heat
 * warning territory at the other. An ordinary cold Toronto winter day stays in. */
const MIN_OUTDOOR_TEMP_C = -12;
const MAX_OUTDOOR_TEMP_C = 33;

/** One day's forecast for a coarse area. Only the two facts a plan actually turns on. */
export interface DailyOutlook {
  /** Calendar date in the AREA's local zone, `YYYY-MM-DD`. */
  date: string;
  /** Highest chance of precipitation that day, 0–100. */
  precipitationChancePct: number;
  /** The day's high, in degrees Celsius. */
  highTempC: number;
}

export interface WeatherPort {
  /** The next `days` days for a COARSE area (an FSA), oldest first. Empty when the
   * outlook cannot be established — never an exception. */
  getDailyOutlook(areaCoarse: string, days: number): Promise<DailyOutlook[]>;
}

/** Whether a day is a reasonable one to send a family outside. Pure, so the radar's
 * weather rule is unit-testable without a network. */
export function isOutdoorFriendly(day: DailyOutlook): boolean {
  return outdoorBlocker(day) === null;
}

/** Why a day is a bad one to send a family outside, or null when it isn't. The reason
 * is needed, not just the verdict: a message that swaps a family indoors has to say
 * WHICH fact it is acting on, and "it's going to rain" on a merely freezing day is a
 * fabrication even though the swap itself is right. */
export function outdoorBlocker(day: DailyOutlook): 'wet' | 'cold' | 'hot' | null {
  if (day.precipitationChancePct > WET_THRESHOLD_PCT) return 'wet';
  if (day.highTempC < MIN_OUTDOOR_TEMP_C) return 'cold';
  if (day.highTempC > MAX_OUTDOOR_TEMP_C) return 'hot';
  return null;
}

function numberAt(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  const entry = value[index];
  return typeof entry === 'number' && Number.isFinite(entry) ? entry : null;
}

/**
 * Map an Open-Meteo forecast body to daily outlooks. A day missing either fact is
 * DROPPED rather than defaulted — a fabricated 0% chance of rain would put a family
 * outside in a downpour, which is worse than having no opinion about that day.
 */
export function parseDailyOutlook(raw: unknown): DailyOutlook[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const daily = (raw as { daily?: unknown }).daily;
  if (typeof daily !== 'object' || daily === null) return [];
  const { time, precipitation_probability_max: precip, temperature_2m_max: high } = daily as {
    time?: unknown;
    precipitation_probability_max?: unknown;
    temperature_2m_max?: unknown;
  };
  if (!Array.isArray(time)) return [];

  const outlooks: DailyOutlook[] = [];
  for (const [index, date] of time.entries()) {
    if (typeof date !== 'string') continue;
    const chance = numberAt(precip, index);
    const temp = numberAt(high, index);
    if (chance === null || temp === null) continue;
    outlooks.push({ date, precipitationChancePct: chance, highTempC: temp });
  }
  return outlooks;
}

export interface OpenMeteoDeps {
  /** The COARSE area's centroid, or null when it can't be resolved. */
  resolveCenter: (areaCoarse: string) => Promise<LatLng | null>;
  /** The provider call, already given ROUNDED coordinates. */
  fetchForecast: (lat: number, lng: number, days: number) => Promise<unknown>;
}

/** Round to the coarse grid before anything leaves the process (rule #1). */
function coarsen(value: number): number {
  return Number(value.toFixed(COARSE_COORD_DECIMALS));
}

async function fetchOpenMeteo(lat: number, lng: number, days: number): Promise<unknown> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('daily', 'precipitation_probability_max,temperature_2m_max');
  // The provider resolves the zone from the coordinates, so the returned dates are the
  // AREA's local calendar days — the same days the family's weekend is measured in.
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(days));
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`open-meteo forecast failed: ${response.status}`);
  }
  return response.json();
}

export function defaultOpenMeteoDeps(): OpenMeteoDeps {
  return { resolveCenter: (area) => geocodeArea(area), fetchForecast: fetchOpenMeteo };
}

export function createOpenMeteoWeather(deps: OpenMeteoDeps = defaultOpenMeteoDeps()): WeatherPort {
  return {
    async getDailyOutlook(areaCoarse, days) {
      try {
        const center = await deps.resolveCenter(areaCoarse);
        if (!center) return [];
        const raw = await deps.fetchForecast(coarsen(center.lat), coarsen(center.lng), days);
        return parseDailyOutlook(raw);
      } catch (err) {
        // A weatherless radar is a working radar (see the module note) — log and move on.
        console.error({ err, areaCoarse }, 'weather: outlook unavailable — deciding without it');
        return [];
      }
    },
  };
}

/** A scripted outlook for tests. Real forecast QUALITY is the provider's problem; what
 * the radar's tests need is a deterministic sky. */
export function fakeWeather(days: readonly DailyOutlook[]): WeatherPort {
  return {
    async getDailyOutlook(_areaCoarse, requested) {
      return days.slice(0, requested);
    },
  };
}
