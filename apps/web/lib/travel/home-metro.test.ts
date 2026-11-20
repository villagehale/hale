import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeOf } from '~/lib/channel/off-domain/place';
import { isAwayDestination, travelHomeOf } from './away';

const row = {
  country: null as string | null,
  province: null as string | null,
  city: null as string | null,
  postalCode: null as string | null,
  areaCoarse: null as string | null,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('family home metro', () => {
  const toronto = { ...row, country: 'Canada', areaCoarse: 'M1B' };

  it('keeps the GTA list while the flag is off, including a trailing newline', async () => {
    expect(await travelHomeOf(toronto)).toEqual({ status: 'gta' });
    vi.stubEnv('FAMILY_HOME_METRO_ENABLED', 'true\n');
    expect(await travelHomeOf(toronto)).toEqual({ status: 'gta' });
  });

  it('uses the one city on the row when the flag is on', async () => {
    vi.stubEnv('FAMILY_HOME_METRO_ENABLED', 'true');
    const place = await placeOf(toronto);
    expect(place).toMatchObject({ status: 'known', city: 'Toronto' });
    expect(await travelHomeOf(toronto)).toEqual({ status: 'city', city: 'Toronto' });
    // The code they gave is Toronto. A district a booking writes is not that city.
    expect(isAwayDestination('Scarborough', { status: 'city', city: 'Toronto' })).toBe(true);
    expect(isAwayDestination('Toronto', { status: 'city', city: 'Toronto' })).toBe(false);
    // Positive control: the city they named wins over a GTA-shaped code.
    expect(
      await travelHomeOf({ ...row, country: 'Canada', city: 'Ottawa', areaCoarse: 'M5V' }),
    ).toEqual({ status: 'city', city: 'Ottawa' });
    expect(await travelHomeOf({ ...row, country: 'United States', postalCode: '98103' })).toEqual({
      status: 'city',
      city: 'Seattle',
    });
  });
});
