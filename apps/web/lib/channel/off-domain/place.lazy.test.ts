import { describe, expect, it, vi } from 'vitest';
import { placeOf } from './place';

/**
 * The two postal tables are files of their own, opened when a turn first needs one. A
 * file of its own because the count below is per module: once a table is loaded it stays
 * loaded, so the order of these tests is the test.
 */

const loaded = vi.hoisted(() => ({ ca: 0, us: 0 }));

vi.mock('./postal-cities/ca.json', async (importOriginal) => {
  loaded.ca += 1;
  return importOriginal();
});
vi.mock('./postal-cities/us.json', async (importOriginal) => {
  loaded.us += 1;
  return importOriginal();
});

const ROW = { country: null, city: null, postalCode: null, areaCoarse: null };

describe('when a postal table is opened', () => {
  it('opens neither on import, nor for a row that needs no table', async () => {
    expect(loaded).toEqual({ ca: 0, us: 0 });

    await placeOf({ ...ROW, postalCode: 'M4K 1A1' });
    await placeOf({ ...ROW, country: 'France', city: 'Lyon', postalCode: '80202' });
    await placeOf({ ...ROW, country: 'Canada' });
    await placeOf({ ...ROW, country: 'Canada', areaCoarse: 'North York' });
    await placeOf({ ...ROW, country: 'United States', areaCoarse: '802' });

    expect(loaded).toEqual({ ca: 0, us: 0 });
  });

  it("opens only the table for the row's country, once", async () => {
    expect(await placeOf({ ...ROW, country: 'Canada', postalCode: 'M4K 1A1' })).toMatchObject({
      city: 'Toronto',
    });
    await placeOf({ ...ROW, country: 'Canada', postalCode: 'V6B 1A1' });
    expect(loaded).toEqual({ ca: 1, us: 0 });

    // A stored city is checked against the table, so it opens it too.
    expect(await placeOf({ ...ROW, country: 'United States', city: 'denver' })).toMatchObject({
      city: 'Denver',
    });
    expect(loaded).toEqual({ ca: 1, us: 1 });
  });
});
