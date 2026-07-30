import { describe, expect, it, vi } from 'vitest';
import {
  COARSE_COORD_DECIMALS,
  createOpenMeteoWeather,
  fakeWeather,
  isOutdoorFriendly,
  parseDailyOutlook,
} from './open-meteo.js';

/**
 * The weather adapter. Expectations come from the F14 brief, not the implementation:
 *
 *   - only COARSE coordinates ever leave the process (rule #1) — an FSA centroid,
 *     rounded, never a family's address;
 *   - a failure of ANY kind (no centroid, a throwing fetch, a malformed body) yields
 *     an EMPTY outlook, never an exception: a weatherless radar still texts the parent
 *     a season-appropriate pick, and weather is never worth failing an intake over;
 *   - the outdoor-friendly predicate is pure and reads the two facts Open-Meteo
 *     actually returns.
 */

const OTTAWA = { lat: 45.42345678, lng: -75.69876543 };

function rawForecast(days: Array<{ date: string; precip: number; high: number }>): unknown {
  return {
    daily: {
      time: days.map((d) => d.date),
      precipitation_probability_max: days.map((d) => d.precip),
      temperature_2m_max: days.map((d) => d.high),
    },
  };
}

describe('parseDailyOutlook', () => {
  it('maps the daily arrays into one outlook per day', () => {
    const parsed = parseDailyOutlook(
      rawForecast([
        { date: '2026-08-01', precip: 10, high: 24.5 },
        { date: '2026-08-02', precip: 80, high: 19 },
      ]),
    );
    expect(parsed).toEqual([
      { date: '2026-08-01', precipitationChancePct: 10, highTempC: 24.5 },
      { date: '2026-08-02', precipitationChancePct: 80, highTempC: 19 },
    ]);
  });

  it('drops a day whose facts are incomplete rather than defaulting them', () => {
    const parsed = parseDailyOutlook({
      daily: {
        time: ['2026-08-01', '2026-08-02'],
        precipitation_probability_max: [10, null],
        temperature_2m_max: [24, 19],
      },
    });
    expect(parsed).toEqual([{ date: '2026-08-01', precipitationChancePct: 10, highTempC: 24 }]);
  });

  it('is empty for a body that is not a forecast at all', () => {
    expect(parseDailyOutlook({ error: true, reason: 'nope' })).toEqual([]);
    expect(parseDailyOutlook(null)).toEqual([]);
    expect(parseDailyOutlook('<html>')).toEqual([]);
  });
});

describe('isOutdoorFriendly', () => {
  it('accepts a dry day at a liveable temperature', () => {
    expect(isOutdoorFriendly({ date: '2026-08-01', precipitationChancePct: 10, highTempC: 24 })).toBe(
      true,
    );
  });

  it('rejects a likely-rain day', () => {
    expect(isOutdoorFriendly({ date: '2026-08-01', precipitationChancePct: 80, highTempC: 24 })).toBe(
      false,
    );
  });

  it('rejects deep cold and dangerous heat, but keeps an ordinary cold winter day', () => {
    expect(isOutdoorFriendly({ date: '2026-01-05', precipitationChancePct: 5, highTempC: -18 })).toBe(
      false,
    );
    expect(isOutdoorFriendly({ date: '2026-07-05', precipitationChancePct: 5, highTempC: 36 })).toBe(
      false,
    );
    expect(isOutdoorFriendly({ date: '2026-01-05', precipitationChancePct: 5, highTempC: -4 })).toBe(
      true,
    );
  });
});

describe('createOpenMeteoWeather', () => {
  it('sends only the COARSE centroid, rounded — never a precise coordinate (rule #1)', async () => {
    const fetchForecast = vi.fn(async () => rawForecast([{ date: '2026-08-01', precip: 5, high: 22 }]));
    const weather = createOpenMeteoWeather({
      resolveCenter: async () => OTTAWA,
      fetchForecast,
    });

    await weather.getDailyOutlook('K1A', 3);

    expect(fetchForecast).toHaveBeenCalledTimes(1);
    const [lat, lng, days] = fetchForecast.mock.calls[0] as unknown as [number, number, number];
    expect(lat).toBe(Number(OTTAWA.lat.toFixed(COARSE_COORD_DECIMALS)));
    expect(lng).toBe(Number(OTTAWA.lng.toFixed(COARSE_COORD_DECIMALS)));
    expect(days).toBe(3);
    // The rounding is what makes it coarse: the raw precision must not survive.
    expect(lat).not.toBe(OTTAWA.lat);
  });

  it('degrades to no outlook when the area has no resolvable centroid', async () => {
    const fetchForecast = vi.fn(async () => rawForecast([]));
    const weather = createOpenMeteoWeather({ resolveCenter: async () => null, fetchForecast });

    expect(await weather.getDailyOutlook('ZZZ', 3)).toEqual([]);
    expect(fetchForecast).not.toHaveBeenCalled();
  });

  it('degrades to no outlook when the forecast call throws — never to an exception', async () => {
    const weather = createOpenMeteoWeather({
      resolveCenter: async () => OTTAWA,
      fetchForecast: async () => {
        throw new Error('open-meteo is down');
      },
    });

    await expect(weather.getDailyOutlook('K1A', 3)).resolves.toEqual([]);
  });

  it('degrades to no outlook when the centroid lookup itself throws', async () => {
    const weather = createOpenMeteoWeather({
      resolveCenter: async () => {
        throw new Error('places is down');
      },
      fetchForecast: async () => rawForecast([]),
    });

    await expect(weather.getDailyOutlook('K1A', 3)).resolves.toEqual([]);
  });
});

describe('fakeWeather', () => {
  it('replays the scripted outlook, trimmed to the requested days', async () => {
    const days = [
      { date: '2026-08-01', precipitationChancePct: 5, highTempC: 22 },
      { date: '2026-08-02', precipitationChancePct: 90, highTempC: 18 },
    ];
    expect(await fakeWeather(days).getDailyOutlook('M5V', 1)).toEqual([days[0]]);
  });
});
